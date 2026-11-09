/** Real Tcl 8.6 safe-child runtime with concurrent coroutine host RPC. */
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {TclRuntimeOptions,TclContext,TclExecutionOptions,TclPromise,TclTask,NativeFields} from './types.js';
import {projectRoot} from '../scripts/paths.js';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TCL_EXECUTABLE} from '../scripts/setup-tcl.js';

const here=resolve(projectRoot,'server');
// Each IPC word is UTF-8 hex (or '-' for empty). Newlines, spaces, and Tcl
// substitutions in script data therefore cannot create extra protocol records.
const hex=(value: unknown)=>{const bytes=Buffer.from(String(value),'utf8');return bytes.length?bytes.toString('hex'):'-';};
const unhex=(value: string)=>{if(value==='-')return '';if(!/^(?:[a-f0-9]{2})*$/.test(value??''))throw new Error('Malformed Tcl worker value');return Buffer.from(value,'hex').toString('utf8');};
/** Encode one Tcl word so user text cannot trigger variable or command substitution. */
export function tclWord(value: unknown): string{return '"'+String(value).replace(/[\\"$\[\]\x00-\x1f\x7f]/g,char=>(({'\\':'\\\\','"':'\\"','$':'\\$','[':'\\[',']':'\\]','\n':'\\n','\r':'\\r','\t':'\\t'} as Record<string,string>)[char]??`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`))+'"';}
export function tclList(values: readonly unknown[]): string{return values.map(value=>tclWord(tclValue(value))).join(' ');}
export function tclValue(value: unknown): string{
 if(value===null||value===undefined)return '';
 if(typeof value==='string')return value;
 if(typeof value==='boolean')return value?'1':'0';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('Tcl numeric values must be finite');return String(value);}
 if(typeof value==='bigint')return value.toString();
 if(Buffer.isBuffer(value)||value instanceof Uint8Array)return tclList([...value]);
 if(Array.isArray(value))return tclList(value);
 if(typeof value==='object')return tclList(Object.entries(value).flatMap(([key,item])=>[key,item]));
 throw new TypeError('Unsupported Tcl host value');
}
export class TclError extends Error{taskId?: string; errorInfo?: string; constructor(message: string,{taskId,errorInfo}: {taskId?: string;errorInfo?: string}={}){super(message);this.name='TclError';this.taskId=taskId;this.errorInfo=errorInfo;}}
export class TclCancelledError extends TclError{silent: boolean; constructor(message='The Tcl task was cancelled.',options?: {taskId?: string;errorInfo?: string}){super(message,options);this.name='TclCancelledError';this.silent=true;}}

/**
 * Multiplex coroutine tasks over one safe-interpreter worker. Host calls yield
 * instead of blocking the worker, so another task may run while a reply is pending.
 */
export class TclRuntime extends EventEmitter{
 onCommand: NonNullable<TclRuntimeOptions['onCommand']>;
 onOutput: TclRuntimeOptions['onOutput'];
 options: Required<Omit<TclRuntimeOptions,'onCommand' | 'onOutput' | 'executable'>>;
 tasks: Map<string,TclTask>; timers: Map<string,TclContext>; waits: Map<string,()=>void>;
 barriers: Map<string,()=>void>; cancellations: Map<string,ReturnType<typeof setTimeout>>;
 counter: number; barrierCounter: number; buffer: string; closed: boolean; version: string | null;
 ready: Promise<TclRuntime>; readyResolve!: (runtime: TclRuntime)=>void; readyReject!: (error: unknown)=>void;
 child: ChildProcessWithoutNullStreams; startTimer: ReturnType<typeof setTimeout>;
 constructor({onCommand=async command=>{throw new TclError(`Unsupported native command: ${command}`);},onOutput,
  executable=TCL_EXECUTABLE,commandLimit=100000,timeLimitMs=1000,wallTimeoutMs=30000,backgroundHostCallLimit=250000,maxOutputBytes=1048576,maxScriptBytes=1048576,maxTasks=256}: TclRuntimeOptions={}){
  super();for(const [name,value]of Object.entries({commandLimit,timeLimitMs,wallTimeoutMs,backgroundHostCallLimit,maxOutputBytes,maxScriptBytes,maxTasks}))if(!Number.isSafeInteger(value)||value<1)throw new TypeError(`Invalid Tcl ${name}`);
  if(wallTimeoutMs>2147483647)throw new TypeError('Invalid Tcl wallTimeoutMs');
  this.onCommand=onCommand;this.onOutput=onOutput;this.options={commandLimit,timeLimitMs,wallTimeoutMs,backgroundHostCallLimit,maxOutputBytes,maxScriptBytes,maxTasks};
  this.tasks=new Map();this.timers=new Map();this.waits=new Map();this.barriers=new Map();this.cancellations=new Map();this.counter=0;this.barrierCounter=0;this.buffer='';this.closed=false;this.version=null;
  this.ready=new Promise<TclRuntime>((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});this.ready.catch(()=>{});
  // No account, password, native token, user HOME or inherited environment is
  // supplied to the interpreter process. Safe code has no env variable either.
  this.child=spawn(executable,[resolve(here,'tcl-worker.tcl'),String(commandLimit),String(timeLimitMs),String(Math.max(maxOutputBytes,maxScriptBytes)*2+65536)],{cwd:here,env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
  this.child.stdin.on('error',error=>this.fail(new TclError(`Tcl worker input failed: ${error.message}`)));
  this.startTimer=setTimeout(()=>this.fail(new TclError('Tcl worker did not start. Run npm run tcl:setup.')),10000);this.startTimer.unref?.();
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>this.receive(chunk));
  this.child.stderr.on('data',chunk=>{if(chunk.length>maxOutputBytes)this.fail(new TclError('Tcl worker stderr exceeds its bound.'));else this.emit('diagnostic',String(chunk).slice(0,2048));});
  this.child.on('error',error=>this.fail(new TclError(`Cannot start Tcl 8.6+ runtime: ${error.message}. Run npm run tcl:setup.`)));
  this.child.on('exit',(code,signal)=>{if(!this.closed)this.fail(new TclError(`Tcl worker exited (${signal??code}).`));});
 }
 send(words: string[]){if(this.closed)throw new TclCancelledError('The Tcl runtime is closed.');this.child.stdin.write(words.join(' ')+'\n');}
 receive(chunk: string){
  if(this.closed)return;this.buffer+=chunk;
  if(Buffer.byteLength(this.buffer)>this.options.maxOutputBytes*2+65536){this.fail(new TclError('Tcl worker output exceeds its bound.'));return;}
  let end;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);try{this.message(line.split(' '));}catch(error: any){this.fail(error instanceof TclError?error:new TclError(error.message));return;}}
 }
 message(words: string[]){
  const [type,id,...rest]=words;
  if(type==='ready'){clearTimeout(this.startTimer);this.version=unhex(id);this.readyResolve(this);return;}
  if(type==='fatal')throw new TclError(unhex(id));
  if(type==='barrier'){this.barriers.get(id)?.();this.barriers.delete(id);return;}
  if(type==='cancelled'){clearTimeout(this.cancellations.get(id));this.cancellations.delete(id);return;}
  if(type==='variable'){this.waits.get(id)?.();this.waits.delete(id);return;}
  if(type==='timer'){const owner=this.tasks.get(id);if(owner)this.timers.set(rest[0],owner.context);return;}
  if(type==='timer-cancel'){this.timers.delete(id);return;}
  if(type==='callback'){
   const context=this.timers.get(id);this.timers.delete(id);if(!context)return;
   this.execute(unhex(rest[0]),{context}).catch(error=>this.emit('scriptError',error));return;
  }
  const task=this.tasks.get(id);if(!task)return;
  task.outputBytes+=Buffer.byteLength(words.join(' '));if(task.outputBytes>this.options.maxOutputBytes*2){this.cancel(id,'The Tcl task exceeded its output budget.');return;}
  if(type==='print'){const [channel,newline,value]=rest,text=unhex(value)+(newline==='1'?'\n':'');this.onOutput?.(text,{channel,context:task.context,taskId:id});this.emit('output',{text,channel,context:task.context,taskId:id});return;}
  if(type==='done'){
   const [status,value,errorInfo]=rest;
   if(status==='ok')this.finish(task,null,unhex(value));else this.finish(task,new TclError(unhex(value),{taskId:id,errorInfo:unhex(errorInfo)}));return;
  }
  // Only the worker's acknowledged pending host call pauses a background
  // task's wall clock; arbitrary Tcl yield values cannot disable its watchdog.
  if(type==='yielded'){if(task.background&&task.pendingCall===rest[0]){clearTimeout(task.timer ?? undefined);task.timer=null;}return;}
  if(type!=='call')throw new TclError(`Unknown Tcl worker message: ${type}`);
  const [call,encodedCommand,...encodedArgs]=rest,command=unhex(encodedCommand),args=encodedArgs.map(unhex);
  task.pendingCall=call;
  if(task.calls++>=task.hostCallLimit){this.cancel(id,'The Tcl task exceeded its host-call budget.');return;}
  const metadata={taskId:id,signal:task.abort.signal};
  // Install a vwait continuation before processing later IPC lines: another
  // runnable coroutine can write its variable in the same stdout chunk.
  const variableWait=command==='::tcl::vwait'?new Promise((resolve,reject)=>{const abort=()=>{this.waits.delete(call);reject(new TclCancelledError());};this.waits.set(call,()=>{task.abort.signal.removeEventListener('abort',abort);resolve('');});task.abort.signal.addEventListener('abort',abort,{once:true});}):null;
  Promise.resolve().then(async()=>{
   if(task.abort.signal.aborted)throw new TclCancelledError();
   if(command==='::tcl::sleep'){
    const ms=Number(args[0]);if(args.length!==1||!Number.isSafeInteger(ms)||ms<0||ms>2147483647)throw new TclError('Invalid Tcl after delay');
    await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new TclCancelledError());};const timer=setTimeout(()=>{task.abort.signal.removeEventListener('abort',abort);resolve();},ms);task.abort.signal.addEventListener('abort',abort,{once:true});});return '';
   }
   if(command==='::tcl::vwait')return variableWait;
   if(command==='::tcl::update'){
    await new Promise(resolve=>setTimeout(resolve,0));await this.barrier();return '';
   }
   return this.onCommand(command,args,task.context,metadata);
  }).then(value=>{const text=tclValue(value);if(Buffer.byteLength(text)>this.options.maxOutputBytes)throw new TclError('The host result exceeds the Tcl value budget.');return text;}).then(value=>this.resume(task,call,'ok',value),error=>this.resume(task,call,'error',String(error?.message??error).slice(0,4096))).catch(error=>this.fail(new TclError(error.message)));
 }
 armWall(task: TclTask){clearTimeout(task.timer ?? undefined);task.timer=setTimeout(()=>{if(this.tasks.get(task.id)===task)this.cancel(task.id,'The Tcl task exceeded its wall-time budget.');},task.wallTimeoutMs);task.timer.unref?.();}
 // A host promise may settle after cancellation; resume only the exact task
 // record that is still registered, never a removed or replacement coroutine.
 resume(task: TclTask,call: string,status: string,value: string){if(this.tasks.get(task.id)!==task||task.abort.signal.aborted)return;task.pendingCall=null;if(task.background){task.outputBytes=0;this.armWall(task);}this.send(['resume',task.id,call,status,hex(value)]);}
 /** Resolve after the worker processes preceding IPC, as required by Tcl update. */
 barrier(){if(this.closed)return Promise.reject(new TclCancelledError());const id=`b${++this.barrierCounter}`;return new Promise<void>(resolve=>{this.barriers.set(id,resolve);this.send(['barrier',id]);});}
 /** Schedule source with data globals; the returned promise exposes its cancellation ID. */
 execute(script: string,{globals={},context={},background=false,wallTimeoutMs=this.options.wallTimeoutMs}: TclExecutionOptions={}) : TclPromise{
  const id=`t${++this.counter}`;
  const promise=new Promise<string>((resolve,reject)=>{
   if(this.closed){reject(new TclCancelledError('The Tcl runtime is closed.'));return;}
   if(!Number.isSafeInteger(wallTimeoutMs)||wallTimeoutMs<1||wallTimeoutMs>2147483647||typeof background!=='boolean'){reject(new TclError('Invalid Tcl task execution budget.'));return;}
   if(typeof script!=='string'||Buffer.byteLength(script)>this.options.maxScriptBytes){reject(new TclError('Tcl source exceeds its byte limit.'));return;}
   if(this.tasks.size>=this.options.maxTasks){reject(new TclError('Too many concurrent Tcl tasks.'));return;}
   const task: TclTask={id,resolve,reject,context:{...context,taskId:id},abort:new AbortController(),outputBytes:0,calls:0,timer:null,background,wallTimeoutMs,hostCallLimit:background?this.options.backgroundHostCallLimit:this.options.commandLimit};
   this.tasks.set(id,task);this.armWall(task);
   this.ready.then(()=>{
    if(this.tasks.get(id)!==task)return;
    const pairs=Object.entries(globals).flatMap(([name,value])=>[hex(name),hex(tclValue(value))]);
    this.send(['run',id,background?'background':'foreground',hex(script),...pairs]);
   }).catch(error=>{if(this.tasks.get(id)===task)this.finish(task,error);});
  });
  Object.defineProperty(promise,'taskId',{value:id,enumerable:true});return promise as TclPromise;
 }
 sourceTrusted(script: string,options: TclExecutionOptions={}){return this.execute(script,options);}
 define(script: string,options: TclExecutionOptions={}){return this.sourceTrusted(script,options);}
 finish(task: TclTask,error: unknown,value = ''){clearTimeout(task.timer ?? undefined);this.tasks.delete(task.id);task.abort.abort();if(error)task.reject(error);else task.resolve(value);}
 cancel(taskOrFilter?: string | {taskId?: string} | NativeFields | ((context: TclContext,id: string)=>boolean),reason='The Tcl task was cancelled.'): number{
  if(taskOrFilter===undefined)return this.cancelAll(reason);
  const filter: (task: Pick<TclTask,'context' | 'id'>)=>boolean=typeof taskOrFilter==='function'?task=>taskOrFilter(task.context,task.id):typeof taskOrFilter==='object'&&!taskOrFilter.taskId?task=>Object.entries(taskOrFilter).every(([key,value])=>task.context[key]===value):task=>task.id===String((typeof taskOrFilter==='object'?taskOrFilter?.taskId:taskOrFilter));
  let count=0;for(const task of this.tasks.values())if(filter(task)){
   // Abort host continuations immediately, then require the worker to confirm
   // deletion. A CPU-bound worker that cannot acknowledge is terminated.
   if(!this.closed){this.send(['cancel',task.id]);const guard=setTimeout(()=>this.fail(new TclError('Tcl worker failed to acknowledge cancellation within its execution bound.')),250);guard.unref?.();this.cancellations.set(task.id,guard);}
   this.finish(task,new TclCancelledError(reason,{taskId:task.id}));count++;
  }
  for(const [id,context]of this.timers)if(filter({id:context.taskId ?? '',context})){this.timers.delete(id);if(!this.closed)this.send(['cancel-timer',id]);count++;}
  return count;
 }
 cancelAll(reason='The Tcl world tasks were cancelled.'): number{
  const count=this.cancel(()=>true,reason);this.timers.clear();if(!this.closed)this.send(['reset']);return count;
 }
 fail(error: TclError){if(this.closed)return;this.readyReject(error);this.destroy(error);}
 destroy(reason: TclError=new TclCancelledError('The Tcl runtime was closed.')){
  if(this.closed)return;this.closed=true;clearTimeout(this.startTimer);this.readyReject(reason);
  for(const task of this.tasks.values())this.finish(task,reason);this.timers.clear();this.waits.clear();for(const timer of this.cancellations.values())clearTimeout(timer);this.cancellations.clear();for(const resolve of this.barriers.values())resolve();this.barriers.clear();this.child.stdin.destroy();this.child.kill('SIGKILL');
 }
}
export const newTclRuntime=(options?: TclRuntimeOptions)=>new TclRuntime(options);
