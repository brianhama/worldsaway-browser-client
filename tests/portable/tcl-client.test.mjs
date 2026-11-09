import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldTcl} from '../../dist/public/tcl-client.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const effect=(id,name='redraw',taskId='task-a',args=[16])=>({id,name,args,status:'pending',context:{self:16,taskId}});
function state(effects=[],tasks=[],generation=0){
 const region={noid:0,classNumber:20,fields:{name:'Room',areaCode:0,position:[0,0,0]}};
 return {status:'connected',worldName:'Local',avatar:'Me',actorNoid:16,region,objects:[region,{noid:16,classNumber:21,fields:{name:'Me',position:[100,200,0],orientation:0,mood:0,common_flags:0}},{noid:17,classNumber:24,fields:{name:'Head',container_noid:16,position:[1,0,0],common_flags:0}}],tcl:{generation,effects,tasks,overrides:[],virtualObjects:[]}};
}
function fixture(t,{dispatch,api}={}){
 let current=state();const requests=[],calls=[],messages=[],errors=[],cancelled=[],dialogs=[];
 const client=new WorldTcl({getState:()=>current,api:async(route,body)=>{requests.push({route,body});return api?api(route,body):{accepted:true};},onMessage:message=>messages.push(message),onError:error=>errors.push(error)});
 // Construction has no DOM dependency. Render notifications remain structured
 // data in this lifecycle suite; the native dialog controls have separate tests.
 client.dialogs.render=model=>dialogs.push(model);
 const originalCancel=client.host.cancelTask.bind(client.host),originalDispatch=client.host.dispatch.bind(client.host);
 client.host.cancelTask=id=>{cancelled.push(id);return originalCancel(id);};
 client.host.dispatch=(name,args,context)=>{calls.push({name,args,context});return dispatch?dispatch(name,args,context):Promise.resolve(`value:${name}`);};
 t.after(()=>client.destroy());
 return {client,requests,calls,messages,errors,cancelled,dialogs,originalDispatch,update(next){current=next;client.ingestState(next);},get current(){return current;}};
}

test('scripted speech and thoughts reach the transcript without rendered speaker bounds',async t=>{
 const h=fixture(t),current=state();
 current.objects.find(object=>object.noid===16).fields.common_flags=1;
 h.update(current);
 let now=1000;h.client.host.now=()=>now++;
 for(const [noid,type,kind,author]of [[0,0,'say','Room'],[16,1,'think','Me']]){
  await h.originalDispatch('balloon',[noid,'Scripted words',type]);
  const message=h.messages.at(-1),speech=h.client.displayState(current).objects.find(object=>object.noid===noid).fields.presentationSpeech;
  assert.equal(message.kind,kind);assert.equal(message.author,author);
  assert.equal(message.speakerNoid,noid);assert.equal(message.text,'Scripted words');
  assert.equal(message.source,'presentation');
  assert.equal(message.presentationKey,`${speech.until}:${type}:Scripted words`,'direct callback and visual patch share one deduplication key');
 }
 assert.equal(h.messages.length,2);
 await h.originalDispatch('balloon',[0,'System notice',4]);
 assert.deepEqual(h.messages.at(-1),{kind:'system',author:'Room',text:'System notice'});
});

test('a pending effect batch dispatches once and returns structured visual updates for each result',async t=>{
 const h=fixture(t),effects=[effect('one'),effect('two','remove','task-b',[17]),effect('three','refresh','task-c',[])];
 h.client.host.visualUpdates=()=>[{noid:16,fields:{mood:2}}];h.update(state(effects));await flush();
 assert.deepEqual(h.calls.map(call=>call.name),['redraw','remove','refresh']);
 assert.deepEqual(h.requests,effects.map(item=>({route:'/api/tcl/reply',body:{id:item.id,value:`value:${item.name}`,overrides:[{noid:16,fields:{mood:2}}]}})));
 h.update(state(effects));await flush();assert.equal(h.calls.length,3);assert.equal(h.requests.length,3);assert.deepEqual(h.errors,[]);
});

test('world generation reset before the deferred batch runs prevents stale dispatch and stale link opening',async t=>{
 const h=fixture(t);h.update(state([effect('old-render'),effect('old-link','openURL','task-b',['https://example.com/old'])]));
 h.update(state([],[],1));await flush();assert.deepEqual(h.calls,[]);assert.deepEqual(h.requests,[]);assert.deepEqual(h.messages,[]);
 // IDs can be reused by a new world generation without inheriting handled state.
 h.update(state([effect('old-render')],[],1));await flush();assert.equal(h.calls.length,1);assert.equal(h.requests[0].body.id,'old-render');
});

test('an asynchronous visual result from an earlier generation cannot send a reply after the world resets',async t=>{
 const pending=deferred(),h=fixture(t,{dispatch:()=>pending.promise});h.update(state([effect('late-render')]));await flush();assert.equal(h.calls.length,1);
 h.update(state([],[],1));pending.resolve('old result');await flush();assert.deepEqual(h.requests,[]);assert.deepEqual(h.errors,[]);
});

test('an asynchronous visual rejection from an earlier generation cannot send an error reply or surface a stale error',async t=>{
 const pending=deferred(),h=fixture(t,{dispatch:()=>pending.promise});h.update(state([effect('late-error')]));await flush();
 h.update(state([],[],1));pending.reject(new Error('old renderer error'));await flush();assert.deepEqual(h.requests,[]);assert.deepEqual(h.errors,[]);
});

test('destroy before a batch runs prevents pending dispatch, openURL notifications and server replies',async t=>{
 const h=fixture(t);h.update(state([effect('render'),effect('link','openURL','task-b',['https://example.com/after-destroy'])]));h.client.destroy();await flush();
 assert.deepEqual(h.calls,[]);assert.deepEqual(h.messages,[]);assert.deepEqual(h.requests,[]);h.update(state([effect('later')],[],1));await flush();assert.deepEqual(h.calls,[]);
});

test('destroy while a visual operation is awaiting completion suppresses its late result or rejection',async t=>{
 for(const reject of [false,true]){
  const pending=deferred(),h=fixture(t,{dispatch:()=>pending.promise});h.update(state([effect(`waiting-${reject}`)]));await flush();h.client.destroy();
  reject?pending.reject(new Error('cancelled renderer')):pending.resolve('late');await flush();assert.deepEqual(h.requests,[]);assert.deepEqual(h.errors,[]);
 }
});

test('same-world task cancellation skips only that task before dispatch and forwards cancellation to its visual host',async t=>{
 const h=fixture(t),effects=[effect('a','redraw','task-a',[16]),effect('b','redraw','task-b',[17])];
 h.update(state(effects,[{id:'task-a',status:'running'},{id:'task-b',status:'running'}]));
 h.update(state(effects,[{id:'task-a',status:'cancelled'},{id:'task-b',status:'running'}]));await flush();
 assert.deepEqual(h.calls.map(call=>call.context.taskId),['task-b']);assert.deepEqual(h.requests.map(request=>request.body.id),['b']);assert.ok(h.cancelled.includes('task-a'));
 assert.equal(h.client.host.cancelledTasks.has('task-a'),true);assert.equal(h.client.host.cancelledTasks.has('task-b'),false);
});

test('same-world cancellation suppresses an already-dispatched task completion while another task continues',async t=>{
 const waiting=deferred(),h=fixture(t,{dispatch:(name,args,context)=>context.taskId==='task-a'?waiting.promise:'other complete'});
 const effects=[effect('a','redraw','task-a'),effect('b','redraw','task-b')];h.update(state(effects));await flush();assert.deepEqual(h.requests.map(request=>request.body.id),['b']);
 h.update(state(effects,[{id:'task-a',status:'cancelled'}]));waiting.resolve('stale complete');await flush();
 assert.deepEqual(h.requests.map(request=>request.body.id),['b']);assert.ok(h.cancelled.includes('task-a'));assert.deepEqual(h.errors,[]);
});

test('cancelled effect status suppresses a deferred result even without a separate task record',async t=>{
 const pending=deferred(),h=fixture(t,{dispatch:()=>pending.promise}),original=effect('cancelled-effect');h.update(state([original]));await flush();
 h.update(state([{...original,status:'cancelled'}]));pending.resolve('obsolete');await flush();assert.ok(h.cancelled.includes('task-a'));assert.deepEqual(h.requests,[]);
});

test('a completed or removed effect cannot receive a duplicate reply after its visual work finishes',async t=>{
 for(const removed of [false,true]){
  const pending=deferred(),h=fixture(t,{dispatch:()=>pending.promise}),original=effect(`terminal-${removed}`);h.update(state([original]));await flush();
  h.update(state(removed?[]:[{...original,status:'complete'}]));pending.resolve('old completion');await flush();assert.deepEqual(h.requests,[]);
 }
});

test('pending HTTP links remain inert data and unsafe schemes or embedded credentials return a native effect error',async t=>{
 const h=fixture(t);h.update(state([effect('valid','openURL','task-a',['https://example.com/path?q=one']),effect('unsafe','openURL','task-b',['javascript:alert(1)']),effect('credentials','openURL','task-c',['https://name:secret@example.com/'])]));await flush();
 assert.deepEqual(h.messages,[{kind:'system',author:'World link',text:'https://example.com/path?q=one',url:'https://example.com/path?q=one'}]);assert.deepEqual(h.calls,[]);
 assert.equal(h.requests.find(request=>request.body.id==='valid').body.value,'');
 for(const id of ['unsafe','credentials'])assert.match(h.requests.find(request=>request.body.id===id).body.error,/HTTP or HTTPS/);
 assert.deepEqual(h.errors,[]);
});

test('current effect failures return error data while a stale API failure does not surface after a reset',async t=>{
 const h=fixture(t,{dispatch:()=>Promise.reject(new Error('Renderer rejected frame'))});h.update(state([effect('invalid')]));await flush();assert.deepEqual(h.requests,[{route:'/api/tcl/reply',body:{id:'invalid',error:'Renderer rejected frame'}}]);assert.deepEqual(h.errors,[]);
 const waiting=deferred(),late=fixture(t,{api:()=>waiting.promise});late.update(state([effect('reply-in-flight')]));await flush();assert.equal(late.requests.length,1);
 late.update(state([],[],1));waiting.reject(new Error('stale network failure'));await flush();assert.deepEqual(late.errors,[]);
});

test('current reply API failures surface once through the client error callback',async t=>{
 const h=fixture(t,{api:()=>Promise.reject(new Error('Reply endpoint unavailable'))});h.update(state([effect('api-error')]));await flush();
 assert.equal(h.errors.length,1);assert.match(h.errors[0].message,/Reply endpoint unavailable/);h.update(state([effect('api-error')]));await flush();assert.equal(h.errors.length,1);
});

test('display state merges server Tcl patches, virtual objects and browser overlays without changing authoritative objects',async t=>{
 const h=fixture(t),next=state();next.tcl.overrides=[{noid:16,fields:{mood:2}},{noid:60000,fields:{name:'Virtual changed'}}];next.tcl.virtualObjects=[{noid:60000,classNumber:36,fields:{name:'Virtual original',position:[0,0,0]}}];
 h.update(next);await h.originalDispatch('@obj',[16,'position',[123,200,0]]);const shown=h.client.displayState(next);
 assert.equal(shown.objects.find(object=>object.noid===16).fields.mood,2);assert.deepEqual(shown.objects.find(object=>object.noid===16).fields.position,[123,200,0]);assert.equal(shown.objects.find(object=>object.noid===60000).fields.name,'Virtual changed');
 assert.equal(next.objects.find(object=>object.noid===16).fields.mood,0);assert.deepEqual(next.objects.find(object=>object.noid===16).fields.position,[100,200,0]);assert.equal(next.objects.some(object=>object.noid===60000),false);
});

test('run, presentation and cancellation retain their explicit bridge API argument shapes',async t=>{
 const h=fixture(t);await h.client.run('set x 1',16);await h.client.presentation(60,2,{text:'0 puts hello'});await h.client.cancel('task-a');
 assert.deepEqual(h.requests,[{route:'/api/tcl/run',body:{script:'set x 1',noid:16}},{route:'/api/tcl/presentation',body:{noid:60,which:2,ad:{text:'0 puts hello'}}},{route:'/api/tcl/cancel',body:{taskId:'task-a'}}]);
});
