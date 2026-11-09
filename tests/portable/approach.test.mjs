import test from 'node:test';
import assert from 'node:assert/strict';
import {ObjectApproach,ApproachError,ApproachCancelledError,nativeDepth,nativeOuterContainer,nativeWalkCoordinates,nativeGroundWalkRequest,nativeObjectWalkRequest,nativeAdjacent,nativeApproachTargets,NATIVE_APPROACH_REQUESTS} from '../../dist/public/approach.js';
const object=(noid,classNumber,name,position,parent=0,extra={})=>({noid,classNumber,fields:{name,position,container_noid:parent,common_flags:0,...extra}});
function fixture(){const region=object(0,20,'Room',[0,0,0],0,{horizon:70}),actor=object(16,21,'Me',[10,20,0]),machine=object(40,57,'Vendroid',[200,200,0],0,{common_flags:2});return {status:'connected',worldName:'Local',avatar:'Me',region,actorNoid:16,objects:[region,actor,machine],history:[]};}
function harness({result='success',seated=false}={}){
 const state=fixture(),calls=[];let seq=0,controller;
 if(seated){state.objects[1].fields.container_noid=50;state.objects[1].fields.position=[0,0,0];state.objects.push(object(50,53,'Seat',[10,20,0]));}
 const api=async(path,body)=>{
  calls.push(body);
  if(body.id===1570||body.id===2405)queueMicrotask(()=>{
   const stand=body.id===2405,coords=stand?[10,20,0]:result==='clamped'?[10,20,0]:result==='native-clamped'?body.fields.coords.map((value,index)=>index===1?Math.min(511,value):index===2?0:value):body.fields.coords;
   const success=result==='denied'?16:0;
   if(!success){state.objects[1].fields.position=coords;if(stand)state.objects[1].fields.container_noid=0;}
   state.history.push({seq:++seq,type:'message',id:stand?2406:1571,noid:body.noid,requestId:body.id,fields:{success,coords,fail_msg:success?'You may not walk.':''}});controller.ingestState(state);
  });
  return {sent:true};
 };
 controller=new ObjectApproach({api,getState:()=>state,timeout:200});
 return {state,calls,api,controller};
}

test('native adjacency uses exact inclusive 5/10/10 coordinate thresholds',()=>{
 const state=fixture(),actor=state.objects[1],target=state.objects[2];
 target.fields.position=[15,30,10];assert.equal(nativeAdjacent(actor,target,state),true);
 for(const point of [[16,30,10],[15,31,10],[15,30,11]]){target.fields.position=point;assert.equal(nativeAdjacent(actor,target,state),false);}
});

test('walking uses the outer container and native absolute-Y signed projection',()=>{
 const state=fixture(),container=object(50,36,'Display',[200,21,45],0,{common_flags:4}),item=object(51,27,'Item',[0,0,0],50);state.objects.push(container,item);
 assert.equal(nativeOuterContainer(item,state),container);
 assert.deepEqual(nativeWalkCoordinates(item,state),[200,153,0]);
 assert.equal(nativeDepth(70,-21),-153);assert.equal(nativeDepth(0,21),153);
 const held=object(52,27,'Held',[0,0,0],16);state.objects.push(held);
 assert.equal(nativeAdjacent(state.objects[1],held,state),true);
});

test('ground walks use captured floor coordinates without requiring an object walking position',()=>{
 const state=fixture(),point=[321,456,0];state.objects[2].fields.position=null;
 assert.deepEqual(nativeGroundWalkRequest(point,state),{id:1570,noid:16,fields:{coords:[321,456,0]}});
 const request=nativeGroundWalkRequest(point,state);point[0]=100;
 assert.deepEqual(request.fields.coords,[321,456,0],'the captured destination is copied');
 assert.deepEqual(nativeGroundWalkRequest([-32768,32767,0],state).fields.coords,[-32768,32767,0]);
 assert.throws(()=>nativeObjectWalkRequest(state.objects[2],state),/valid native walking position/);
});

test('ground walks reject malformed, nonfloor and out of range coordinates',()=>{
 const state=fixture();
 for(const coords of [undefined,null,{},[],[1,2],[1,2,0,4],[,,0],[1.1,2,0],[NaN,2,0],[1,Infinity,0],[32768,2,0],[-32769,2,0],[1,-32769,0],[1,2,1],[1,2,-1],['1',2,0]])
  assert.throws(()=>nativeGroundWalkRequest(coords,state),/valid ground walking destination/);
});

test('ground and object walks share connection, actor, permission and world UI validation',()=>{
 for(const change of [{status:'disconnected'},{actorNoid:null},{actorNoid:999},{permissions:{flags:0}},{tcl:{blockCount:1}}]){
  const state={...fixture(),...change};
  assert.throws(()=>nativeGroundWalkRequest([100,200,0],state),ApproachError);
  assert.throws(()=>nativeObjectWalkRequest(state.objects[2],state),ApproachError);
 }
 for(const classNumber of [22,40]){
  const state=fixture();state.objects[1].classNumber=classNumber;
  assert.throws(()=>nativeGroundWalkRequest([100,200,0],state),/Materialize/);
  assert.throws(()=>nativeObjectWalkRequest(state.objects[2],state),/Materialize/);
 }
 const state=fixture();state.actorNoid=15;state.objects[1].noid=15;
 assert.throws(()=>nativeGroundWalkRequest([100,200,0],state),/Materialize/);
});

test('required wrapper targets are explicit and generic staff/chat/movement are excluded',()=>{
 const state=fixture();
 assert.deepEqual(nativeApproachTargets({id:1575,noid:16,fields:{item:40}},state),[40]);
 assert.deepEqual(nativeApproachTargets({id:1608,noid:16,fields:{item:40}},state),[40]);
 assert.deepEqual(nativeApproachTargets({id:85,noid:41,fields:{container:40,in_pocket:0}},state),[40]);
 assert.deepEqual(nativeApproachTargets({command:'document',noid:41},state),[41]);
 for(const id of [72,109,1570,1616,165,194,205,210,21006,21009,21306,21309,30006])assert.deepEqual(nativeApproachTargets({id,noid:40},state),[],String(id));
 assert.ok(NATIVE_APPROACH_REQUESTS.includes(2675));
});

test('purchase is dispatched only after a successful acknowledged native walk',async()=>{
 const h=harness(),buy={id:2675,noid:40,fields:{slot:0}};
 await h.controller.perform(buy);await h.api('/api/action',buy);
 assert.deepEqual(h.calls.map(call=>call.id),[1570,2675]);
 assert.deepEqual(h.calls[0],{noid:16,id:1570,fields:{coords:[200,200,0]}});
 h.controller.destroy();
});

test('failed movement prevents the caller from spending or operating',async()=>{
 const h=harness({result:'denied'}),buy={id:2675,noid:40,fields:{slot:0}};
 await assert.rejects(async()=>{await h.controller.perform(buy);await h.api('/api/action',buy);},ApproachError);
 assert.deepEqual(h.calls.map(call=>call.id),[1570]);h.controller.destroy();
});

test('owned inventory, adjacent objects, remote targets, and Ghosts do not trigger invented walking',async()=>{
 const h=harness(),book=object(50,37,'Book',[0,0,0],16);h.state.objects.push(book);
 await h.controller.perform({command:'document',noid:50});
 h.state.objects[2].fields.position=[15,30,10];await h.controller.perform({id:2675,noid:40,fields:{slot:0}});
 await h.controller.perform({id:2675,noid:999,fields:{slot:0}});
 h.state.objects[1].classNumber=22;h.state.objects[2].fields.position=[200,200,0];await h.controller.perform({id:2675,noid:40,fields:{slot:0}});
 assert.deepEqual(h.calls,[]);h.controller.destroy();
});

test('a seated physical avatar stands successfully before approaching a device',async()=>{
 const h=harness({seated:true});await h.controller.perform({id:2675,noid:40,fields:{slot:0}});
 assert.deepEqual(h.calls.map(call=>call.id),[2405,1570]);assert.equal(h.calls[0].noid,50);assert.equal(h.calls[1].noid,16);h.controller.destroy();
});

test('changing seats stands and walks before dispatching the prepared Sit request',async()=>{
 const h=harness({seated:true});h.state.objects[2].classNumber=53;
 const sit={id:2401,noid:40,fields:{spot:0,choreState:33,clothingChore:0}};
 await h.controller.perform(sit);await h.api('/api/action',sit);
 assert.deepEqual(h.calls.map(call=>call.id),[2405,1570,2401]);
 assert.equal(h.calls[0].noid,50);assert.equal(h.calls[2].noid,40);
 assert.equal(h.calls[2].fields.choreState,33);h.controller.destroy();
});

test('ground walks and room exits stand a seated avatar before the caller sends the final request',async()=>{
 for(const id of [1570,103]){
  const h=harness({seated:true}),item={id,noid:id===1570?16:0,fields:id===1570?{coords:[330,420,0]}:{exitDir:1}};
  assert.equal(await h.controller.perform(item),item);
  assert.deepEqual(h.calls.map(call=>call.id),[2405]);assert.equal(h.calls[0].noid,50);
  assert.equal(h.state.objects[1].fields.container_noid,0);
  await h.api('/api/action',item);assert.deepEqual(h.calls.map(call=>call.id),[2405,id]);
  assert.deepEqual(h.calls[1].fields,item.fields);h.controller.destroy();
 }
});

test('standing ground walks and exits do not invent extra standing or walking requests',async()=>{
 for(const id of [1570,103])for(const classNumber of [21,22]){
  const h=harness();h.state.objects[1].classNumber=classNumber;
  const item={id,noid:id===1570?16:0,fields:id===1570?{coords:[330,420,0]}:{exitDir:1}};
  assert.equal(await h.controller.perform(item),item);assert.deepEqual(h.calls,[]);h.controller.destroy();
 }
});

test('a failed, cancelled or superseded stand cannot release a ground walk or room exit',async()=>{
 for(const id of [1570,103]){
  const denied=harness({seated:true,result:'denied'}),item={id,noid:id===1570?16:0,fields:id===1570?{coords:[330,420,0]}:{exitDir:1}};
  await assert.rejects(async()=>{await denied.controller.perform(item);await denied.api('/api/action',item);},/may not walk/);
  assert.deepEqual(denied.calls.map(call=>call.id),[2405]);denied.controller.destroy();
  const cancelled=harness({seated:true}),pending=cancelled.controller.perform(item),rejected=assert.rejects(pending,ApproachCancelledError);
  cancelled.controller.cancel();await rejected;assert.deepEqual(cancelled.calls,[]);cancelled.controller.destroy();
  const region=harness({seated:true});region.api=async(path,body)=>{region.calls.push(body);return {sent:true};};region.controller.api=region.api;
  const moving=region.controller.perform(item),changed=assert.rejects(moving,ApproachCancelledError);
  await new Promise(resolve=>setImmediate(resolve));region.state.region.fields.name='Another room';region.controller.ingestState(region.state);
  await changed;assert.deepEqual(region.calls.map(call=>call.id),[2405]);region.controller.destroy();
 }
});

test('Sit and device operations follow successful native walk acknowledgements when AltAway clamps coordinates',async()=>{
 for(const id of [2401,2675,300])for(const result of ['native-clamped','clamped']){
  const h=harness({result});if(id===2401)h.state.objects[2].classNumber=53;
  h.state.objects[2].fields.position=[403,556,-20];
  const item={id,noid:40,fields:id===2401?{spot:0,choreState:33,clothingChore:0}:id===2675?{slot:0}:{indirect:19,state:0,keycode:0xffffffff}};
  assert.equal(await h.controller.perform(item),item);await h.api('/api/action',item);
  assert.deepEqual(h.calls.map(call=>call.id),[1570,id]);
  assert.deepEqual(h.calls[0].fields.coords,[403,556,-20]);
  assert.deepEqual(h.state.objects[1].fields.position,result==='native-clamped'?[403,511,0]:[10,20,0]);h.controller.destroy();
 }
});

test('Sit and device operations still require a successful bounded native walk reply and a present target',async()=>{
 for(const id of [2401,2675])for(const coords of [undefined,[1,2],[1,NaN,0],[1,32768,0]]) {
  const state=fixture();if(id===2401)state.objects[2].classNumber=53;let controller;
  controller=new ObjectApproach({getState:()=>state,timeout:100,api:async(path,body)=>{queueMicrotask(()=>{state.history.push({seq:1,type:'message',id:1571,noid:body.noid,requestId:1570,fields:{success:0,coords}});controller.ingestState(state);});return {sent:true};}});
  await assert.rejects(()=>controller.perform({id,noid:40,fields:{spot:0}}),/valid walking destination/);controller.destroy();
 }
 const denied=harness({result:'denied'});denied.state.objects[2].classNumber=53;
 await assert.rejects(()=>denied.controller.perform({id:2401,noid:40,fields:{spot:0}}),/may not walk/);denied.controller.destroy();
 for(const id of [2401,2675]){
  const state=fixture();if(id===2401)state.objects[2].classNumber=53;let controller;
  controller=new ObjectApproach({getState:()=>state,timeout:100,api:async(path,body)=>{queueMicrotask(()=>{state.objects.pop();state.history.push({seq:1,type:'message',id:1571,noid:body.noid,requestId:1570,fields:{success:0,coords:[200,200,0]}});controller.ingestState(state);});return {sent:true};}});
  await assert.rejects(()=>controller.perform({id,noid:40,fields:{spot:0}}),/close enough/);controller.destroy();
 }
});

test('an older same-kind walk acknowledgement cannot release a newer Sit preparation',async()=>{
 const state=fixture();state.objects[2].classNumber=53;let release,completed=false;
 const controller=new ObjectApproach({getState:()=>state,timeout:100,api:()=>new Promise(resolve=>{release=resolve;})});
 const pending=controller.perform({id:2401,noid:40,fields:{spot:0}}).then(()=>{completed=true;});
 await new Promise(resolve=>setImmediate(resolve));
 state.history.push({seq:5,type:'message',id:1571,noid:16,requestId:1570,requestSeq:3,fields:{success:0,coords:[200,200,0]}});controller.ingestState(state);
 release({sent:true,seq:4});await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);
 state.history.push({seq:6,type:'message',id:1571,noid:16,requestId:1570,requestSeq:4,fields:{success:0,coords:[200,200,0]}});controller.ingestState(state);
 await pending;assert.equal(completed,true);controller.destroy();
});

test('region changes, logout and a newer operation cancel an outstanding approach',async()=>{
 for(const reason of ['region','logout','new-operation']){
  const state=fixture(),calls=[],controller=new ObjectApproach({api:async(path,body)=>{calls.push(body);return {sent:true};},getState:()=>state,timeout:200});
  const pending=controller.perform({id:2675,noid:40,fields:{slot:0}}),rejected=assert.rejects(pending,ApproachCancelledError);
  await new Promise(resolve=>setImmediate(resolve));
  if(reason==='region')state.region.fields.name='Other Room';else if(reason==='logout')state.status='disconnected';
  if(reason==='new-operation')await controller.perform({id:76,noid:40});else controller.ingestState(state);
  await rejected;assert.deepEqual(calls.map(call=>call.id),[1570]);controller.destroy();
 }
});

test('permission failure and missing acknowledgement never send the final operation',async()=>{
 const state=fixture(),calls=[];state.permissions={flags:0};
 let controller=new ObjectApproach({api:async(path,body)=>calls.push(body),getState:()=>state});
 await assert.rejects(()=>controller.perform({id:2675,noid:40}),/cannot walk/);assert.deepEqual(calls,[]);controller.destroy();
 delete state.permissions;controller=new ObjectApproach({api:async(path,body)=>{calls.push(body);return {sent:true};},getState:()=>state,timeout:5});
 await assert.rejects(()=>controller.perform({id:2675,noid:40}),/acknowledge movement/);assert.deepEqual(calls.map(call=>call.id),[1570]);controller.destroy();
});

test('malformed and cyclic containment cannot manufacture movement coordinates',()=>{
 const state=fixture(),a=object(50,36,'A',[0,0,0],51),b=object(51,36,'B',[0,0,0],50);state.objects.push(a,b);
 assert.throws(()=>nativeWalkCoordinates(a,state),/cycle/);
 assert.throws(()=>nativeWalkCoordinates(object(52,27,'Missing parent',[0,0,0],999),state),/not fully available/);
 assert.throws(()=>nativeWalkCoordinates(object(53,27,'Malformed',[NaN,0,0]),state),/valid native walking/);
});

test('native key and combination lock request 300 approaches the lock before dispatch',async()=>{
 const h=harness(),lock={id:300,noid:40,fields:{indirect:19,state:0,keycode:0xffffffff}};
 assert.deepEqual(nativeApproachTargets(lock,h.state),[40]);assert.ok(NATIVE_APPROACH_REQUESTS.includes(300));
 await h.controller.perform(lock);await h.api('/api/action',lock);
 assert.deepEqual(h.calls.map(call=>call.id),[1570,300]);h.controller.destroy();
});

test('immediate cancellation, replacement or destroy never sends a queued stand or walk',async()=>{
 for(const seated of [false,true])for(const reason of ['cancel','replace','destroy']){
  const h=harness({seated}),pending=h.controller.perform({id:2675,noid:40,fields:{slot:0}});
  const rejected=assert.rejects(pending,ApproachCancelledError);
  if(reason==='destroy')h.controller.destroy();
  else if(reason==='replace')await h.controller.perform({id:76,noid:40});
  else h.controller.cancel();
  await rejected;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls,[],`${reason} while ${seated?'standing':'walking'} was queued`);
  h.controller.destroy();
 }
});
