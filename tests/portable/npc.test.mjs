import test from 'node:test';
import assert from 'node:assert/strict';
import {NPCController,nativeNPCWalkCoordinates} from '../../dist/public/npc.js';
import {ApproachError,ApproachCancelledError} from '../../dist/public/approach.js';

const object=(noid,classNumber,position,extra={})=>({noid,classNumber,fields:{name:classNumber===200?'Guide':'Room',position,container_noid:0,common_flags:0,orientation:0,...extra}});
function fixture(){const region=object(0,20,[0,0,0],{horizon:70}),actor=object(16,21,[10,20,0]),npc=object(40,200,[200,200,0],{npc_flags:4});return {status:'connected',worldName:'Local',avatar:'Me',actorNoid:16,region,objects:[region,actor,npc],history:[]};}
const talk={id:20010,noid:40,fields:{text:'Hello'}};
function harness({walkFailure=false,faceFailure=false,clamped=false,automatic=true}={}){
 const state=fixture(),calls=[];let controller,seq=0;
 const reply=(body,{id=body.id===1570?1571:70,success=0,coords=body.fields.coords,requestId=body.id,noid=body.noid}={})=>{
  const result={success,fail_msg:success?'You may not move.':''};if(coords!==undefined)result.coords=coords;
  state.history.push({seq:++seq,type:'message',id,noid,requestId,fields:result});controller.ingestState(state);
 };
 const api=async(path,body)=>{
  calls.push(body);
  if(automatic&&(body.id===1570||body.id===1688))queueMicrotask(()=>{
   const success=body.id===1570&&walkFailure||body.id===1688&&faceFailure?16:0;
   const coords=body.id===1570?(clamped?[10,20,0]:body.fields.coords):undefined;
   if(!success){if(coords)state.objects[1].fields.position=coords;else state.objects[1].fields.orientation=body.fields.facing;}
   reply(body,{success,coords});
  });
  return {sent:true};
 };
 controller=new NPCController({api,getState:()=>state,timeout:200});
 return {state,calls,api,reply,controller};
}

test('NPC offsets use native doorWalkToCoords orientation and preserve raw coordinates',()=>{
 const target=fixture().objects[2];
 for(const [orientation,expected] of [[0,[200,150,0]],[1,[250,200,0]],[2,[200,250,0]],[3,[150,200,0]]]){
  target.fields.orientation=orientation;target.fields.common_flags=4;target.fields.position=[200,200,37];
  assert.deepEqual(nativeNPCWalkCoordinates(target),expected);
 }
 target.fields.position=[32760,200,0];target.fields.orientation=1;assert.throws(()=>nativeNPCWalkCoordinates(target),/coordinate range/);
 target.fields.position=[1,2];assert.throws(()=>nativeNPCWalkCoordinates(target),/walking position/);
 target.fields.position=[1,2,0];target.fields.orientation=4;assert.throws(()=>nativeNPCWalkCoordinates(target),/facing direction/);
});

test('standing NPC speech waits for walk and facing acknowledgements in every direction',async()=>{
 for(const orientation of [0,1,2,3]){
  const h=harness();h.state.objects[2].fields.orientation=orientation;h.state.objects[2].fields.common_flags=4;
  const prepared=await h.controller.perform(talk);assert.equal(prepared,talk);await h.api('/api/action',prepared);
  assert.deepEqual(h.calls.map(call=>call.id),[1570,1688,20010]);
  assert.equal(h.calls[0].noid,16);assert.deepEqual(h.calls[0].fields.coords,nativeNPCWalkCoordinates(h.state.objects[2]));
  assert.deepEqual(h.calls[1],{noid:16,id:1688,fields:{facing:(orientation+2)%4}});h.controller.destroy();
 }
});

test('native already-adjacent and seated paths send no preparatory walk or facing',async()=>{
 for(const seated of [false,true]){
  const h=harness();
  if(seated){h.state.objects[1].fields.container_noid=50;h.state.objects.push(object(50,53,[10,20,0]));}
  else h.state.objects[2].fields.position=[15,30,10];
  assert.equal(await h.controller.perform(talk),talk);assert.deepEqual(h.calls,[]);h.controller.destroy();
 }
});

test('Ghost, remote or non-NPC targets and unrelated actions remain server-authoritative without invented movement',async()=>{
 const h=harness();h.state.objects[1].classNumber=22;
 assert.equal(await h.controller.perform(talk),talk);
 h.state.objects[1].classNumber=21;
 for(const action of [{...talk,noid:999},{...talk,noid:0},{id:1616,noid:16,fields:{mood:1}}])assert.equal(await h.controller.perform(action),action);
 assert.deepEqual(h.calls,[]);h.controller.destroy();
});

test('failed walking or facing prevents the caller from sending NPC speech',async()=>{
 for(const option of [{walkFailure:true},{faceFailure:true}]){
  const h=harness(option);
  await assert.rejects(async()=>{await h.controller.perform(talk);await h.api('/api/action',talk);},ApproachError);
  assert.deepEqual(h.calls.map(call=>call.id),option.walkFailure?[1570]:[1570,1688]);h.controller.destroy();
 }
});

test('NPC wrapper accepts a successful clamped walk without inventing a post-walk adjacency requirement',async()=>{
 const h=harness({clamped:true});await h.controller.perform(talk);await h.api('/api/action',talk);
 assert.deepEqual(h.calls.map(call=>call.id),[1570,1688,20010]);h.controller.destroy();
});

test('the facing request reads NPC orientation after the successful walk',async()=>{
 const h=harness({automatic:false}),pending=h.controller.perform(talk);
 await new Promise(resolve=>setImmediate(resolve));h.state.objects[2].fields.orientation=3;h.reply(h.calls[0]);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls[1].fields,{facing:1});h.reply(h.calls[1]);
 await pending;h.controller.destroy();
});

test('stale, unrelated and wrong-request replies cannot advance NPC preparation',async()=>{
 const h=harness({automatic:false});h.state.history.push({seq:10,type:'message',id:1571,noid:16,requestId:1570,fields:{success:0,coords:[200,150,0]}});
 const pending=h.controller.perform(talk);await new Promise(resolve=>setImmediate(resolve));
 // Harness replies below have sequence 1..3, so all are stale even if their
 // other fields match. Explicitly append fresh wrong receiver/request replies.
 h.reply(h.calls[0]);
 for(const [seq,noid,requestId] of [[11,17,1570],[12,16,1575]])h.state.history.push({seq,type:'message',id:1571,noid,requestId,fields:{success:0,coords:[200,150,0]}});
 h.controller.ingestState(h.state);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,1);
 h.state.history.push({seq:13,type:'message',id:1571,noid:16,requestId:1570,fields:{success:0,coords:[200,150,0]}});h.controller.ingestState(h.state);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls[1].id,1688);
 h.state.history.push({seq:14,type:'message',id:70,noid:16,requestId:1688,fields:{success:0}});h.controller.ingestState(h.state);await pending;h.controller.destroy();
});

test('region standard reply 70 completes facing only with the exact actor and request correlation',async()=>{
 const h=harness({automatic:false});let completed=false;
 const pending=h.controller.perform(talk).then(item=>{completed=true;return item;});
 await new Promise(resolve=>setImmediate(resolve));h.reply(h.calls[0]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls[1].id,1688);
 const events=[
  {seq:2,type:'message',id:70,noid:0,requestId:1688,requestNoid:17,fields:{success:0}},
  {seq:3,type:'message',id:70,noid:0,requestId:1570,requestNoid:16,fields:{success:0}},
  {seq:4,type:'message',id:70,noid:0,requestNoid:16,fields:{success:0}},
  {seq:5,type:'message',id:70,noid:0,requestId:1688,fields:{success:0}},
 ];
 h.state.history.push(...events);h.controller.ingestState(h.state);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);
 h.state.history.push({seq:6,type:'message',id:70,noid:0,requestId:1688,requestNoid:16,fields:{success:0}});h.controller.ingestState(h.state);
 assert.equal(await pending,talk);assert.equal(completed,true);h.controller.destroy();
});

test('region/avatar changes, logout, NPC removal and newer operations cancel outstanding speech preparation',async()=>{
 for(const reason of ['region','avatar','logout','NPC left','new-operation']){
  const h=harness({automatic:false}),pending=h.controller.perform(talk),rejection=assert.rejects(pending,ApproachCancelledError);
  await new Promise(resolve=>setImmediate(resolve));
  if(reason==='region')h.state.region.fields.name='Next room';
  if(reason==='avatar')h.state.actorNoid=17;
  if(reason==='logout')h.state.status='disconnected';
  if(reason==='NPC left')h.state.objects=h.state.objects.filter(object=>object.noid!==40);
  if(reason==='new-operation')await h.controller.perform({id:76,noid:40});else h.controller.ingestState(h.state);
  await rejection;assert.deepEqual(h.calls.map(call=>call.id),[1570]);h.controller.destroy();
 }
});

test('timeout, malformed acknowledgements and invalid NPC positions never send facing or speech',async()=>{
 const h=harness({automatic:false});h.controller.timeout=5;
 await assert.rejects(()=>h.controller.perform(talk),/acknowledge NPC movement/);assert.deepEqual(h.calls.map(call=>call.id),[1570]);h.controller.destroy();
 const malformed=harness({automatic:false}),pending=malformed.controller.perform(talk);
 await new Promise(resolve=>setImmediate(resolve));malformed.reply(malformed.calls[0],{coords:[1,2]});await assert.rejects(pending,/walking destination/);assert.equal(malformed.calls.length,1);malformed.controller.destroy();
 const invalid=harness();invalid.state.objects[2].fields.position=[NaN,2,0];await assert.rejects(()=>invalid.controller.perform(talk),/walking position/);assert.deepEqual(invalid.calls,[]);invalid.controller.destroy();
});

test('destroying immediately cancels pending preparation before it can send a queued walk',async()=>{
 const h=harness({automatic:false}),pending=h.controller.perform(talk),rejection=assert.rejects(pending,ApproachCancelledError);
 h.controller.destroy();await rejection;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls,[]);
 await assert.rejects(()=>h.controller.perform(talk),ApproachCancelledError);
});
