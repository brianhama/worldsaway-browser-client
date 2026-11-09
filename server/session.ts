/** Native AltAway protocol client. Optional Tcl execution is isolated in tcl-session. */
import type {ServerResponse} from 'node:http';
import type {NativeTclSession} from './tcl-session.js';
import type {NativeConnection,LauncherInput,ResourceEntry,FileEntry,NativeObject,NativePacket,SessionState,NativeFields,HistoryEntry,PendingRequest,NativeAction} from './types.js';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { ResourceStore } from '../native/resources.js';
import { ClassRegistry, decodeClientString } from '../native/classes.js';
import { FrameDecoder, asciiField, frame } from '../native/protocol.js';
import { decodeNativeContents, contentsDiagnostics } from './contents.js';
import { applyWorldUpdate } from './reducers.js';
import { createNativeSocket } from './transport.js';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const uint = (value: unknown, max: number, label: string) => { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Invalid ${label}`); return n; };
const clean = (value: unknown, length = 4096) => String(value ?? '').slice(0, length);
const cstring = (bytes: Buffer) => decodeClientString(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
const serial = (value: any): any => Buffer.isBuffer(value) ? [...value] : Array.isArray(value) ? value.map(serial) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serial(v)])) : value;

/** Login controls arrive before a fresh world has supplied message schemas. */
function bootstrapControl(id: number,payload: Buffer): NativeFields | null {
  if(id===10){
    if(payload.length!==16)throw new Error('Native configuration is truncated or oversized');
    return {heartbeat:payload.readUInt32BE(0),inactivityDefault:payload.readUInt32BE(4),inactivityMin:payload.readUInt32BE(8),inactivityMax:payload.readUInt32BE(12)};
  }
  if(id===12){
    if(payload.length!==276)throw new Error('Native avatar list is truncated or oversized');
    return {success:payload.readUInt16BE(0),newAvatarAllowed:payload.readUInt16BE(2),numAvatars:payload.readUInt32BE(4),maxAvatars:payload.readUInt32BE(8),avatarsInuse:payload.readUInt32BE(12)};
  }
  if(id===15){
    if(!payload.length||payload.length>4096||payload.indexOf(0)!==payload.length-1)throw new Error('Invalid native login error');
    return {reason:cstring(payload)};
  }
  if(id===16){
    if(payload.length!==8)throw new Error('Invalid native resource announcement');
    return {count:payload.readUInt32BE(0),size:payload.readUInt32BE(4)};
  }
  if([14,18,22,23].includes(id)){
    if(payload.length>1)throw new Error('Invalid native control notice');
    return {unused:payload[0]??0};
  }
  return null;
}

/** Parse the launcher's bounded INI response without evaluating client settings. */
export function parseConnection(text: string): NativeConnection {
  if (typeof text !== 'string' || text.length > 16384 || text.includes('\0')) throw new Error('Invalid connection file');
  const values: Record<string,string> = {};
  let section = '';
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^\[.*\]$/.test(line.trim())) { section = line.trim().slice(1,-1).toLowerCase(); continue; }
    const equals = line.indexOf('=');
    if (equals < 1 || section !== 'connect info') continue;
    const key = line.slice(0,equals).trim().toLowerCase();
    if (Object.hasOwn(values,key)) throw new Error('Duplicate connection field');
    values[key] = line.slice(equals+1).trim();
  }
  const result = { host: values.serveraddr, worldPort: uint(values.loginport,65535,'world port'), rpcPort: uint(values.rpcport,65535,'RPC port'), account: values.acctname || values.username, token: values.onetimepass, avatar: values.avatarname || '', region: values.loginregion === undefined ? 0xffffffff : uint(values.loginregion,0xffffffff,'region'), worldName: values.worldname || 'AltAway', wsurl:values.wsurl || null };
  if (!result.host || !result.account || !result.token || !result.worldPort || !result.rpcPort) throw new Error('Login response is missing connection information');
  asciiField(result.account,256); asciiField(result.token,16);
  if (!/^[A-Za-z0-9_.:-]{1,253}$/.test(result.host)) throw new Error('Invalid world host');
  return result;
}

// Fetch's top-level "fetch failed" hides the useful transport cause. Keep the
// public message contextual without reflecting URLs, credentials or raw errors.
function launcherNetworkFailure(error: any) {
  const failures: any[] = [], pending = [error], seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current); failures.push(current);
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  const hasCode = (...codes: string[]) => failures.some(item => codes.includes(item.code));
  if (failures.some(item => /^(?:unexpected redirect|redirect count exceeded)$/i.test(item.message ?? ''))) return {reason:'the launcher redirected the request; use its direct HTTPS address',transient:false};
  if (failures.some(item => /^(?:ERR_TLS_|ERR_SSL_|CERT_)/.test(String(item.code ?? ''))) || hasCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_GET_ISSUER_CERT')) return {reason:'the TLS certificate or secure connection could not be verified',transient:false};
  if (hasCode('ENOTFOUND')) return {reason:'the launcher hostname could not be found',transient:false};
  if (hasCode('EAI_AGAIN')) return {reason:'hostname lookup is temporarily unavailable',transient:true};
  if (failures.some(item => item.name === 'TimeoutError') || hasCode('ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT')) return {reason:'the launcher connection timed out',transient:true};
  if (failures.some(item => item.name === 'AbortError')) return {reason:'the request was cancelled',transient:false};
  if (hasCode('ECONNREFUSED')) return {reason:'the launcher refused the connection',transient:true};
  if (hasCode('ECONNRESET','EPIPE','UND_ERR_SOCKET')) return {reason:'the launcher connection was interrupted',transient:true};
  return {reason:'the network connection failed',transient:false};
}

/**
 * Read a bounded launcher response. Only explicitly opted-in directory GETs may
 * retry; replaying a login POST could mint or consume another one-time ticket.
 */
export interface LauncherOptions { trustedLauncherUrl?: string; }
export async function boundedText(url: string | URL, options: RequestInit = {}, context: {stage?: string; retryTransient?: boolean; trustedLauncherUrl?: string; jsonErrors?: boolean} = {}) {
  const target = new URL(url);
  if (!['https:','http:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP or HTTPS server URL');
  const trustedOrigin=context.trustedLauncherUrl?new URL(context.trustedLauncherUrl).origin:null;
  if (target.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(target.hostname) && target.origin!==trustedOrigin) throw new Error('Remote launcher login requires HTTPS');
  const stage = context.stage === 'directory' ? 'World directory' : context.stage === 'login' ? 'Login' : 'Launcher';
  const description = `${stage} request to ${target.host}`;
  const canRetry = context.stage === 'directory' && context.retryTransient === true && String(options.method ?? 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    let response, text;
    try {
      response = await fetch(target, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15000) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 131072) throw Object.assign(new Error(`${description} failed: launcher response is too large`),{code:'ERR_LAUNCHER_RESPONSE_TOO_LARGE'});
        chunks.push(Buffer.from(chunk));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } catch (error: any) {
      if (error?.code === 'ERR_LAUNCHER_RESPONSE_TOO_LARGE') throw error;
      const failure = launcherNetworkFailure(error);
      if (canRetry && attempt === 0 && failure.transient && (!response || response.ok) && !options.signal?.aborted) continue;
      throw new Error(`${description} failed: ${failure.reason}`,{cause:error});
    }
    if (!response.ok) {
      let message='';
      if(context.jsonErrors){
        try{const body=JSON.parse(text);if(typeof body.error==='string')message=body.error.slice(0,512);}catch{}
        if(!message&&text.length<=512&&!/[<>\0]/.test(text))message=text.trim();
      }
      throw Object.assign(new Error(message||`${description} returned HTTP ${response.status}${text.includes('Unable') ? ': invalid account or password' : ''}`),{status:response.status});
    }
    return text;
  }
}

export async function discoverWorlds(baseUrl: string, options: LauncherOptions = {}) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const text = await boundedText(new URL('worlds3.php?v=2.6.1-RC1',base), {headers:{'user-agent':'AltAway Browser/1.0','cache-control':'no-cache'}}, {stage:'directory',retryTransient:true,...options});
  const worlds = text.split(/\r?\n/).filter(line=>line.includes('|')).map(line=> {
    const [name,loginUrl,executable,flags='',archive=''] = line.split('|');
    return {name:clean(name,128), loginUrl:new URL(loginUrl,base).href, executable,flags,archive};
  });
  if (!worlds.length) throw new Error('Server did not return an AltAway world directory');
  return worlds;
}

export async function launcherConnection(input: LauncherInput, options: LauncherOptions = {}) {
  let loginUrl = input.loginUrl,tunnel=Boolean(input.tunnel);
  if (!loginUrl) {
    const base = input.launcherUrl || 'https://altaway.xyz/';
    const worlds = await discoverWorlds(base,options);
    const selected = worlds.find(w => input.world && w.name === input.world) ?? worlds.find(w=>!w.flags.includes('w')) ?? worlds[0];
    tunnel=selected.flags.includes('w');
    loginUrl = selected.loginUrl;
  }
  if(options.trustedLauncherUrl){
    // WorldsAway's native address can differ from its reverse-proxied HTTP
    // address. Keep credential POSTs on the bridge-configured backend origin.
    const discovered=new URL(loginUrl);
    if(discovered.pathname!=='/login'||discovered.search||discovered.hash)throw new Error('WorldsAway returned an invalid login endpoint');
    loginUrl=new URL('/login',options.trustedLauncherUrl).href;
    tunnel=false;
  }
  const body = new URLSearchParams({username:clean(input.account,255),password:String(input.password ?? ''),action:'Login'});
  if (input.avatar) body.set('avatar',clean(input.avatar,31));
  if(tunnel)body.set('ws','true');
  const text = await boundedText(loginUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'AltAway Browser/1.0'},body},{stage:'login',...options});
  if (/Unable/i.test(text)) throw new Error('Launcher rejected the account or password');
  const connection=parseConnection(text);
  if(tunnel){if(!connection.wsurl)throw new Error('World did not provide its required WebSocket tunnel URL');connection.transport='wstunnel';connection.rpcPort=connection.worldPort;}
  return {...connection,loginUrl};
}

/**
 * Own one player's native socket and decoded world state. Resource/file overlays
 * are session-local; the admitted on-disk cache remains a read-only baseline.
 */
export class NativeSession extends EventEmitter {
  id: string;
  resources: ResourceStore;
  resourceMap: Map<number,ResourceEntry>;
  registry: ClassRegistry;
  partialResources: Map<number,{id: number;version: number;size: number;received: number;chunks: Buffer[]}>;
  fileCache: Map<string,FileEntry>;
  pendingFiles: Map<string,Promise<Buffer>>;
  decoder: FrameDecoder;
  objects: Map<number,NativeObject>;
  subscribers: Set<ServerResponse>;
  closed: boolean; lastAccess: number; idleMs: number;
  state: SessionState;
  receivedResourceBytes: number; sequence: number; pendingRequests: PendingRequest[];
  pendingEmit: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | undefined;
  lastSend: number;
  socket: ReturnType<typeof createNativeSocket> | null = null;
  connection!: NativeConnection;
  launcher?: LauncherInput;
  launcherOptions?: LauncherOptions;
  tcl?: NativeTclSession;
  lastFailedCv?: NativeFields;
  reconnecting: Promise<ReturnType<NativeSession['snapshot']>> | null = null;
  constructor({resources, clientDir, idleMs = 30*60*1000}: {resources?: ResourceStore;clientDir?: string;idleMs?: number} = {}) {
    super();
    this.id = randomBytes(32).toString('hex');
    this.resources = resources ?? new ResourceStore({clientDir});
    this.resourceMap = new Map(this.resources.bootstrapResources().filter((r): r is ResourceEntry=>r!==null).map(r=>[r.id,r]));
    this.registry = new ClassRegistry(this);
    this.partialResources = new Map(); this.fileCache = new Map(); this.pendingFiles = new Map();
    this.decoder = new FrameDecoder(MAX_RESOURCE_BYTES,MAX_RESOURCE_BYTES*2);
    this.objects = new Map(); this.subscribers = new Set(); this.closed = false; this.lastAccess = Date.now(); this.idleMs=idleMs;
    this.state = {status:'disconnected', avatar:null,avatars:[],capacity:0,actorNoid:null,helperName:'',objects:[],region:null,history:[],resources:{received:0,total:0,bytes:0},revision:0,error:null};
    this.receivedResourceBytes=0; this.sequence=0; this.pendingRequests=[]; this.pendingEmit=null; this.keepalive=undefined; this.lastSend=0;
  }
  bootstrapResources(){return [...this.resourceMap.values()];}
  getResource(id: number){return this.resourceMap.get(Number(id)) ?? null;}
  getFile(name: string,version?: number){
    const cached=this.fileCache.get(name);
    if(cached&&(version===undefined||cached.version===version||cached.requestedVersion===version))return cached.data;
    const local=this.resources.getFileInfo(name);
    return local&&(version===undefined||local.version===version)?local.data:null;
  }
  // Publish capability flags rather than the retained launcher credentials.
  snapshot(){ return {...this.state,canReconnect:Boolean(this.launcher?.password!==undefined),objects:[...this.objects.values()],history:[...this.state.history]}; }
  /** Coalesce packet bursts into snapshots while keeping every history sequence. */
  publish(){
    this.state.revision++;
    if(this.pendingEmit) return;
    this.pendingEmit=setTimeout(()=>{this.pendingEmit=null;this.emit('state',this.snapshot());},20);
    this.pendingEmit.unref();
  }
  history(type: string,packet: Pick<NativePacket,'noid' | 'id'>,fields: NativeFields={},extra: NativeFields={}): HistoryEntry{
    const entry = {seq:++this.sequence,time:Date.now(),type,noid:packet.noid,id:packet.id,messageId:packet.id,fields:serial(fields),values:serial(fields),...extra};
    this.state.history.push(entry); if(this.state.history.length>300)this.state.history.shift(); return entry;
  }
  fail(error: Error){this.state.error=error.message;this.state.status='error';this.history('error',{noid:10,id:15},{reason:error.message});this.publish();this.emit('failure',error);}
  async connect(connection: NativeConnection) {
    if(this.socket) throw new Error('This session is already connected');
    this.connection={...connection}; this.state.status='connecting';this.state.worldName=clean(connection.worldName || 'AltAway',128); this.publish();
    const host=clean(connection.host,253),port=uint(connection.worldPort,65535,'world port');
    if(!port||!/^[A-Za-z0-9_.:-]{1,253}$/.test(host))throw new Error('Invalid world endpoint');
    asciiField(connection.account,256); asciiField(connection.token!,16);
    const socket=this.socket=createNativeSocket(connection,port);socket.setNoDelay(true);
    // The identity guard prevents a late event from the replaced socket from
    // changing state after reconnect has installed a new native connection.
    socket.on('data',chunk=>{if(this.socket!==socket)return;try{for(const packet of this.decoder.feed(chunk))this.receive(packet);}catch(error: any){this.fail(error);socket.destroy();}});
    socket.on('error',error=>{if(this.socket===socket&&!this.closed)this.fail(new Error(`World connection failed: ${error.message}`));});
    socket.on('close',()=>{if(this.socket!==socket)return;clearInterval(this.keepalive);if(!this.closed && this.state.status!=='error'){this.state.status='disconnected';this.publish();}this.emit('disconnected');});
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new Error('World connection timed out'));},15000);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);reject(error);});});
    const body=Buffer.alloc(288);asciiField(connection.account,256).copy(body);asciiField(connection.token!,16).copy(body,256);body.writeUInt32BE(0,272);body.writeUInt16BE(0,276);body.writeUInt16BE(2,278);body.writeUInt16BE(325,280);
    const ready=this.waitFor(s=>s.status==='avatars',15000);
    this.send(10,11,body);await ready;
    // The ticket is no longer needed after native authentication.
    delete this.connection.token;
    if(connection.avatar && this.state.avatars.some(a=>a.name===connection.avatar&&!a.busy))await this.enter(connection.avatar,connection.region);
    return this.snapshot();
  }
  waitFor(predicate: (state: SessionState) => boolean,timeout=15000){
    if(predicate(this.state))return Promise.resolve(this.snapshot());
    return new Promise((resolve,reject)=>{
      const check=()=>{if(predicate(this.state)){cleanup();resolve(this.snapshot());}};
      const failure=(error: Error)=>{cleanup();reject(error);};
      const gone=()=>failure(new Error('World connection closed'));
      const timer=setTimeout(()=>failure(new Error('World server did not respond in time')),timeout);
      const cleanup=()=>{clearTimeout(timer);this.off('packet',check);this.off('failure',failure);this.off('disconnected',gone);};
      this.on('packet',check);this.on('failure',failure);this.on('disconnected',gone);
    });
  }
  send(noid: number,id: number,payload: Buffer){if(!this.socket||this.socket.destroyed)throw new Error('World is not connected');this.socket.write(frame(noid,id,payload));this.lastSend=Date.now();}
  async enter(name: string,region=this.connection.region ?? 0xffffffff){
    asciiField(name,32);if(this.state.status!=='avatars')throw new Error('Avatar selection is not available');
    if(this.state.avatars.find(a=>a.name===name)?.busy)throw new Error('Avatar is already connected');
    this.state.avatar=name;this.state.status='entering';this.state.error=null;this.publish();
    const body=Buffer.alloc(72);asciiField(name,32).copy(body);body.writeUInt32BE(uint(region ?? 0xffffffff,0xffffffff,'region'),32);
    const ready=this.waitFor(s=>s.status==='connected',30000);this.send(10,13,body);await ready;return this.snapshot();
  }
  /** Encode against the current world schema and capture state needed by replies. */
  action({noid,id,messageId,fields,values}: NativeAction){
    id=uint(id ?? messageId,65535,'message ID');noid=uint(noid,65535,'object number');
    if(this.state.status!=='connected')throw new Error('Enter an avatar before using world actions');
    if(noid===10 && [11,13,19,20].includes(id))throw new Error('Use the session controls for this operation');
    const data=fields ?? values ?? {};
    const payload=this.registry.encodeMessage(id,data);
    const target=this.objects.get(noid);
    const contracts=target?this.registry.requestContracts(target.classNumber):[];
    const candidates=contracts.filter((c: NativeFields)=>c.id===id&&c.replyId!==null);
    const fallback=[...this.registry.methods.values()].flatMap(m=>m.requests).find(c=>c.id===id&&c.replyId!==null);
    const replyId=candidates[0]?.replyId??fallback?.replyId??70;
    const hand=[...this.objects.values()].find(o=>o.fields.container_noid===this.state.actorNoid&&o.fields.position?.[0]===0);
    this.pendingRequests=this.pendingRequests.filter(r=>Date.now()-r.time<60000);
    if(this.pendingRequests.length>=128)throw new Error('Too many unanswered world operations');
    // Replies may omit the original item, amount, or actor. Preserve those
    // values now, before any intervening notice can move objects or change fields.
    const pending: PendingRequest={noid,id,fields:structuredClone(data),replyId,time:Date.now(),actorNoid:this.state.actorNoid,handNoid:hand?.noid,before:structuredClone(target?.fields??{})};this.pendingRequests.push(pending);
    this.send(noid,id,payload);pending.seq=this.history('request',{noid,id},data).seq;this.publish();return {sent:true,seq:pending.seq};
  }
  /** Decode the complete vector before replacing the visible object map. */
  decodeObjects(bytes: Buffer,{replace=false,compressed=false}={}){
    const result=decodeNativeContents(bytes,this.registry,{compressed});const decoded=result.objects.map(object=>({...object,fields:serial(object.fields)}));
    if(replace)this.objects.clear();for(const object of decoded)this.objects.set(object.noid,object);
    this.state.region=this.objects.get(0) ?? null;return decoded;
  }
  receiveContents(packet: NativePacket,fields: NativeFields,{replace=false,compressed=false}={}){
    try{this.decodeObjects(Buffer.from(fields.contentsVector),{replace,compressed});this.state.sceneNeedsRefresh=false;this.state.sceneWarning=null;return true;}
    catch(error: any){
      const diagnostics=error.diagnostics??contentsDiagnostics(Buffer.from(fields.contentsVector));
      this.lastFailedCv={id:packet.id,noid:packet.noid,time:Date.now(),data:Buffer.from(fields.contentsVector),diagnostics};
      this.state.sceneNeedsRefresh=true;this.state.sceneWarning={id:packet.id,noid:packet.noid,reason:error.message,diagnostics};
      this.history('decode-error',packet,{reason:error.message,...diagnostics});this.publish();return false;
    }
  }
  /** Share one reconnect attempt and always request a fresh launcher ticket. */
  async reconnect({avatar=this.state.avatar,region}: {avatar?: string | null;region?: number}={}){
    if(this.reconnecting)return this.reconnecting;
    if(!this.launcher||this.launcher.password===undefined)throw new Error('Sign in again to obtain a fresh world ticket');
    const run=async()=>{
      const old=this.socket;this.socket=null;clearInterval(this.keepalive);this.pendingRequests=[];
      if(old&&!old.destroyed){try{old.write(frame(10,20,Buffer.alloc(1)));old.end();}catch{}await new Promise<void>(resolve=>{const timer=setTimeout(()=>{old.destroy();resolve();},500);old.once('close',()=>{clearTimeout(timer);resolve();});});}
      this.decoder=new FrameDecoder(MAX_RESOURCE_BYTES,MAX_RESOURCE_BYTES*2);this.partialResources.clear();this.state.status='connecting';this.state.error=null;this.publish();
      try{const connection=await launcherConnection({...this.launcher!,avatar:avatar ?? undefined},this.launcherOptions);if(region!==undefined)connection.region=uint(region,0xffffffff,'region');return await this.connect(connection);}
      catch(error: any){this.fail(error);(this.socket as ReturnType<typeof createNativeSocket> | null)?.destroy();this.socket=null;throw error;}
    };
    this.reconnecting=run().finally(()=>{this.reconnecting=null;});return this.reconnecting;
  }
  updateObject(noid: number,patch: NativeFields){const object=this.objects.get(noid);if(object)object.fields={...object.fields,...serial(patch)};}
  receive(packet: NativePacket){
    const {noid,id,payload}=packet;
    if(noid===10 && id===17){this.receiveResource(payload);return;}
    let fields: NativeFields={};
    try {
      const bootstrap=noid===10&&!this.registry.getMessage(id)?bootstrapControl(id,payload):null;
      if(bootstrap)fields=bootstrap;
      else if(payload.length || this.registry.getMessage(id))fields=this.registry.decodeMessage(id,payload,{maxPayloadBytes:MAX_RESOURCE_BYTES,maxArrayElements:16*1024*1024});
    }catch(error: any){
      // Some legacy control notices omit their unused byte.
      if(noid===10 && [14,18,22,23].includes(id)&&payload.length===0)fields={};
      else {this.history('decode-error',packet,{reason:error.message,bytes:payload.length});this.publish();this.emit('packet');return;}
    }
    let contentsValid=true;
    if(noid===10 && id===10){
      const seconds=Math.min(3600,Number(fields.heartbeat)||0);clearInterval(this.keepalive);
      if(seconds)this.keepalive=setInterval(()=>{if(this.socket&&!this.socket.destroyed&&Date.now()-this.lastSend>=seconds*1000){this.send(10,19,Buffer.alloc(1));}},Math.max(1000,seconds*500));this.keepalive?.unref();
    }else if(noid===10 && id===12){
      if(payload.length<276)throw new Error('Avatar list is truncated');
      const count=payload.readUInt32BE(4),capacity=payload.readUInt32BE(8),busy=payload.readUInt32BE(12);
      if(capacity>8||count>capacity)throw new Error('Avatar list exceeds native capacity');
      this.state.capacity=capacity;this.state.newAvatarAllowed=Boolean(fields.newAvatarAllowed);
      this.state.avatars=Array.from({length:capacity},(_,i)=>({name:cstring(payload.subarray(18+i*32,50+i*32)),busy:Boolean(busy&(1<<i))})).filter(a=>a.name);
      this.state.status='avatars';
    }else if(noid===10 && id===15){this.fail(new Error(fields.reason || cstring(payload) || 'World login rejected'));}
    else if(noid===10 && id===16){
      this.receivedResourceBytes=0;this.state.resources={received:0,total:fields.count,bytes:0,totalBytes:fields.size,
        advertisedTotal:fields.count,advertisedBytes:fields.size};
    }
    else if(noid===10 && id===18){this.rebuildRegistry();this.state.resources.complete=true;}
    else if(id===101 && noid===0){
      contentsValid=this.receiveContents(packet,fields,{replace:true,compressed:true});if(contentsValid)this.state.actorNoid=fields.actor_noid;
      this.state.permissions={level:fields.actor_perm_level,flags:fields.actor_perm_flags};
      this.state.helperName=fields.helper_name??'';
      this.state.status='connected';this.state.error=null;
    }else{
      if(fields.contentsVector?.length && (!Object.hasOwn(fields,'success')||fields.success===0))contentsValid=this.receiveContents(packet,fields);
    }
    let request;
    // The wire has no transaction ID. Match the oldest eligible operation,
    // including standard reply 70 delivered on the region receiver (NOID 0).
    const pendingIndex=this.pendingRequests.findIndex(r=>r.replyId===id&&(r.noid===noid||noid===0&&id===70));
    if(pendingIndex>=0)request=this.pendingRequests.splice(pendingIndex,1)[0];
    if(contentsValid)applyWorldUpdate(this,packet,fields,request);
    this.state.region=this.objects.get(0)??null;
    const visible={...fields};if(visible.contentsVector){visible.contentsVectorBytes=visible.contentsVector.length;delete visible.contentsVector;}
    const speaker=this.objects.get(fields.speaker??noid);
    const speakerName=fields.from||fields.realname||speaker?.fields?.name||(noid===this.state.actorNoid?this.state.avatar:null)||'World';
    this.history('message',packet,visible,{speakerName,...(request?{requestId:request.id,requestNoid:request.noid,requestSeq:request.seq}:{})});this.publish();this.emit('packet');
  }
  /** Admit a resource only after all fragments of its announced version arrive. */
  receiveResource(payload: Buffer){
    if(payload.length<16)throw new Error('Resource fragment is truncated');
    const id=payload.readUInt32BE(0),version=payload.readUInt32BE(4),fullSize=payload.readUInt32BE(8),dataSize=payload.readUInt32BE(12);
    if(dataSize!==payload.length-16)throw new Error('Resource fragment length mismatch');
    let pending=this.partialResources.get(id);
    if(!pending){if(!fullSize||fullSize===0xffffffff||fullSize>MAX_RESOURCE_BYTES)throw new Error('Invalid resource size');pending={id,version,size:fullSize,received:0,chunks:[]};this.partialResources.set(id,pending);}
    if(version!==pending.version||pending.received+dataSize>pending.size)throw new Error('Resource exceeds announced size');
    this.receivedResourceBytes+=dataSize;if(this.receivedResourceBytes>128*1024*1024)throw new Error('Resource update exceeds browser limits');
    pending.chunks.push(payload.subarray(16));pending.received+=dataSize;this.state.resources.bytes+=dataSize;
    if(pending.received===pending.size){if(this.state.resources.received>=65536)throw new Error('Resource update exceeds browser resource-count limit');this.resourceMap.set(id,{id,version,data:Buffer.concat(pending.chunks)});this.partialResources.delete(id);this.state.resources.received++;}
    this.publish();
  }
  rebuildRegistry(){
    if(this.partialResources.size)throw new Error('Server ended an incomplete resource update');
    const update=this.state.resources;
    // Native WA control16 advertises progress estimates, not an integrity
    // manifest. Its control18 path finishes progress and enters the world
    // without requiring equality (wa32 0x43f520 cases9/10/11). Complete every
    // resource independently and retain actual/advertised totals for inspection.
    if(update.totalBytes!==undefined&&(update.received!==update.total||update.bytes!==update.totalBytes)){
      update.progressMismatch={advertisedCount:update.total,advertisedBytes:update.totalBytes,actualCount:update.received,actualBytes:update.bytes};
    }else delete update.progressMismatch;
    this.registry=new ClassRegistry(this);
  }
  async fetchFile(name: string,version?: number){
    if(typeof name!=='string'||name.length<1||name.length>63||/[\\/:\0]/.test(name)||!/^[\x20-\x7e]+$/.test(name))throw new Error('Invalid image filename');
    const existing=this.getFile(name,version);if(existing)return existing;
    // Coalesce in-flight fetches only when both filename and requested version
    // match; different version requests must not share the same pending promise.
    const key=`${name}\0${version??''}`;if(this.pendingFiles.has(key))return this.pendingFiles.get(key);
    if(!this.connection)throw new Error('Image is not in the local cache');
    const pending=fetchNativeFile(this.connection,name).then(result=>{this.fileCache.set(name,{...result,requestedVersion:version});return result.data;}).finally(()=>this.pendingFiles.delete(key));
    this.pendingFiles.set(key,pending);return pending;
  }
  /** Idempotent teardown also clears the credentials retained for avatar controls. */
  close(){
    if(this.closed)return;this.tcl?.destroy();this.closed=true;clearInterval(this.keepalive);clearTimeout(this.pendingEmit ?? undefined);
    if(this.socket&&!this.socket.destroyed){try{this.send(10,20,Buffer.alloc(1));}catch{}this.socket.end();setTimeout(()=>this.socket?.destroy(),500).unref();}
    if(this.launcher)delete this.launcher.password;if(this.connection)delete this.connection.token;this.pendingRequests=[];
    this.state.status='disconnected';this.emit('state',this.snapshot());for(const listener of this.subscribers)listener.end();this.subscribers.clear();
  }
}

/** Fetch one filename through the separate RPC socket, validating its echoed name. */
export async function fetchNativeFile(connection: NativeConnection,name: string): Promise<FileEntry>{
  asciiField(name,64);
  const socket=createNativeSocket(connection,connection.rpcPort);socket.setNoDelay(true);
  let buffer=Buffer.alloc(0),size: number | null=null;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Image service timed out')),15000);
    const finish=(error: Error | null,value?: FileEntry)=>{clearTimeout(timer);socket.destroy();error?reject(error):resolve(value!);};
    socket.once('error',error=>finish(new Error(`Image service failed: ${error.message}`)));
    socket.on('connect',()=>{const header=Buffer.alloc(8);header.writeUInt32BE(0x31);header.writeUInt32BE(1,4);socket.write(Buffer.concat([header,asciiField(name,64)]));});
    socket.on('data',chunk=>{
      if(buffer.length+chunk.length>MAX_FILE_BYTES+76)return finish(new Error('Image service exceeded file limit'));
      buffer=Buffer.concat([buffer,chunk]);
      if(size===null&&buffer.length>=76){if(buffer.readUInt32BE(0)!==0)return finish(new Error('Image was not found'));if(cstring(buffer.subarray(4,68))!==name)return finish(new Error('Image service returned a different filename'));size=buffer.readUInt32BE(68);if(size>MAX_FILE_BYTES)return finish(new Error('Image exceeds file limit'));}
      if(size!==null&&buffer.length>=76+size)finish(null,{version:buffer.readUInt32BE(72),data:Buffer.from(buffer.subarray(76,76+size))});
    });
    socket.on('end',()=>{if(size===null||buffer.length<76+size)finish(new Error('Image service closed before completing the file'));});
  });
}
