import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBannerAds,literalWords,parsePresentation,BannerPresentations} from '../../dist/public/presentations.js';
const colors=Array.from({length:16},(_,i)=>i).join(' ');
test('native six-field banner advertisements retain original image, state, palette and labels',()=>{const ads=parseBannerAds(`a.img|2|${colors}|Start here|Visit|https://example.com|b.img|0|${colors}|Play|Link|`);assert.equal(ads.length,2);assert.deepEqual(ads[0].colorMap,Array.from({length:16},(_,i)=>i));assert.equal(ads[1].imageURL,'b.img');assert.throws(()=>parseBannerAds('a.img|0|2'),/six fields/);});
test('literal presentation subset parses visual commands without Tcl substitution or executable source',()=>{assert.deepEqual(literalWords('psay {hello [exec ignored] $name}'),['psay','hello [exec ignored] $name']);const program=parsePresentation('0 psay {Hello}\n1 pimage o.new.img 2\n0.5 pmove {20 30 0}\n0 panim waving\n0 pturn 2\n0 exec malicious');assert.equal(program.commands.length,5);assert.equal(program.commands[2].at,1500);assert.deepEqual(program.commands[2].patch.position,[20,30,0]);assert.equal(program.unsupported.length,1);assert.throws(()=>parsePresentation('3601 psay hi'),/one hour/);});
test('banner scheduler changes only the local presentation and preserves authoritative objects',()=>{let now=1000;const client=new BannerPresentations({now:()=>now,api:async()=>{}});const original={noid:31,classNumber:61,fields:{banner_flags:1,interval:2,imageURL:'original.img'}};const state={status:'connected',worldName:'Local',avatar:'Demo',objects:[original],history:[{seq:1,type:'request',id:5605,noid:31,fields:{format:0}},{seq:2,type:'message',id:5606,noid:31,fields:{success:0,text:`a.img|0|${colors}|Start|Link||b.img|0|${colors}|Start|Link|`,currentAd:0,timeLeft:1}}]};try{client.ingestState(state);assert.equal(client.displayState(state).objects[0].fields.imageURL,'a.img');now=2100;client.tick();assert.equal(client.displayState(state).objects[0].fields.imageURL,'b.img');assert.equal(original.fields.imageURL,'original.img');}finally{client.destroy();}});

test('native movement and reward helpers parse exact literal parameters',()=>{
 const result=parsePresentation('0 pmoveAvatar {10 20 3}\n0 pmoveAdjacent 4 -5 0\n0 pmoveAdjacent\n0 pturnAvatar 2\n0 preward\n0 preward 3\n0 pmoveAvatar {$x 2 3}\n0 preward 0');
 assert.equal(result.commands.length,6);assert.equal(result.unsupported.length,2);
 assert.deepEqual(result.commands[0].patch.effect,{kind:'moveActor',coords:[10,20,3]});assert.deepEqual(result.commands[1].patch.effect,{kind:'moveAdjacent',coords:[4,-5,0]});assert.deepEqual(result.commands[2].patch.effect.coords,[0,0,0]);assert.equal(result.commands[3].patch.effect.direction,2);assert.equal(result.commands[4].patch.effect.slot,-1);assert.equal(result.commands[5].patch.effect.slot,3);
});

function effectsFixture({program,which=2,seated=false}={}){
 let now=1000,seq=2,client;const calls=[],messages=[];
 const banner={noid:31,classNumber:61,fields:{banner_flags:1,interval:10,imageURL:'original.img',position:[100,150,3],orientation:1,mood:2}},actor={noid:44,classNumber:21,fields:{container_noid:seated?70:0,position:[0,0,0],orientation:0}};
 const state={status:'connected',worldName:'Local',avatar:'Demo',actorNoid:44,region:{fields:{name:'Room'}},objects:[banner,actor,...(seated?[{noid:70,classNumber:53,fields:{}}]:[])],history:[{seq:1,type:'request',id:5605,noid:31,fields:{which,format:2}},{seq:2,type:'message',id:5606,noid:31,fields:{success:0,text:program}}]};
 const api=async(_path,body)=>{calls.push(body);if(body.id===5605)return {sent:true};queueMicrotask(()=>{
  let replyId,fields={success:0};if(body.id===1570){replyId=1571;fields.coords=body.fields.coords;actor.fields.position=[...body.fields.coords];}else if(body.id===1688){replyId=70;actor.fields.orientation=body.fields.facing;}else if(body.id===5675)replyId=80;else if(body.id===2405){replyId=2406;actor.fields.container_noid=0;fields.coords=[100,120,0];}
  state.history.push({seq:++seq,type:'request',...body},{seq:++seq,type:'message',noid:body.noid,id:replyId,requestId:body.id,fields});client.ingestState(state);
 });return {sent:true};};
 client=new BannerPresentations({api,getState:()=>state,now:()=>now,onMessage:message=>messages.push(message),effectTimeout:100});client.ingestState(state);
 return {client,state,calls,messages,setNow(value){now=value;},async flush(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('presentation movement, relative turning and rewards emit acknowledged native actions on schedule',async()=>{
 const f=effectsFixture({program:'0 pmoveAvatar {20 30 0}\n1 pturnAvatar 2\n1 pmoveAdjacent {5 -2 0}\n1 preward'});
 try{
  await f.flush();assert.deepEqual(f.calls.map(call=>[call.noid,call.id,call.fields]),[[44,1570,{coords:[20,30,0]}]]);
  f.setNow(2000);f.client.tick();await f.flush();assert.equal(f.calls[1].id,1688);assert.deepEqual(f.calls[1].fields,{facing:1});
  f.setNow(3000);f.client.tick();await f.flush();assert.deepEqual(f.calls[2].fields,{coords:[105,148,3]});
  f.setNow(4000);f.client.tick();await f.flush();assert.deepEqual(f.calls[3],{noid:31,id:5675,fields:{slot:1}});assert.equal(f.messages.length,0);
 }finally{f.client.destroy();}
});

test('move-avatar stands from a seat before sending movement',async()=>{
 const f=effectsFixture({program:'0 pmoveAvatar {20 30 0}',seated:true});try{await f.flush();assert.deepEqual(f.calls.map(call=>call.id),[2405,1570]);assert.equal(f.calls[0].noid,70);}finally{f.client.destroy();}
});

test('autostart mask loads a presentation once per advertisement rotation and restores its base display',()=>{
 let now=1000,seq=2;const calls=[];const object={noid:31,classNumber:61,fields:{banner_flags:1,interval:2,presentationAutostart:2,imageURL:'original.img',position:[100,150,3],orientation:1,mood:2,colorMap:Array.from({length:16},(_,i)=>i)}};
 const state={status:'connected',worldName:'Local',avatar:'Demo',objects:[object],history:[{seq:1,type:'request',id:5605,noid:31,fields:{which:0,format:0}},{seq:2,type:'message',id:5606,noid:31,fields:{success:0,text:`a.img|0|${colors}|Start|Link||b.img|2|${colors}|Play|Link|`,currentAd:1,timeLeft:1}}]};
 const client=new BannerPresentations({api:async(_path,body)=>calls.push(body),getState:()=>state,now:()=>now});
 try{
  client.ingestState(state);assert.deepEqual(calls,[{noid:31,id:5605,fields:{which:2,format:2}}]);for(let i=0;i<20;i++)client.tick();assert.equal(calls.length,1);
  state.history.push({seq:++seq,type:'request',id:5605,noid:31,fields:{which:2,format:2}},{seq:++seq,type:'message',id:5606,noid:31,fields:{success:0,text:'0 pimage custom.img 4\n0 pmove {9 8 7}\n0 pturn 3'}});client.ingestState(state);
  const playing=client.displayState(state).objects[0];assert.equal(playing.fields.imageURL,'custom.img');assert.deepEqual(playing.fields.position,[9,8,7]);assert.equal(playing.fields.orientation,3);
  now=2200;client.tick();const restored=client.displayState(state).objects[0];assert.equal(restored.fields.imageURL,'b.img');assert.equal(restored.fields.choreState,2);assert.deepEqual(restored.fields.position,[100,150,3]);assert.equal(restored.fields.orientation,1);assert.equal(restored.fields.mood,2);assert.equal(calls.length,1);
  now=4200;client.tick();assert.equal(client.displayState(state).objects[0].fields.imageURL,'a.img');assert.equal(calls.length,1);
  now=6200;client.tick();assert.equal(calls.length,2);for(let i=0;i<10;i++)client.tick();assert.equal(calls.length,2);assert.equal(object.fields.imageURL,'original.img');
 }finally{client.destroy();}
});

function nativeFixture({runTcl,enabled=true,autostart=0}={}){
 let now=1000;const calls=[],messages=[];
 const banner={noid:31,classNumber:61,fields:{name:'Native Banner',banner_flags:1,interval:2,presentationAutostart:autostart,imageURL:'original.img',imageVersion:7,choreState:0,position:[100,150,3],colorMap:Array(16).fill(1)}};
 const state={status:'connected',worldName:'Local',avatar:'Demo',actorNoid:44,region:{fields:{name:'Room'}},objects:[banner],tcl:{enabled,tasks:[]},history:[{seq:1,type:'request',noid:31,id:5605,fields:{which:0,format:0}},{seq:2,type:'message',noid:31,id:5606,fields:{success:0,text:`a.img|1|${colors}|First presentation|First link|https://example.com/a|b.img|2|${colors}|Second presentation|Second link|https://example.com/b`,currentAd:1,timeLeft:1}}]};
 const client=new BannerPresentations({api:async(path,body)=>{calls.push({path,body});return {sent:true};},getState:()=>state,runTcl,now:()=>now,onMessage:message=>messages.push(message)});client.ingestState(state);
 return {client,state,banner,calls,messages,setNow(value){now=value;},async flush(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('enabled native Tcl delegates the selected presentation and current advertisement state without a literal request',async()=>{
 const nativeCalls=[],f=nativeFixture({runTcl:async(...args)=>{nativeCalls.push(args);return {taskId:'native-presentation-1'};}});
 try{
  const result=await f.client.start(31);assert.deepEqual(result,{taskId:'native-presentation-1'});assert.equal(nativeCalls.length,1);assert.equal(nativeCalls[0][0],31);assert.equal(nativeCalls[0][1],2);
  assert.deepEqual(nativeCalls[0][2],{imageURL:'b.img',choreState:2,colorMap:Array.from({length:16},(_,i)=>i),presentationLabel:'Second presentation',URLlabel:'Second link',link:'https://example.com/b'});
  assert.deepEqual(f.calls,[]);assert.equal(f.client.items.get(31).programLoading,false);assert.equal(f.client.items.get(31).nativeTask,'native-presentation-1');assert.equal(f.banner.fields.imageURL,'original.img');assert.equal(f.banner.fields.imageVersion,7);
 }finally{f.client.destroy();}
});

test('native task startup and active execution suspend advertisement rotation until completed task state arrives',async()=>{
 let resolveStart;const started=new Promise(resolve=>{resolveStart=resolve;}),f=nativeFixture({runTcl:()=>started});
 try{
  const opening=f.client.start(31,2);assert.equal(f.client.items.get(31).programLoading,true);f.setNow(3000);f.client.tick();assert.equal(f.client.current(31).imageURL,'b.img');
  resolveStart({taskId:'native-presentation-2'});await opening;
  // The HTTP task acknowledgement can arrive before its SSE task snapshot.
  f.setNow(10000);f.client.tick();assert.equal(f.client.current(31).imageURL,'b.img');
  f.state.tcl.tasks=[{id:'native-presentation-2',status:'running'}];f.setNow(100000);f.client.tick();assert.equal(f.client.current(31).imageURL,'b.img');assert.equal(f.client.items.get(31).nativeTask,'native-presentation-2');
  f.state.tcl.tasks=[{id:'native-presentation-2',status:'complete'}];f.client.tick();assert.equal(f.client.items.get(31).nativeTask,null);assert.equal(f.client.current(31).imageURL,'b.img');
  f.setNow(101999);f.client.tick();assert.equal(f.client.current(31).imageURL,'b.img');f.setNow(102000);f.client.tick();assert.equal(f.client.current(31).imageURL,'a.img');assert.deepEqual(f.calls,[]);
 }finally{f.client.destroy();}
});

test('failed native startup clears the loading guard, reports rejection and permits an explicit retry',async()=>{
 let attempt=0;const f=nativeFixture({runTcl:async()=>{if(++attempt===1)throw new Error('The native presentation was declined');return {taskId:'native-presentation-retry'};}});
 try{
  await assert.rejects(()=>f.client.start(31,2),/declined/);assert.equal(f.client.items.get(31).programLoading,false);assert.equal(f.client.items.get(31).nativeTask,undefined);assert.deepEqual(f.calls,[]);
  await f.client.start(31,2);assert.equal(attempt,2);assert.equal(f.client.items.get(31).nativeTask,'native-presentation-retry');assert.equal(f.client.items.get(31).programLoading,false);
 }finally{f.client.destroy();}
});

test('native autostart delegates once per rotation and task failure releases the rotation lock',async()=>{
 const nativeCalls=[],f=nativeFixture({autostart:2,runTcl:async(...args)=>{nativeCalls.push(args);return {taskId:'native-autostart'};}});
 try{
  await f.flush();assert.equal(nativeCalls.length,1);assert.equal(nativeCalls[0][1],2);assert.equal(nativeCalls[0][2].imageURL,'b.img');
  for(let i=0;i<10;i++)f.client.tick();assert.equal(nativeCalls.length,1);
  f.state.tcl.tasks=[{id:'native-autostart',status:'error',error:'A native binding failed'}];f.setNow(3000);f.client.tick();assert.equal(f.client.items.get(31).nativeTask,null);assert.equal(f.client.items.get(31).programLoading,false);
  f.setNow(5000);f.client.tick();assert.equal(f.client.current(31).imageURL,'a.img');assert.equal(nativeCalls.length,1);assert.deepEqual(f.calls,[]);
 }finally{f.client.destroy();}
});

test('legacy presentation loading remains available unless both Tcl enablement and the delegate are present',async()=>{
 for(const options of [{enabled:false,runTcl:async()=>{throw new Error('Native delegate must stay disabled');}},{enabled:true}]){
  const f=nativeFixture(options);try{await f.client.start(31,2);assert.deepEqual(f.calls,[{path:'/api/action',body:{noid:31,id:5605,fields:{which:2,format:2}}}]);assert.equal(f.client.items.get(31).nativeTask,undefined);}finally{f.client.destroy();}
 }
});
