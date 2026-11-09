import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBridgeServer} from '../../dist/server/index.js';
import {ResourceStore} from '../../dist/native/resources.js';
import {NativeSession} from '../../dist/server/session.js';

/** Raw HTTP preserves encoded traversal paths and lets us verify Host checks. */
function request(app,route,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const outgoing=http.request(app.baseUrl+route,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers}},response=>{
   const chunks=[];
   response.on('data',chunk=>chunks.push(chunk));
   response.on('error',reject);
   response.on('end',()=>{
    const data=Buffer.concat(chunks).toString('utf8');let json;
    try{json=JSON.parse(data);}catch{}
    resolve({status:response.statusCode,headers:response.headers,data,json});
   });
  });
  outgoing.on('error',reject);outgoing.end(body===undefined?undefined:JSON.stringify(body));
 });
}
async function setup(t,options={}) {
 const directory=await mkdtemp(join(tmpdir(),'altaway-portable-bridge-'));
 const resources=new ResourceStore({clientDir:directory,allowEmpty:true});
 const app=createBridgeServer({port:0,resources,...options});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 await app.start();return app;
}

test('empty-cache bridge serves the built application, checked JavaScript and disconnected API state',async t=>{
 const app=await setup(t);
 const config=await request(app,'/api/config');
 assert.equal(config.status,200);
 assert.equal(config.json.classCount,0);assert.equal(config.json.messageCount,0);assert.equal(config.json.fileAssets,0);
 assert.equal(config.json.requiresBridge,true);assert.equal(config.json.hosted,false);
 const state=await request(app,'/api/state');
 assert.equal(state.status,200);assert.deepEqual(state.json,{status:'disconnected',avatars:[],objects:[],history:[]});
 const classes=await request(app,'/api/classes');
 assert.equal(classes.status,200);assert.deepEqual(classes.json.classes,[]);assert.deepEqual(classes.json.messages,[]);
 const page=await request(app,'/');
 assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);
 assert.match(page.data,/type="module"[^>]*src="\/app\.js"/);
 assert.match(page.headers['content-security-policy'],/script-src 'self'/);
 const script=await request(app,'/app.js');
 assert.equal(script.status,200);assert.match(script.headers['content-type'],/^text\/javascript/);assert.match(script.data,/import /);
 const css=await request(app,'/style.css');assert.equal(css.status,200);assert.match(css.headers['content-type'],/^text\/css/);
 assert.equal((await request(app,'/app.ts')).status,404);
 assert.equal((await request(app,'/app.mjs')).status,404);
 assert.equal((await request(app,'/missing-file.js')).status,404);
});

test('health probes reveal no session state and only the exact GET endpoint bypasses host verification',async t=>{
 const app=await setup(t);
 const health=await request(app,'/healthz',{headers:{host:'infrastructure.example.test'}});
 assert.equal(health.status,200);assert.deepEqual(health.json,{ok:true,application:'AltAway Browser'});
 for(const [route,method]of [['/healthz?details=1','GET'],['/healthz','POST'],['/api/config','GET']]){
  assert.equal((await request(app,route,{method,headers:{host:'infrastructure.example.test'}})).status,403);
 }
});

test('same-origin restrictions and resource validation reject requests before creating a session',async t=>{
 const app=await setup(t);
 for(const headers of [{host:'attacker.example.test'},{origin:'https://attacker.example.test'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}]){
  assert.equal((await request(app,'/api/config',{headers})).status,403,JSON.stringify(headers));
 }
 assert.equal((await request(app,'/api/config',{method:'OPTIONS'})).status,405);
 for(const route of ['/api/asset?name=../private.txt','/api/asset?name=%2Fetc%2Fpasswd','/api/asset?name=safe.img&version=-1','/api/resource?id=not-an-id']){
  assert.equal((await request(app,route)).status,400,route);
 }
 assert.equal((await request(app,'/%2e%2e%2fpackage.json')).status,403);
 assert.equal((await request(app,'/%E0%A4%A')).status,400);
 assert.equal((await request(app,'/api/resource?id=1')).status,404);
 assert.equal((await request(app,'/api/events')).status,401);
 assert.equal(app.sessions.size,0);
});

test('local document navigation opens from another site while bridge APIs remain protected',async t=>{
 const app=await setup(t);
 const headers={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert.equal((await request(app,'/',{headers})).status,200);
 assert.equal((await request(app,'/index.html',{headers})).status,200);
 for(const route of ['/api/config','/api/state','/api/worlds','/app.js'])assert.equal((await request(app,route,{headers})).status,403);
});

test('hosted bridge requires HTTPS and rejects browser-selected login destinations before any network access',async t=>{
 const app=await setup(t,{publicOrigin:'https://client.example.test'});
 const headers={host:'client.example.test',origin:'https://client.example.test'};
 let upstreamCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{upstreamCalls++;throw new Error('Unexpected upstream access');});
 for(const body of [
  {mode:'direct',host:'127.0.0.1',worldPort:9000,account:'fixture',token:'fixture'},
  {launcherUrl:'https://other.example.test/',account:'fixture',password:'fixture'},
  {connectionFile:'[Connect Info]\nserveraddr=127.0.0.1'},
  {transport:'wstunnel',wsurl:'wss://other.example.test/'}
 ]){
  const response=await request(app,'/api/login',{method:'POST',headers,body});
  assert.equal(response.status,400);assert.match(response.json.error,/Hosted clients/);
 }
 assert.equal((await request(app,'/api/worlds?url=https%3A%2F%2Fother.example.test',{headers})).status,400);
 assert.equal(upstreamCalls,0);assert.equal(app.sessions.size,0);
 const config=await request(app,'/api/config',{headers});assert.equal(config.status,200);assert.equal(config.json.hosted,true);
 assert.equal((await request(app,'/api/config')).status,403);
 const resources=app.resources;
 assert.throws(()=>createBridgeServer({resources,host:'0.0.0.0'}),/loopback/);
 assert.throws(()=>createBridgeServer({resources,publicOrigin:'http://client.example.test'}),/HTTPS origin/);
 assert.throws(()=>createBridgeServer({resources,publicOrigin:'https://client.example.test/path'}),/HTTPS origin/);
});

test('fresh browser sessions decode login controls before the world supplies schemas',async t=>{
 const app=await setup(t);
 const session=new NativeSession({resources:app.resources});t.after(()=>session.close());
 assert.equal(session.registry.messages.size,0);
 const configuration=Buffer.alloc(16);
 session.receive({noid:10,id:10,payload:configuration});
 const avatars=Buffer.alloc(276);
 avatars.writeUInt16BE(1,2);avatars.writeUInt32BE(1,4);avatars.writeUInt32BE(3,8);
 avatars.write('Demo',18,'ascii');
 session.receive({noid:10,id:12,payload:avatars});
 assert.equal(session.state.status,'avatars');assert.equal(session.state.newAvatarAllowed,true);
 assert.equal(session.state.capacity,3);assert.deepEqual(session.state.avatars,[{name:'Demo',busy:false}]);
 const announcement=Buffer.alloc(8);announcement.writeUInt32BE(5,0);announcement.writeUInt32BE(250,4);
 session.receive({noid:10,id:16,payload:announcement});
 assert.equal(session.state.resources.total,5);assert.equal(session.state.resources.totalBytes,250);
 session.receive({noid:10,id:12,payload:Buffer.alloc(20)});
 assert.equal(session.state.status,'avatars');assert.equal(session.state.history.at(-1).type,'decode-error');
 assert.match(session.state.history.at(-1).fields.reason,/truncated or oversized/);
 session.receive({noid:10,id:15,payload:Buffer.from('Ticket expired\0')});
 assert.equal(session.state.status,'error');assert.equal(session.state.error,'Ticket expired');
});
