import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBridgeServer} from '../../dist/server/index.js';
import {NativeSession,boundedText} from '../../dist/server/session.js';
import {ResourceStore} from '../../dist/native/resources.js';

const capability={application:'WorldsAway.app',registration:{enabled:true,endpoint:'/api/register'}};
const publicOrigin='https://client.example.test';
const backend='http://world.railway.internal:8080';
function request(app,route,{body,headers={},method=body===undefined?'GET':'POST'}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request(app.baseUrl+route,{method,headers:{...(app.config.hosted?{host:'client.example.test'}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,json,text});});
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
}
async function setup(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'worldsaway-register-bridge-'));
 const resources=new ResourceStore({clientDir:directory,allowEmpty:true});
 const app=createBridgeServer({port:0,host:'127.0.0.1',resources,...options});await app.start();
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});return app;
}
function upstream(t,{registrationStatus=201,registrationBody,enabled=true,identity='WorldsAway.app',connectionFailure=false}={}){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(target,options={})=>{
  const url=new URL(target);calls.push({url:url.href,method:options.method??'GET',body:options.body,headers:options.headers});
  assert.equal(url.origin,backend,'Only the configured backend receives requests');
  if(url.pathname==='/api/capabilities')return Response.json({...capability,application:identity,registration:{...capability.registration,enabled}});
  if(url.pathname==='/api/register')return new Response(registrationBody??JSON.stringify({application:'WorldsAway.app',account:{name:'alice'},avatar:{name:'Alice'},capacity:3}),{status:registrationStatus});
  if(url.pathname==='/worlds3.php')return new Response('WorldsAway.app|http://other-private.internal/login|wa32.exe||\r\n');
  if(url.pathname==='/login')return new Response('[Message]\r\nmessagetype=Connect\r\n[Connect Info]\r\nworldname=WorldsAway.app\r\nserveraddr=127.0.0.1\r\nloginport=1701\r\nrpcport=1702\r\nacctname=alice\r\navatarname=Alice\r\nonetimepass=one-time-ticket\r\nloginregion=1\r\n');
  assert.fail(`Unexpected endpoint ${url.pathname}`);
 });
 t.mock.method(NativeSession.prototype,'connect',async function(connection){
  if(connectionFailure)throw new Error('private socket diagnostic');
  this.connection={...connection};this.state={...this.state,status:'connected',avatar:connection.avatar,worldName:'WorldsAway.app'};return this.snapshot();
 });
 return calls;
}
const registration={account:'alice',password:'private-password',avatar:'Alice'};

test('WorldsAway.app is the default backend and registration configuration follows server capability',async t=>{
 const app=await setup(t);assert.equal(app.config.launcherUrl,'http://127.0.0.1:8080');assert.equal(app.config.backendName,'WorldsAway.app');
 const configured=await setup(t,{launcherUrl:backend,publicOrigin});const calls=upstream(t,{enabled:false});
 const response=await request(configured,'/api/config');assert.equal(response.status,200);assert.equal(response.json.registrationEnabled,false);
 assert.equal(response.json.backendName,'WorldsAway.app');assert.equal(calls.length,1);
});

test('hosted registration creates the account once and enters its avatar with a private secure session',async t=>{
 const app=await setup(t,{launcherUrl:backend,publicOrigin}),calls=upstream(t);
 const response=await request(app,'/api/register',{body:registration});
 assert.equal(response.status,201,response.text);assert.equal(response.json.state.status,'connected');assert.equal(response.json.state.avatar,'Alice');
 assert.equal(response.json.created.account.name,'alice');assert.equal(app.sessions.size,1);
 assert.match(response.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);assert.match(response.headers['set-cookie'][0],/; Secure/);
 assert.deepEqual(calls.map(call=>new URL(call.url).pathname),['/api/capabilities','/api/register','/worlds3.php','/login']);
 const sent=Object.fromEntries(calls[1].body);assert.deepEqual(sent,registration);
 assert.equal(calls.filter(call=>new URL(call.url).pathname==='/api/register').length,1);
 assert(!response.text.includes(registration.password));assert(!response.text.includes('one-time-ticket'));
 const session=[...app.sessions.values()][0];assert.equal(session.launcher.password,registration.password);
 const cookie=response.headers['set-cookie'][0].split(';')[0];await request(app,'/api/logout',{body:{},headers:{cookie}});
 assert.equal(session.launcher.password,undefined);
});

test('registration rejects wrong destinations, privilege fields, origins and invalid identifiers before upstream access',async t=>{
 const app=await setup(t,{launcherUrl:backend,publicOrigin});let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;assert.fail('No upstream request');});
 for(const body of [
  {...registration,launcherUrl:'http://attacker.internal:8080'},
  {...registration,role:'admin'},{...registration,capacity:8},{...registration,host:'127.0.0.1'},
  {...registration,account:'bad account'},{...registration,password:'x'.repeat(25)},{...registration,avatar:' bad'},
 ])assert.equal((await request(app,'/api/register',{body})).status,400);
 assert.equal((await request(app,'/api/register',{body:registration,headers:{origin:'https://attacker.example'}})).status,403);
 assert.equal(calls,0);assert.equal(app.sessions.size,0);
});

test('failed or disabled account creation preserves an existing session and never retries a registration POST',async t=>{
 const app=await setup(t,{launcherUrl:backend,publicOrigin});const previous=new NativeSession({resources:app.resources});app.sessions.set(previous.id,previous);
 const calls=upstream(t,{registrationStatus:409,registrationBody:'Account already exists'});
 const response=await request(app,'/api/register',{body:registration,headers:{cookie:`altaway_browser_session=${previous.id}`}});
 assert.equal(response.status,409);assert.match(response.json.error,/already exists/);assert.equal(previous.closed,false);assert.equal(app.sessions.get(previous.id),previous);
 assert.equal(calls.filter(call=>new URL(call.url).pathname==='/api/register').length,1);
});

test('a completed registration with failed native entry offers sign-in recovery without replacing the previous session',async t=>{
 const app=await setup(t,{launcherUrl:backend,publicOrigin}),calls=upstream(t,{connectionFailure:true});
 const previous=new NativeSession({resources:app.resources});app.sessions.set(previous.id,previous);
 const response=await request(app,'/api/register',{body:registration,headers:{cookie:`altaway_browser_session=${previous.id}`}});
 assert.equal(response.status,502);assert.equal(response.json.accountCreated,true);assert.match(response.json.error,/Use Sign in/);
 assert.equal(previous.closed,false);assert.equal(app.sessions.size,1);assert.equal(calls.filter(call=>new URL(call.url).pathname==='/api/register').length,1);
 assert(!response.text.includes(registration.password));assert(!response.text.includes('private socket diagnostic'));
});

test('capability identity and registration policy are checked before forwarding credentials',async t=>{
 for(const options of [{enabled:false},{identity:'Another application'}]){
  const app=await setup(t,{launcherUrl:backend,publicOrigin}),calls=upstream(t,options);
  const response=await request(app,'/api/register',{body:registration});assert([400,403].includes(response.status));
  assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);
 }
});

test('private HTTP destinations require a server-only trusted backend option',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('ok');});
 await assert.rejects(boundedText('http://other.internal:8080/login'),/requires HTTPS/);
 await assert.rejects(boundedText('http://other.internal:8080/login',{},{trustedLauncherUrl:backend}),/requires HTTPS/);
 assert.equal(calls,0);
 assert.equal(await boundedText(backend+'/login',{},{trustedLauncherUrl:backend}),'ok');assert.equal(calls,1);
});
