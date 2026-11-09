import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeRequest,prepareLogin} from '../../dist/public/connection.js';

const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});

test('login recovers a legacy directory transport failure before sending credentials once',async()=>{
  const calls=[],input={mode:'launcher',launcherUrl:'https://altaway.xyz/',world:'Demo World(WS)',account:'player',password:'private-password'};
  const fetchRequest=async(path,options)=>{
    calls.push({path,options});
    if(calls.length===1)return reply({error:'fetch failed'},400);
    if(path.startsWith('/api/worlds?'))return reply({worlds:[{name:'Demo World',loginUrl:'https://altaway.xyz/login.php',flags:'d'},{name:'Demo World(WS)',loginUrl:'https://altaway.xyz/login.php',flags:'w'}]});
    return reply({state:{status:'avatars'}});
  };
  const request=(path,data)=>bridgeRequest(path,data,fetchRequest);
  const result=await request('/api/login',await prepareLogin(input,request));
  assert.equal(result.state.status,'avatars');
  assert.equal(calls.length,3);
  assert(calls.slice(0,2).every(call=>call.options.body===undefined&&!call.path.includes(input.password)));
  const post=JSON.parse(calls[2].options.body);
  assert.equal(post.loginUrl,'https://altaway.xyz/login.php');assert.equal(post.tunnel,true);assert.equal(post.password,input.password);
  assert.equal(calls[2].options.method,'POST');assert.equal(calls[2].options.credentials,'same-origin');
});

test('credential submissions and actions are never retried after an upstream error',async()=>{
  for(const path of ['/api/login','/api/action']){
    let calls=0;
    await assert.rejects(bridgeRequest(path,{password:'secret'},async()=>{calls++;return reply({error:'fetch failed'},400);}),path==='/api/login'?/world's login service/:/fetch failed/);
    assert.equal(calls,1);
  }
});

test('a local bridge network failure is distinct and never leaks the underlying URL or credentials',async()=>{
  let calls=0;
  await assert.rejects(bridgeRequest('/api/login',{password:'secret'},async()=>{calls++;throw new TypeError('secret at https://user:secret@example.com/?key=secret');}),error=>/browser bridge/.test(error.message)&&!error.message.includes('secret'));
  assert.equal(calls,1);
});

test('directory recovery is bounded and does not repeat explicit launcher rejections',async()=>{
  for(const [message,expectedCalls]of [['fetch failed',2],['Launcher returned HTTP 403',1],['World directory TLS verification failed for altaway.xyz',1]]){
    let calls=0;
    await assert.rejects(bridgeRequest('/api/worlds?url=https%3A%2F%2Faltaway.xyz',undefined,async()=>{calls++;return reply({error:message},400);}),message==='fetch failed'?/world's directory/:new RegExp(message));
    assert.equal(calls,expectedCalls);
  }
});

test('direct tickets bypass directory lookup and an empty directory prevents a login POST',async()=>{
  const ticket={mode:'direct',token:'one-time'};
  assert.equal(await prepareLogin(ticket,()=>assert.fail('No directory request for direct tickets')),ticket);
  await assert.rejects(prepareLogin({mode:'launcher'},async path=>{assert(path.startsWith('/api/worlds?'));return {worlds:[]};}),/world directory/);
});

test('an invalid bridge response has an actionable error',async()=>{
  await assert.rejects(bridgeRequest('/api/login',{},async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError();}})),/invalid response \(HTTP 200\)/);
});
