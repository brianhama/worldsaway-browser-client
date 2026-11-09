#!/usr/bin/env node
import type {IncomingMessage,ServerResponse,OutgoingHttpHeaders} from 'node:http';
import type {Socket,AddressInfo} from 'node:net';
import type {TclSessionOptions} from './tcl-session.js';
import {projectRoot} from '../scripts/paths.js';
import type {NativeFields} from './types.js';
import type {LauncherOptions} from './session.js';
/** Same-origin HTTP/SSE bridge; public hosting requires an explicit HTTPS origin. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResourceStore } from '../native/resources.js';
import { ClassRegistry } from '../native/classes.js';
import { NativeSession, launcherConnection, discoverWorlds, boundedText, parseConnection } from './session.js';
import {NativeTclSession} from './tcl-session.js';



/** Hosted mode requires both an explicit HTTPS origin and a permitted bind address. */
export interface BridgeOptions {
 publicOrigin?: string; host?: string; port?: number; launcherUrl?: string;
 clientDir?: string; staticDir?: string; resources?: ResourceStore; tcl?: TclSessionOptions;
}

const mime: Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
const text = (value: unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?Number(v):v);
const fail=(status: number,message: string)=>Object.assign(new Error(message),{status});
const cookieName='altaway_browser_session';
const hostedLauncher='https://altaway.xyz/';
const worldsAwayLauncher='http://127.0.0.1:8080';

function launcherUrl(value: string){
  let url;try{url=new URL(value);}catch{throw new Error('Use a valid backend HTTP or HTTPS URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Use a backend HTTP or HTTPS URL without credentials, query or fragment');
  return url.href.replace(/\/$/,'');
}
const sameLauncher=(a: string,b: string)=>launcherUrl(a)===launcherUrl(b);

function metadata(registry: ClassRegistry){return {summary:registry.summary,classes:registry.list().map(c=>({classNumber:c.classNumber,name:c.name,capacity:c.capacity,schema:c.schema,fields:c.fields,requests:registry.requestContracts(c.classNumber)})),messages:[...registry.messages.values()].map(m=>({messageId:m.messageId,schema:m.schema,fields:m.fields}))};}
async function jsonBody(req: IncomingMessage): Promise<NativeFields>{
  if(!String(req.headers['content-type']??'').startsWith('application/json'))throw fail(415,'Use application/json');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail(413,'Request is too large');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'Invalid JSON request');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'Expected a JSON object');return value;
}

/**
 * Create the HTTP bridge without opening its listener. The returned start/close
 * methods own sockets, sessions, and their cleanup as one process-local lifetime.
 */
export function createBridgeServer(options: BridgeOptions={}){
  let publicOrigin: string | null=null;
  if(options.publicOrigin!==undefined){
    let configured;try{configured=new URL(options.publicOrigin);}catch{throw new Error('publicOrigin must be an HTTPS origin');}
    if(configured.protocol!=='https:'||configured.username||configured.password||configured.pathname!=='/'||configured.search||configured.hash)throw new Error('publicOrigin must be an HTTPS origin without a path, credentials, query or fragment');
    publicOrigin=configured.origin;
  }
  const host=options.host??(publicOrigin?'0.0.0.0':'127.0.0.1');
  if(!['127.0.0.1','::1','localhost'].includes(host)&&!(publicOrigin&&host==='0.0.0.0'))throw new Error('The browser bridge must bind to loopback unless an HTTPS publicOrigin is configured');
  const clientDir=path.resolve(options.clientDir??process.env.ALTAWAY_CLIENT_DIR??path.join(projectRoot,'assets'));
  const staticDir=path.resolve(options.staticDir??path.join(projectRoot,'dist/public'));
  // A missing default cache is valid for fresh installations; an explicitly
  // configured cache must pass admission so configuration mistakes stay visible.
  const resources=options.resources??new ResourceStore({clientDir,allowEmpty:options.clientDir===undefined&&!process.env.ALTAWAY_CLIENT_DIR});
  const registry=new ClassRegistry(resources);let meta=metadata(registry);
  const sessions=new Map<string,NativeSession>();const sockets=new Set<Socket>();
  let baseUrl: string | undefined;
  const defaultLauncher=options.launcherUrl??process.env.WORLDSAWAY_BACKEND_URL??worldsAwayLauncher;
  launcherUrl(defaultLauncher);
  const backendName=sameLauncher(defaultLauncher,hostedLauncher)?'AltAway':'WorldsAway.app';
  const config={application:'AltAway Browser',version:'0.3.0',backendName,registrationEnabled:backendName==='WorldsAway.app',launcherUrl:defaultLauncher,localLauncherUrl:defaultLauncher,transport:'tcp-bridge',hosted:Boolean(publicOrigin),classCount:registry.classes.size,messageCount:registry.messages.size,fileAssets:resources.summary.fileAssets,requiresBridge:true,tcl:{enabled:true,minimumVersion:'8.6'}};
  function trustedOptions(base: string): LauncherOptions {return sameLauncher(base,defaultLauncher)&&backendName==='WorldsAway.app'?{trustedLauncherUrl:defaultLauncher}:{};}
  async function capabilities(base: string){
    const raw=await boundedText(new URL('/api/capabilities',base),{},{...trustedOptions(base),jsonErrors:true});
    let result;try{result=JSON.parse(raw);}catch{throw fail(502,'The selected server did not return valid WorldsAway.app capabilities');}
    if(result.application!=='WorldsAway.app'||typeof result.registration?.enabled!=='boolean'||result.registration.endpoint!=='/api/register')throw fail(400,'Account creation is available only on a WorldsAway.app server');
    return result;
  }
  let capabilityCheckedAt=0;
  async function refreshCapabilities(){
    if(backendName!=='WorldsAway.app'||Date.now()-capabilityCheckedAt<30000)return;
    capabilityCheckedAt=Date.now();
    try{config.registrationEnabled=(await capabilities(defaultLauncher)).registration.enabled;}catch{}
  }
  function selectedBackend(input: NativeFields){
    const requested=input.launcherUrl;
    if(requested!==undefined&&typeof requested!=='string')throw fail(400,'Use a valid server address');
    if(publicOrigin&&requested&&!sameLauncher(requested,defaultLauncher))throw fail(400,'Hosted clients must use the configured WorldsAway.app backend');
    return requested?launcherUrl(requested):defaultLauncher;
  }
  const sessionCookie=(id: string)=>`${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/${publicOrigin?'; Secure':''}`;
  function newSession(){const item=new NativeSession({resources,clientDir});item.tcl=new NativeTclSession(item,options.tcl??{});return item;}
  function session(req: IncomingMessage,required?: true): NativeSession;
  function session(req: IncomingMessage,required: false): NativeSession | undefined;
  function session(req: IncomingMessage,required=true): NativeSession | undefined{
    const id=String(req.headers.cookie??'').split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const item=id?sessions.get(id):undefined;if(!item&&required)throw fail(401,'Connect to a world first');if(item)item.lastAccess=Date.now();return item;
  }
  function respond(res: ServerResponse,status: number,value: any,headers: OutgoingHttpHeaders={}){
    const body=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:text(value));
    res.writeHead(status,{'content-type':typeof value==='object'&&!Buffer.isBuffer(value)?'application/json; charset=utf-8':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':body.length,...headers});res.end(body);
  }
  async function handle(req: IncomingMessage,res: ServerResponse){
    try{
      // Infrastructure probes do not use the public Host. This exact, read-only
      // endpoint exposes no session, world metadata, credentials or resources.
      if(req.method==='GET'&&req.url==='/healthz')return respond(res,200,{ok:true,application:'AltAway Browser'});
      const hostHeader=String(req.headers.host??'');
      const origin=publicOrigin??`http://${hostHeader}`;
      const url=new URL(req.url ?? '/',origin),pathname=url.pathname;
      const method=req.method??'GET';
      // Check Host as well as Origin: loopback binding alone does not distinguish
      // an intended local request from a browser request using a foreign hostname.
      if(publicOrigin?hostHeader.toLowerCase()!==new URL(publicOrigin).host:!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(hostHeader))throw fail(403,publicOrigin?'Host does not match the configured application origin':'Only localhost can use the bridge');
      if(req.headers.origin&&req.headers.origin!==origin)throw fail(403,'Cross-origin bridge access is not allowed');
      // Public links may navigate to the app document, but that exception never
      // grants cross-site access to the session or transport APIs.
      const documentNavigation=method==='GET'&&['/','/index.html'].includes(pathname)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])&&!documentNavigation)throw fail(403,'Cross-site bridge access is not allowed');
      if(method==='OPTIONS')throw fail(405,'Cross-origin requests are not supported');
      if(pathname==='/health'&&method==='GET')return respond(res,200,{status:'ok',...config});
      if(pathname==='/api/config'&&method==='GET'){await refreshCapabilities();return respond(res,200,config);}
      if(pathname==='/api/classes'&&method==='GET')return respond(res,200,session(req,false)?metadata(session(req).registry):meta);
      if(pathname==='/api/worlds'&&method==='GET'){
        const requested=url.searchParams.get('url');if(publicOrigin&&requested&&!sameLauncher(requested,defaultLauncher))throw fail(400,'Hosted clients must use the configured world directory');
        const base=publicOrigin?defaultLauncher:requested||defaultLauncher;
        return respond(res,200,{worlds:await discoverWorlds(base,trustedOptions(base))});
      }
      if(pathname==='/api/state'&&method==='GET')return respond(res,200,session(req,false)?.snapshot()??{status:'disconnected',avatars:[],objects:[],history:[]});
      if(pathname==='/api/events'&&method==='GET'){
        const item=session(req);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform',connection:'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
        const send=(state: ReturnType<NativeSession['snapshot']>)=>{if(!res.destroyed)res.write(`event: state\ndata: ${text(state)}\n\n`);};
        // Start with a full snapshot so reconnecting EventSource clients do not
        // need a retained event cursor or a replay of potentially stale deltas.
        send(item.snapshot());item.subscribers.add(res);item.on('state',send);
        const keep=setInterval(()=>{if(Date.now()-item.lastAccess>item.idleMs){item.close();sessions.delete(item.id);}else if(!res.destroyed){item.lastAccess=Date.now();res.write(': keepalive\n\n');}},20000);keep.unref();
        req.on('close',()=>{clearInterval(keep);item.off('state',send);item.subscribers.delete(res);});return;
      }
      if(pathname==='/api/login'&&method==='POST'){
        let input=await jsonBody(req);
        const base=selectedBackend(input);
        if(publicOrigin){
          if(input.connectionFile||input.mode&&input.mode!=='launcher'||['host','worldPort','rpcPort','token','transport','wsurl','tunnelPrefix'].some(key=>Object.hasOwn(input,key)))throw fail(400,'Hosted clients only support login through the configured backend');
          // Directory-derived URLs and tunnel flags supplied by the browser are
          // untrusted. Resolve them again from the fixed official directory.
          input={launcherUrl:defaultLauncher,account:input.account,password:input.password,world:input.world,avatar:input.avatar};
        }else input={...input,launcherUrl:base};
        const previous=session(req,false);if(previous){previous.close();sessions.delete(previous.id);}
        const item=newSession();sessions.set(item.id,item);
        const setCookie=sessionCookie(item.id);
        try{
          let connection;
          if(input.connectionFile)connection=parseConnection(input.connectionFile);
          else if(input.mode==='direct')connection={host:input.host,worldPort:Number(input.worldPort),rpcPort:Number(input.rpcPort??input.worldPort),account:input.account,token:input.token,avatar:input.avatar??'',region:Number(input.region??0xffffffff),worldName:input.worldName??'AltAway',transport:input.transport,wsurl:input.wsurl,tunnelPrefix:input.tunnelPrefix};
          else connection=await launcherConnection(input as unknown as import('./types.js').LauncherInput,trustedOptions(base));
          // Retain credentials only in process memory while avatar management is available.
          if(input.mode!=='direct'&&!input.connectionFile){item.launcher={launcherUrl:base,loginUrl:connection.loginUrl,account:input.account,password:input.password,tunnel:connection.transport==='wstunnel',world:input.world};item.launcherOptions=trustedOptions(base);}
          const state=await item.connect(connection);return respond(res,200,{sessionId:item.id,state},{'set-cookie':setCookie});
        }catch(error: any){item.close();sessions.delete(item.id);throw fail(400,error.message);}
      }
      if(pathname==='/api/register'&&method==='POST'){
        const input=await jsonBody(req);
        if(Object.keys(input).some(key=>!['account','password','avatar','launcherUrl'].includes(key)))throw fail(400,'Account creation accepts only account, password, avatar and server address');
        const base=selectedBackend(input);
        if(typeof input.account!=='string'||!/^[A-Za-z0-9_.-]{1,24}$/.test(input.account))throw fail(400,'Account must use 1–24 letters, digits, dot, underscore or hyphen');
        if(typeof input.password!=='string'||!/^[\x20-\x7e]{1,24}$/.test(input.password))throw fail(400,'Password must use 1–24 printable ASCII characters');
        if(typeof input.avatar!=='string'||!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,28}$/.test(input.avatar))throw fail(400,'Avatar must use 1–29 letters, digits, spaces, dot, underscore or hyphen and start with a letter or digit');
        const capability=await capabilities(base);
        if(!capability.registration.enabled)throw fail(403,'Account creation is disabled on this WorldsAway.app server');
        const body=new URLSearchParams({account:input.account,password:input.password,avatar:input.avatar});
        const raw=await boundedText(new URL('/api/register',base),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},{...trustedOptions(base),jsonErrors:true});
        let registration;try{registration=JSON.parse(raw);}catch{throw fail(502,'The server created the account but returned an invalid response. Sign in with your new account.');}
        const created={account:{name:input.account},avatar:{name:input.avatar},capacity:registration.capacity};
        const item=newSession();
        try{
          const source={launcherUrl:base,account:input.account,password:input.password,avatar:input.avatar};
          const launcherOptions={trustedLauncherUrl:base};
          const connection=await launcherConnection(source,launcherOptions);
          item.launcher=source;item.launcherOptions=launcherOptions;
          const state=await item.connect(connection);
          const previous=session(req,false);previous?.close();if(previous)sessions.delete(previous.id);
          sessions.set(item.id,item);
          return respond(res,201,{created,sessionId:item.id,state},{'set-cookie':sessionCookie(item.id)});
        }catch(error){item.close();return respond(res,502,{error:'Your account was created, but the world connection could not be completed. Use Sign in with the account and password you just chose.',accountCreated:true,created});}
      }
      if(pathname==='/api/reconnect'&&method==='POST'){const input=await jsonBody(req);const item=session(req);const state=await item.reconnect(input);return respond(res,200,{sessionId:item.id,state});}
      if(pathname==='/api/enter'&&method==='POST'){
        const input=await jsonBody(req);const state=await session(req).enter(input.avatar??input.name,input.region);return respond(res,200,{state});
      }
      if(pathname==='/api/action'&&method==='POST'){const input=await jsonBody(req);return respond(res,200,session(req).action(input as unknown as import('./types.js').NativeAction));}
      if(pathname==='/api/tcl/status'&&method==='GET')return respond(res,200,session(req).tcl!.model);
      if(pathname.startsWith('/api/tcl/')&&method==='POST'){
        const input=await jsonBody(req),item=session(req);if(item.state.status!=='connected')throw fail(409,'Enter an avatar before running world Tcl');
        if(pathname==='/api/tcl/run'){const task=await item.tcl!.run(input.script,{noid:input.noid??item.state.actorNoid});return respond(res,200,{taskId:task.taskId});}
        if(pathname==='/api/tcl/method'){const task=await item.tcl!.method(input.noid,input.messageId,input.fields??{});return respond(res,200,{taskId:task.taskId});}
        if(pathname==='/api/tcl/presentation'){const task=await item.tcl!.presentation(input.noid,input.which??1,input.ad??{});return respond(res,200,{taskId:task.taskId});}
        if(pathname==='/api/tcl/reply')return respond(res,200,{accepted:item.tcl!.replyEffect(input.id,input)});
        if(pathname==='/api/tcl/callback')return respond(res,200,await item.tcl!.callback(input));
        if(pathname==='/api/tcl/cancel'){item.tcl!.cancel(input.taskId);return respond(res,200,{cancelled:true});}
      }
      if(pathname==='/api/logout'&&method==='POST'){
        await jsonBody(req);const item=session(req,false);item?.close();if(item)sessions.delete(item.id);return respond(res,200,{loggedOut:true},{'set-cookie':`${sessionCookie('')}; Max-Age=0`});
      }
      if(pathname==='/api/avatars'&&method==='POST'){
        const input=await jsonBody(req),item=session(req);if(input.action!=='create')throw fail(400,'AltAway does not expose a recovered avatar deletion operation');
        if(item.state.status!=='avatars')throw fail(409,'Avatar creation is available at the avatar chooser');
        const source=item.launcher?{...item.launcher}:null;
        let worldsAway=false;
        if(source){try{await capabilities(source.launcherUrl??defaultLauncher);worldsAway=true;}catch{}}
        if(source&&worldsAway){
          const endpoint=new URL('/api/avatars',source.launcherUrl!);
          const body=new URLSearchParams({account:source.account,password:source.password??'',action:'create',name:input.name});
          const created=await boundedText(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},{...item.launcherOptions,jsonErrors:true});
          const connection=await launcherConnection({...source,avatar:input.name},item.launcherOptions);
          const next=newSession();next.launcher=source;next.launcherOptions=item.launcherOptions;sessions.set(next.id,next);item.close();sessions.delete(item.id);
          try {const state=await next.connect(connection);return respond(res,200,{created:JSON.parse(created),state},{'set-cookie':sessionCookie(next.id)});}catch(error: any){next.close();sessions.delete(next.id);throw error;}
        }
        // Native WA's New Avatar button sends the entered name in 10/13.
        const state=await item.enter(input.name);return respond(res,200,{state});
      }
      if(pathname==='/api/resource'&&method==='GET'){
        const idText=url.searchParams.get('id');const id=Number(idText);if(!/^(?:0x[0-9a-f]+|\d+)$/i.test(idText??'')||!Number.isInteger(id))throw fail(400,'Invalid resource ID');
        const entry=session(req,false)?.getResource(id)??resources.getResource(id);if(!entry)throw fail(404,'Resource is not cached');
        return respond(res,200,entry.data,{'content-type':'application/octet-stream','x-resource-version':String(entry.version)});
      }
      if(pathname==='/api/asset'&&method==='GET'){
        const name=url.searchParams.get('name');
        if(!name||name.length>63||(!/^[\x20-\x7e]+$/.test(name)||/[\\/:]/.test(name))||name==='.'||name==='..')throw fail(400,'Invalid asset filename');
        const versionText=url.searchParams.get('version');const version=versionText===null?undefined:Number(versionText);
        if(version!==undefined&&(!/^\d+$/.test(versionText ?? '')||!Number.isInteger(version)||version<0||version>0xffffffff))throw fail(400,'Invalid asset version');
        const item=session(req,false),local=resources.getFileInfo(name);
        let data=item?item.getFile(name,version):local&&(version===undefined||local.version===version)?local.data:null;
        if(!data&&item)data=await item.fetchFile(name,version) ?? null;if(!data)throw fail(404,'The requested asset version is not cached; connect to its world to retrieve it');
        return respond(res,200,data,{'content-type':mime[path.extname(name).toLowerCase()]??'application/octet-stream','cache-control':'private, max-age=3600'});
      }
      if(pathname.startsWith('/api/'))throw fail(404,'Unknown API endpoint');
      if(method!=='GET'&&method!=='HEAD')throw fail(405,'Use GET for application files');
      let relative;try{relative=decodeURIComponent(pathname);}catch{throw fail(400,'Malformed path');}
      // Decode before resolving and compare with a separator boundary; a sibling
      // directory whose name starts with staticDir is still outside the web root.
      const filename=path.resolve(staticDir,'.'+(relative==='/'?'/index.html':relative));
      if(filename!==staticDir&&!filename.startsWith(staticDir+path.sep))throw fail(403,'Path is outside the application');
      let info;try{info=await stat(filename);}catch{throw fail(404,'File not found');}if(!info.isFile()||info.size>32*1024*1024)throw fail(404,'File not found');
      const data=await readFile(filename);
      respond(res,200,method==='HEAD'?Buffer.alloc(0):data,{'content-type':mime[path.extname(filename)]??'application/octet-stream','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'});
    }catch(error: any){if(!res.headersSent)respond(res,error.status??400,{error:error.message});else res.end();}
  }
  const server=http.createServer({maxHeaderSize:16384},handle);server.requestTimeout=30000;server.headersTimeout=10000;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const janitor=setInterval(()=>{for(const [id,item]of sessions)if(Date.now()-item.lastAccess>item.idleMs){item.close();sessions.delete(id);}},60000);janitor.unref();
  return {server,sessions,resources,registry,config,get baseUrl(){return baseUrl;},async start(){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4173,host,()=>{server.off('error',reject);resolve();});});baseUrl=`http://${host==='::1'?'[::1]':host}:${(server.address() as AddressInfo).port}`;return this;},async close(){clearInterval(janitor);for(const item of sessions.values())item.close();sessions.clear();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));}};
}

async function main(){
  const options: BridgeOptions={};
  if(process.env.PORT){options.port=Number(process.env.PORT);if(!Number.isInteger(options.port)||options.port<0||options.port>65535)throw new Error('PORT must be 0..65535');}
  if(process.env.HOST)options.host=process.env.HOST;
  if(process.env.ALTAWAY_PUBLIC_ORIGIN)options.publicOrigin=process.env.ALTAWAY_PUBLIC_ORIGIN;
  if(process.env.WORLDSAWAY_BACKEND_URL)options.launcherUrl=process.env.WORLDSAWAY_BACKEND_URL;
  if(process.env.TCLSH)options.tcl={executable:path.resolve(process.env.TCLSH)};
  const argv=process.argv.slice(2);
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='--help'){console.log('WorldsAway Browser\n\nUsage: node dist/server/index.js [--port 4173] [--host 127.0.0.1] [--public-origin https://client.example.com] [--launcher-url http://127.0.0.1:8080] [--client-dir /path/to/AltAway] [--tclsh /path/to/tclsh8.6]\n\nThe bridge defaults to the WorldsAway.app server on loopback port8080. Public hosting requires an explicit HTTPS origin and uses its configured backend. Environment: PORT, HOST, ALTAWAY_PUBLIC_ORIGIN, WORLDSAWAY_BACKEND_URL, ALTAWAY_CLIENT_DIR, TCLSH. Run npm run tcl:setup to build the pinned Tcl runtime.');return;}
    const value=argv[++i];if(value===undefined)throw new Error(`Missing value for ${arg}`);
    if(arg==='--port'){options.port=Number(value);if(!Number.isInteger(options.port)||options.port<0||options.port>65535)throw new Error('Port must be 0..65535');}
    else if(arg==='--launcher-url')options.launcherUrl=value;
    else if(arg==='--host')options.host=value;
    else if(arg==='--public-origin')options.publicOrigin=value;
    else if(arg==='--client-dir')options.clientDir=path.resolve(value);
    else if(arg==='--tclsh')options.tcl={executable:path.resolve(value)};
    else throw new Error(`Unknown option ${arg}`);
  }
  const app=createBridgeServer(options);await app.start();console.log(`AltAway Browser is ready at ${app.baseUrl}\n${app.config.classCount} class schemas and ${app.config.fileAssets} cached assets available.`);
  const stop=async()=>{await app.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
