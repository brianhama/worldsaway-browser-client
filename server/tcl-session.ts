import type {NativeSession} from './session.js';
import type {NativeObject,TclContext,TclMetadata,TclExecutionOptions} from './types.js';
import {projectRoot} from '../scripts/paths.js';
import {resolve} from 'node:path';
import type {NativeFields} from './types.js';
/** WorldsAway bindings for a real, isolated Tcl interpreter. All network
 * operations still use the current NativeSession and its authoritative codec. */
import {readFile} from 'node:fs/promises';
import {TclRuntime,tclWord} from './tcl-runtime.js';
import type {WireField} from '../native/classes.js';
import {decodeClientString} from '../native/classes.js';
import {parseWireSchema,coerceActionValues} from '../public/actions.js';
import {parseTclList} from '../public/documents.js';
import {NativeLongStrings} from './tcl-strings.js';

const SCRIPT_NOTICES=new Set([119,2135,5324]);
const asInt=(value: unknown,max=65535,label='number')=>{const n=Number(value);if(value===''||!Number.isSafeInteger(n)||n<0||n>max)throw new Error(`Invalid Tcl ${label}`);return n;};
const bounded=(value: unknown,max=262144)=>{const text=String(value??'');if(text.length>max||text.includes('\0'))throw new Error('Tcl text exceeds its boundary');return text;};
const diagnosticText=(value: unknown,max=65536)=>String(value??'').replaceAll('\0','\\0').slice(0,max);
const objectFields=(object: NativeObject | undefined)=>object?.fields??{};
const roomKey=(session: NativeSession)=>`${session.state.status==='connected'?session.state.worldName:''}|${session.state.avatar??''}|${session.objects.get(0)?.fields?.name??''}|${session.objects.get(0)?.fields?.areaCode??''}`;
const typedDefault=(field: WireField | undefined)=>field?.type==='s'||field?.type==='c'&&field.count!==null?'':typeof field?.count==='number'?Array(field.count).fill(0):0;

export interface TclSessionOptions {
 Runtime?: typeof TclRuntime; requestTimeout?: number;effectTimeout?: number;executable?: string;
}
interface TclStartOptions extends TclExecutionOptions {noid?: number;cleanupSelf?: boolean;label?: string;}
interface TclMethodOptions extends TclStartOptions {skipInitialization?: boolean;}
interface TclTaskRecord {id: string;noid: number;label: string;status: string;started: number;finished?: number;result?: string;error?: string;}
interface TclWaiter {noid: number;id: number;replyId: number;after: number;resolve: (value: NativeFields)=>void;reject: (error: unknown)=>void;timer: ReturnType<typeof setTimeout> | null;requestSeq?: number;}
interface TclEffect {id: string;seq: number;name: string;args: unknown[];context: TclContext;status: string;}
interface PendingEffect {resolve: (value: unknown)=>void;reject: (error: unknown)=>void;timer: ReturnType<typeof setTimeout>;effect: TclEffect;}
interface TclModel extends NativeFields {enabled: boolean;generation: number;status: string;version: string | null;effects: TclEffect[];tasks: TclTaskRecord[];overrides: {noid: number;fields: NativeFields}[];logs: {seq: number;time: number;text: string;error: boolean}[];blockCount: number;}
/**
 * Bind world Tcl to one native session. Visual overrides and virtual objects are
 * client presentation state; network mutations still go through schema-checked actions.
 */
export class NativeTclSession{
 session: NativeSession;Runtime: typeof TclRuntime;executable?: string;requestTimeout: number;effectTimeout: number;
 runtime: TclRuntime | null;ready: Promise<TclRuntime> | null;destroyed: boolean;generation: number;counter: number;lastSeq: number;key: string;
 longStrings: NativeLongStrings;overrides: Map<number,NativeFields>;virtual: Map<number,NativeObject>;
 tasks: Map<string,TclTaskRecord>;pendingEffects: Map<string,PendingEffect>;waiters: TclWaiter[];requestQueues: Map<string,Promise<NativeFields>>;
 timers: Map<ReturnType<typeof setTimeout>,(error: unknown)=>void>;dialogContexts: Map<string,TclContext>;blocks: Map<string,number>;
 initialized: Set<string>;initializing: Map<string,Promise<void>>;model: TclModel;onPacket: ()=>void;onState: ()=>void;playerFlags?: number;
  constructor(session: NativeSession,{Runtime=TclRuntime,requestTimeout=90000,effectTimeout=30000,executable}: TclSessionOptions={}){
    this.session=session;this.Runtime=Runtime;this.executable=executable;this.requestTimeout=requestTimeout;this.effectTimeout=effectTimeout;
    this.runtime=null;this.ready=null;this.destroyed=false;this.generation=0;this.counter=0;this.lastSeq=0;this.key=roomKey(session);this.longStrings=new NativeLongStrings();
    this.overrides=new Map();this.virtual=new Map();this.tasks=new Map();this.pendingEffects=new Map();this.waiters=[];this.requestQueues=new Map();this.timers=new Map();this.dialogContexts=new Map();this.blocks=new Map();this.initialized=new Set();this.initializing=new Map();
    this.model={enabled:true,generation:0,status:'idle',version:null,effects:[],tasks:[],overrides:[],logs:[],blockCount:0};session.state.tcl=this.model;
    this.onPacket=()=>this.ingest();this.onState=()=>this.observeConnection();
    session.on('packet',this.onPacket);session.on('state',this.onState);
  }
  publish(){
    this.model.overrides=[...this.overrides].map(([noid,fields])=>({noid,fields}));
    this.model.virtualObjects=[...this.virtual.values()];const tasks=[...this.tasks.values()];this.model.tasks=[...tasks.filter(task=>task.status==='running'),...tasks.filter(task=>task.status!=='running').slice(-64)];
    this.model.blockCount=[...this.blocks.values()].reduce((sum,value)=>sum+value,0);this.session.state.tcl=this.model;this.session.publish();
  }
  log(text: unknown,error=false){this.model.logs.push({seq:++this.counter,time:Date.now(),text:diagnosticText(text),error});if(this.model.logs.length>100)this.model.logs.shift();this.publish();}
  object(noid: number | string){noid=asInt(noid);const base=this.virtual.get(noid)??this.session.objects.get(noid);if(!base)throw new Error(`Native object ${noid} is unavailable`);return {...base,fields:{...base.fields,...this.overrides.get(noid)}};}
  objects(){return [...this.session.objects.keys(),...this.virtual.keys()].map(id=>this.object(id));}
  globals(){const state=this.session.state;return {PlayerActor:state.actorNoid??15,PlayerFlags:this.playerFlags??0,PlayerPermLevel:state.permissions?.level??0,PlayerPermFlags:state.permissions?.flags??0,IgnoreScope:0,EnableFadeOuts:0,EnableFrameSkip:0,ClientArch:2,ClientVer:325,ClientDebug:0,'$TclDebugOn':0,Name:state.avatar??''};}
  /** Lazily load the trusted bindings, then the cached bootstrap libraries. */
  async ensureReady(){
    if(this.destroyed)throw new Error('The Tcl world context has ended');if(this.runtime?.closed){this.ready=null;this.runtime=null;}if(this.ready)return this.ready;
    this.model.status='starting';this.publish();
    this.ready=(async()=>{
      this.runtime=new this.Runtime({executable:this.executable,onCommand:(command,args,context,metadata)=>this.dispatch(command,args,context,metadata),onOutput:text=>this.log(text),wallTimeoutMs:120000,commandLimit:250000,timeLimitMs:250});
      const bindings=await readFile(resolve(projectRoot,'server/tcl-bindings.tcl'),'utf8');
      await this.runtime.define(bindings);
      const boot=this.source(0x50001),dialogs=this.source(0x50002);
      await this.runtime.execute(`${boot}\n${dialogs}`,{context:{bootstrap:true},globals:this.globals()});
      this.model.status='ready';this.model.version=await this.runtime.execute('info patchlevel');this.publish();return this.runtime;
    })().catch(error=>{this.model.status='error';this.model.error=error.message;this.log(error.message,true);this.ready=null;this.runtime?.destroy();this.runtime=null;throw error;});
    return this.ready;
  }
  source(id: number | string){
    id=asInt(id,0xffffffff,'resource');const method=this.session.registry.methods.get(id);if(method)return method.source;
    const entry=this.session.getResource(id)??this.session.resources.getResource(id);if(!entry)throw new Error(`Tcl resource ${id.toString(16)} is unavailable`);
    if((id>>>16)!==12)throw new Error('The requested resource is not Tcl source');
    const zero=entry.data.indexOf(0);return decodeClientString(entry.data.subarray(0,zero<0?entry.data.length:zero));
  }
  /** Capture a world generation so asynchronous startup cannot enter a later scene. */
  async start(script: string,{noid=0,context={},globals={},cleanupSelf=false,label='Tcl script',background=false,wallTimeoutMs=120000}: TclStartOptions={}){
    bounded(script);noid=asInt(noid);const generation=this.generation;await this.ensureReady();if(generation!==this.generation||this.destroyed)throw new Error('The Tcl world changed while the interpreter was starting');
    const promise=this.runtime!.execute(`try ${tclWord(script)} finally {::wa::native::releaseThread}`,{globals:{...this.globals(),...globals},context:{...context,self:noid,worldGeneration:generation},background,wallTimeoutMs});
    const id=promise.taskId??`script-${++this.counter}`,record: TclTaskRecord={id,noid,label,status:'running',started:Date.now()};this.tasks.set(id,record);if(this.tasks.size>128)for(const [key,item]of this.tasks){if(this.tasks.size<=128)break;if(item.status!=='running')this.tasks.delete(key);}this.publish();
    promise.then(result=>{record.status='complete';record.result=diagnosticText(result,4096);},error=>{record.status=error.silent||error.name==='TclCancelledError'?'cancelled':'error';record.error=diagnosticText(error.message,4096);this.log(`${label}: ${error.message}`,true);}).finally(()=>{
      record.finished=Date.now();this.blocks.delete(String(id));if(cleanupSelf&&generation===this.generation)this.overrides.delete(noid);this.publish();
    }).catch(error=>{this.log(`Tcl task reporting failed: ${diagnosticText(error.message,4096)}`,true);});
    return {taskId:id,promise};
  }
  async run(script: string,{noid=this.session.state.actorNoid??0,label='Tcl script'}: {noid?: number;label?: string}={}){
    const input=`__wa_script_${++this.counter}`;
    const body=`apply {{} {set self ${asInt(noid)}; set target $self; set obj $self; global PlayerActor; set actor $PlayerActor; set context context_[thread_id]; global $context; set [set context](this) $self; set [set context](CurX) 0; set [set context](CurY) 0; global ${input}; try {eval [set ${input}]} finally {unset -nocomplain ${input} $context}}}`;
    return this.start(body,{noid,label,globals:{[input]:bounded(script)}});
  }
  async method(noid: number | string,messageId: number | string,fields: NativeFields={},options: TclMethodOptions={}){
    const generation=this.generation;noid=asInt(noid);messageId=asInt(messageId);const object=this.object(noid);
    if(messageId!==52&&!options.skipInitialization)await this.initializeObject(noid,options.context??{});
    if(generation!==this.generation||this.destroyed)throw new Error('The native method belongs to a world context that ended');
    const method=this.session.registry.methodContract(object.classNumber,messageId)??(messageId===119?this.session.registry.methodContract(20,119):null);
    if(!method)throw new Error(`No native Tcl method ${messageId} for class ${object.classNumber}`);
    const input=`__wa_message_${++this.counter}`;
    return this.start(`try {executeMethod 0 0 ${noid} [set ::${input}] ${method.resourceId} ${messageId}} finally {unset -nocomplain ::${input}}`,{...options,noid,label:options.label??`Method ${messageId}`,globals:{[input]:fields}});
  }
  /** Run method 52 once per generation/object/class and share concurrent initialization. */
  async initializeObject(noid: number | string,context: TclContext={}){
    const object=this.object(noid),key=`${this.generation}:${noid}:${object.classNumber}`,chain=context.initializingNoids??[];
    if(this.initialized.has(key)||chain.includes(Number(noid)))return;
    if(this.initializing.has(key))return this.initializing.get(key);
    if(!this.session.registry.methodContract(object.classNumber,52)){this.initialized.add(key);return;}
    const generation=this.generation;
    const pending=(async()=>{
      // Advertisement rotation already belongs to BannerPresentations. Mark its
      // native initialized flag before52 so a second rotation thread is not born.
      if(object.classNumber===61)this.setField(noid,'initialized',1234);
      const task=await this.method(noid,52,{}, {skipInitialization:true,context:{...context,initializingNoids:[...chain,Number(noid)]},label:`Initialize object ${noid}`});
      await task.promise;if(generation!==this.generation)throw new Error('The native object changed while initializing');this.initialized.add(key);
    })();
    this.initializing.set(key,pending);try{return await pending;}finally{if(this.initializing.get(key)===pending)this.initializing.delete(key);}
  }
  async presentation(noid: number | string,which: number | string,ad: NativeFields={}){
    const object=this.object(noid);if(object.classNumber!==61)throw new Error('This object is not a Banner');
    const f={...object.fields,...Object.fromEntries(['imageURL','choreState','colorMap'].filter(key=>ad?.[key]!==undefined).map(key=>[key,ad[key]]))};return this.method(noid,5625,{which:asInt(which),imageURL:f.imageURL??'',choreState:f.choreState??0,colorMap:f.colorMap??Array(16).fill(0)},{cleanupSelf:true,label:'Banner presentation',wallTimeoutMs:86400000});
  }
  observeConnection(){
    if(this.destroyed)return;const next=roomKey(this.session);
    if(next!==this.key){this.key=next;this.reset('The world, region or avatar changed');}
  }
  ingest(){
    if(this.destroyed)return;this.observeConnection();
    for(const event of this.session.state.history){
      if(event.seq<=this.lastSeq)continue;this.lastSeq=event.seq;
      if(event.type!=='message')continue;
      if(event.id===101)this.playerFlags=event.fields.actor_flags;
      const waiter=this.waiters.find(waiter=>event.seq>waiter.after&&event.id===waiter.replyId&&(event.noid===waiter.noid||event.id===70&&event.noid===0&&event.requestNoid===waiter.noid)&&(event.requestId===undefined||event.requestId===waiter.id)&&(event.requestSeq===undefined||event.requestSeq===waiter.requestSeq));
      if(waiter){this.waiters.splice(this.waiters.indexOf(waiter),1);clearTimeout(waiter.timer ?? undefined);waiter.resolve({...event.fields});}
      if(SCRIPT_NOTICES.has(event.id))this.method(event.noid,event.id,event.fields,{label:`Server Tcl ${event.id}`}).catch(error=>this.log(error.message,true));
    }
  }
  /**
   * Serialize requests sharing a reply channel. Standard reply 70 can arrive on
   * NOID 0 for any receiver, so it needs a session-wide queue rather than one per object.
   */
  request(noid: number | string,id: number | string,replyId: number | string,pairs: string[],{signal}: TclMetadata={}){
    noid=asInt(noid);id=asInt(id);replyId=asInt(replyId);const fields=this.parameters(id,pairs),key=`${replyId}:${replyId===70?0:noid}`;
    const previous=this.requestQueues.get(key)??Promise.resolve(),generation=this.generation;
    const result=previous.catch(()=>{}).then(()=>new Promise<NativeFields>((resolve,reject)=>{
      if(this.destroyed||signal?.aborted||generation!==this.generation||this.session.state.status!=='connected'){reject(new Error('The native world is disconnected, changed or this task was cancelled'));return;}
      const waiter: TclWaiter={noid,id,replyId,after:this.session.sequence,resolve,reject,timer:null};waiter.timer=setTimeout(()=>{this.waiters=this.waiters.filter(item=>item!==waiter);reject(new Error(`Native Tcl request ${id} timed out`));},this.requestTimeout);this.waiters.push(waiter);
      try{waiter.requestSeq=this.session.action({noid,id,fields}).seq;}catch(error: any){clearTimeout(waiter.timer ?? undefined);this.waiters=this.waiters.filter(item=>item!==waiter);reject(error);}
    }));
    this.requestQueues.set(key,result);result.finally(()=>{if(this.requestQueues.get(key)===result)this.requestQueues.delete(key);}).catch(()=>{});return result;
  }
  parameters(id: number,pairs: string[]){
    if(pairs.length%2)throw new Error('Native parameters need field/value pairs');const raw: NativeFields={};for(let i=0;i<pairs.length;i+=2)raw[pairs[i]]=this.longStrings.resolve(pairs[i+1]);
    const schema=this.session.registry.getMessage(id)?.schema;if(!schema)throw new Error(`Message ${id} has no recovered schema`);
    const fields=parseWireSchema(schema);for(const field of fields)if(field.count!==null&&!['s','c'].includes(field.type)&&typeof raw[field.name]==='string')raw[field.name]=parseTclList(raw[field.name]).map(Number);
    return coerceActionValues({fields},raw);
  }
  getField(noid: number | string,name: string){
    const object=this.object(noid),f=object.fields;
    if(name==='classNumber')return object.classNumber;
    if(name==='noid')return Number(object.noid);
    const match=/^([^()]+)\((\d+)\)$/.exec(name);
    if(name==='contents'||match?.[1]==='contents'){
      const definition=this.session.registry.get(object.classNumber),capacity=Number(f.reducedCapacity??definition?.capacity??0),contents=Array(Math.max(0,Math.min(capacity,1024))).fill(65535);
      for(const child of this.objects())if(Number(child.fields.container_noid)===Number(noid)&&Number(child.noid)!==Number(noid)){const slot=Number(child.fields.position?.[0]);if(Number.isInteger(slot)&&slot>=0&&slot<1024)contents[slot]=Number(child.noid);}
      return match?contents[Number(match[2])]??65535:contents;
    }
    if(match)return f[match[1]]?.[Number(match[2])]??f[name]??0;
    if(Object.hasOwn(f,name))return f[name];
    const definition=this.session.registry.get(object.classNumber),field=definition?.fields.find((field: NativeFields)=>field.name===name);
    if(name==='reducedCapacity'||name==='capacity')return definition?.capacity??0;
    return typedDefault(field);
  }
  /** Apply bounded presentation overlays without rewriting authoritative session objects. */
  setField(noid: number | string,name: string,value: unknown){
    noid=asInt(noid);name=bounded(name,128);const object=this.object(noid),definition=this.session.registry.get(object.classNumber);
    if(!/^[A-Za-z_][\w]*(?:\(\d+\))?$/.test(name)||['noid','classNumber','__proto__','constructor','prototype'].includes(name.split('(')[0]))throw new Error('Native object identity or prototype is immutable through @obj');
    if(!this.overrides.has(noid)&&this.overrides.size>=1024)throw new Error('Too many native Tcl object overlays');
    const fields={...this.overrides.get(noid)},match=/^([^()]+)\((\d+)\)$/.exec(name),base=match?.[1]??name,field=definition?.fields.find((field: NativeFields)=>field.name===base);
    if(!Object.hasOwn(fields,base)&&Object.keys(fields).length>=256)throw new Error('Too many native Tcl fields on one object');
    if(match){const index=asInt(match[2],base==='position'?2:base==='colorMap'?15:1023,'array index'),array=[...(object.fields[base]??[])];array[index]=Number.isFinite(Number(value))?Number(value):value;fields[base]=array;}
    else if(['position','colorMap'].includes(name)||field?.count!==null&&field?.count!==undefined&&!['s','c'].includes(field.type))fields[name]=(Array.isArray(value)?value:parseTclList(value)).map(Number);
    else if(field&&!['s','c'].includes(field.type)||['graphicState','choreState','orientation','mood','presActive','common_flags'].includes(name))fields[name]=Number(value);
    else fields[name]=value;
    if(base==='position'&&(fields.position.length!==3||fields.position.some((n: number)=>!Number.isInteger(n)||n< -32768||n>32767)))throw new Error('Invalid native object position');
    if(base==='colorMap'&&(fields.colorMap.length!==16||fields.colorMap.some((n: number)=>!Number.isInteger(n)||n<0||n>255)))throw new Error('Invalid native object color map');
    if(field?.count===null&&!['s','c'].includes(field.type)&&(!Number.isFinite(fields[base])||!Number.isInteger(fields[base])||fields[base]<field.min||fields[base]>field.max))throw new Error('The native object value is outside its field range');
    if(name==='graphicState')fields.tclGraphicState=Number(value);
    this.overrides.set(noid,fields);this.publish();return value;
  }
  /** Publish a browser operation and suspend Tcl until its result, timeout, or cancellation. */
  effect(name: string,args: unknown[],context: TclContext,{signal}: TclMetadata={}){
    if(this.pendingEffects.size>=128)throw new Error('Too many unanswered Tcl browser operations');const id=`effect-${++this.counter}`;
    const effect: TclEffect={id,seq:this.counter,name,args,context:{self:context?.self??0,taskId:context?.taskId??null},status:'pending'};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pendingEffects.delete(id);effect.status='expired';reject(new Error(`Browser Tcl operation ${name} timed out`));this.publish();},this.effectTimeout);
      this.pendingEffects.set(id,{resolve,reject,timer,effect});this.model.effects.push(effect);if(this.model.effects.length>256)this.model.effects.shift();this.publish();
      const cancel=()=>{if(!this.pendingEffects.has(id))return;this.pendingEffects.delete(id);clearTimeout(timer);effect.status='cancelled';reject(new Error(`Tcl browser operation ${name} was cancelled`));this.publish();};if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    });
  }
  replyEffect(id: string,{value='',error,overrides=[]}: NativeFields={}){
    const item=this.pendingEffects.get(id);if(!item)return false;this.pendingEffects.delete(id);clearTimeout(item.timer ?? undefined);item.effect.status='complete';
    // Reject an entire malformed visual reply instead of retaining the prefix
    // of updates applied before validation encountered an invalid field.
    const previous=new Map(this.overrides);
    try{
      if(!error){if(!Array.isArray(overrides)||overrides.length>1024)throw new Error('Invalid native visual update count');for(const entry of overrides){if(!this.session.objects.has(Number(entry.noid))&&!this.virtual.has(Number(entry.noid)))continue;const fields=Object.entries(entry.fields??{});if(fields.length>256)throw new Error('Too many fields in a native visual update');for(const [key,val]of fields)this.setField(entry.noid,key,val);}}
      if(error)throw new Error(String(error).slice(0,4096));
      if(item.effect.name==='dialogCreate'&&value)this.dialogContexts.set(String(value),item.effect.context);
      item.resolve(value);
    }catch(failure: any){this.overrides=previous;item.effect.status='error';item.reject(failure);}
    this.publish();return true;
  }
  async callback({dialogId,script,command}: NativeFields){
    const context=this.dialogContexts.get(String(dialogId));if(!context)throw new Error('The native Tcl dialog has ended');
    if(command){const task=await this.method(command.noid,command.id,command.fields??{},{context,label:'Dialog command'});return {taskId:task.taskId};}
    const task=await this.run(bounded(script),{noid:context.self,label:'Dialog callback'});return {taskId:task.taskId};
  }
  /** Explicit host boundary: local data operations, native requests, or browser effects. */
  async dispatch(command: string,args: string[]=[],context: TclContext={},metadata: TclMetadata={}): Promise<unknown>{
    if(this.destroyed||context.worldGeneration!==undefined&&context.worldGeneration!==this.generation)throw new Error('The Tcl world context ended');
    switch(command){
      case 'resource':if(args[0]==='get'){const id=asInt(args[1],0xffffffff,'resource');if((id>>>16)===6){const entry=this.session.getResource(id)??this.session.resources.getResource(id);if(!entry)throw new Error('The native text resource is unavailable');const zero=entry.data.indexOf(0);return decodeClientString(entry.data.subarray(0,zero<0?entry.data.length:zero));}return this.source(id);}throw new Error('Only cached native text/resource reads are supported');
      case 'load-method':case 'execute':return this.source(args[0]);
      case 'method-handle':return this.session.registry.methodContract(this.object(args[0]).classNumber,Number(args[1]))?.resourceId??0;
      case '@obj':if(this.object(args[0]).classNumber===37&&/^(?:doc|index)(?:_author|_subject)?_lstring$/.test(args[1]))await this.initializeObject(Number(args[0]),context);return args.length===2?this.getField(args[0],args[1]):this.setField(args[0],args[1],args[2]);
      case '@class':{const id=Number(args[0]),number=this.session.objects.has(id)||this.virtual.has(id)?this.object(id).classNumber:id,definition=this.session.registry.get(number);if(!definition)throw new Error('Unknown native class');return definition[args[1]]??typedDefault(definition.fields.find((field: NativeFields)=>field.name===args[1]));}
      case 'request':return this.request(args[0],args[1],args[2],args.slice(3),metadata);
      case 'message':return {noid:asInt(args[0]),id:asInt(args[1]),fields:Object.fromEntries(Array.from({length:Math.floor((args.length-2)/2)},(_,i)=>[args[2+i*2],args[3+i*2]]))};
      case 'notice':this.session.action({noid:asInt(args[0]),id:asInt(args[1]),fields:this.parameters(Number(args[1]),args.slice(2))});return '';
      case 'command':case 'queue-msg':{const fields=Object.fromEntries(Array.from({length:Math.floor((args.length-2)/2)},(_,i)=>[args[2+i*2],args[3+i*2]]));const task=await this.method(args[0],args[1],fields,{context,label:`Local command ${args[1]}`});if(command==='queue-msg')return task.taskId;return task.promise;}
      case 'thread':{const task=await this.start(bounded(args[0]),{context,noid:context.self??0,label:'Tcl thread',background:true});return task.taskId;}
      case 'kill':this.runtime?.cancel(args[0]??context.taskId);return '';
      case 'block':{const id=String(context.taskId??'native');this.blocks.set(id,(this.blocks.get(id)??0)+1);this.publish();return '';}
      case 'unblock':{const id=String(context.taskId??'native');this.blocks.set(id,Math.max(0,(this.blocks.get(id)??0)-1));this.publish();return '';}
      case 'blockstat':return `blockCount is ${this.model.blockCount}`;
      case 'delay':{const ms=asInt(args[0],3600000,'delay'),generation=this.generation;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.timers.delete(timer);generation===this.generation?resolve(''):reject(new Error('Tcl delay cancelled'));},ms);this.timers.set(timer,reject);const cancel=()=>{clearTimeout(timer);this.timers.delete(timer);reject(new Error('Tcl delay cancelled'));};if(metadata.signal?.aborted)cancel();else metadata.signal?.addEventListener('abort',cancel,{once:true});});}
      case 'puts':case 'log':this.log(args.at(-1)??'');return '';
      case 'debug':case 'funkey':case 'systemtask':case 'free-message':case 'probe':case 'dump':case 'hexdump':case 'dumplist':case 'celstats':case 'forget':return '';
      case 'isNumber':return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(args[0]))?1:0;
      case 'timestamp':return Math.floor(Date.now()/1000);
      case 'noids':return this.objects().map(object=>object.noid);
      case 'noidFields':return Object.keys(this.object(args[0]).fields);
      case 'getDepth':return Math.trunc(Number(args[1])*512/(Number(args[0])||70));
      case 'GetAvatarContainer':case 'GetOuterContainer':{let object=this.object(args[0]),seen=new Set();while(Number(object.fields.container_noid)!==0){if(seen.has(object.noid))throw new Error('Native containment cycle');seen.add(object.noid);object=this.object(object.fields.container_noid);}return object.noid;}
      case 'unpackContents':return '';// NativeSession already decoded and applied the exact vector.
      case 'lstring':return this.longStrings.dispatch(args,context);
      case '_':return args[0]??'';
      case 'getVirtualObject':{const requested=asInt(args[0]),classNumber=asInt(args[1]);let id=requested||60000;if(requested&&(this.session.objects.has(id)||this.virtual.has(id)))throw new Error('The requested virtual object number is in use');while(this.session.objects.has(id)||this.virtual.has(id))id++;if(id>65535||this.virtual.size>=1024)throw new Error('Too many virtual native objects');if(!this.session.registry.get(classNumber))throw new Error('Unknown virtual native class');const object={noid:id,classNumber,fields:{...this.session.registry.defaults(classNumber),noid:id,classNumber,container_noid:0,name:`Virtual ${this.session.registry.get(classNumber)!.name}`,position:[-500,0,0]}};this.virtual.set(id,object);this.publish();return id;}
      case 'destroyAllVirtualObjects':for(const id of this.virtual.keys())this.overrides.delete(id);this.virtual.clear();this.publish();return '';
      case 'destroy':{const id=asInt(args[0]);this.overrides.set(id,{...this.overrides.get(id),common_flags:Number(this.getField(id,'common_flags'))|1});this.virtual.delete(id);this.publish();return '';}
      case 'openFile':case 'loadFile':case 'loadFileDialog':case 'saveFileDialog':throw new Error('Native filesystem commands require a browser file chooser; filesystem access is unavailable to world Tcl');
      case 'waitBits':return this.effect(command,args.length===3&&Number(args[2])===0?args.slice(0,2):args,context,metadata);
      default:return this.effect(command,args.map(value=>this.longStrings.resolve(value)),context,metadata);
    }
  }
  cancel(taskId?: string){if(taskId){const task=this.tasks.get(taskId);if(task)task.status='cancelled';this.runtime?.cancel(taskId);this.publish();}else this.reset('Tcl execution cancelled');}
  /** Invalidate old continuations before releasing their world-scoped state. */
  reset(reason: string){
    this.generation++;this.model.generation=this.generation;this.runtime?.cancelAll(reason);for(const item of this.waiters){clearTimeout(item.timer ?? undefined);item.reject(new Error(reason));}this.waiters=[];
    for(const item of this.pendingEffects.values()){clearTimeout(item.timer ?? undefined);item.reject(new Error(reason));}this.pendingEffects.clear();
    for(const [timer,reject]of this.timers){clearTimeout(timer);reject(new Error(reason));}this.timers.clear();
    this.model.effects=[];this.overrides.clear();this.virtual.clear();this.longStrings.clear();this.dialogContexts.clear();this.blocks.clear();this.initialized.clear();this.initializing.clear();this.publish();
  }
  destroy(){if(this.destroyed)return;this.reset('The native Tcl session closed');this.destroyed=true;this.runtime?.destroy();this.session.off('packet',this.onPacket);this.session.off('state',this.onState);}
}
