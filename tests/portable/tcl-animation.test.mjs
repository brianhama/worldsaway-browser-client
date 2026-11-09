import test from 'node:test';
import assert from 'node:assert/strict';
import {TclVisualHost} from '../../dist/public/tcl-host.js';
import {NativeTclSession} from '../../dist/server/tcl-session.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
 const state={status:'connected',worldName:'Fixture',objects:[{noid:16,classNumber:31,fields:{position:[100,200,0],choreState:0,graphicState:0}}]};
 const image={namedStates:[{name:'idle'},{name:'running'},{name:'empty'}],choreography(names,state){return names[0]==='hold'?[91,92]:state===2?[]:[state*10+1,state*10+2];}};
 const updates=[],host=new TclVisualHost({getState:()=>state,getImage:async()=>image,onChange:()=>updates.push(structuredClone(host.visualUpdates())),...options});
 host.ingestState(state);t.after(()=>host.destroy());return {host,state,updates};
}
const chore=(endChore='default')=>({name:'activate',noid:16,index:0,imageState:0,endState:'running',endChore,commands:[{type:1,state:4,dx:0,dy:0,dz:0},{type:1,state:5,dx:0,dy:0,dz:0}]});

test('native chore frames stay pinned while running and release into an animated default on completion',async t=>{
 const {host,state,updates}=fixture(t),delays=[];
 host.sleep=()=>new Promise(resolve=>delays.push(resolve));
 const running=host.runChore(16,chore(),host.generation,{taskId:null,cancelled:false});
 assert.equal(host.overlays.get(16).tclGraphicState,4);
 delays.shift()();await flush();assert.equal(host.overlays.get(16).tclGraphicState,5);
 delays.shift()();await running;
 assert.deepEqual(host.overlays.get(16),{gesture:'',graphicState:11,position:[100,200,0],choreState:1,tclGraphicState:null});
 assert.equal(updates.at(-1)[0].fields.tclGraphicState,null);
 assert.equal(state.objects[0].fields.choreState,0);
});

test('chore-state releases an older frame pin in one complete update and explicit frame writes can pin again',async t=>{
 const {host,updates}=fixture(t);
 await host.dispatch('@obj',[16,'graphicState',77]);assert.equal(host.overlays.get(16).tclGraphicState,77);
 const before=updates.length;assert.equal(await host.dispatch('chore-state',[16,'running']),'running');
 assert.equal(updates.length,before+1);
 assert.deepEqual(updates.at(-1)[0].fields,{graphicState:11,choreState:1,gesture:'',tclGraphicState:null});
 await host.dispatch('@obj',[16,'graphicState',88]);assert.equal(host.overlays.get(16).tclGraphicState,88);
 await host.dispatch('chore-state',[16,'empty']);assert.equal(host.overlays.get(16).tclGraphicState,null);
 assert.equal(host.overlays.get(16).choreState,2);
});

test('an omitted end chore releases the default pin while an explicit non-default end chore retains it',async t=>{
 const {host}=fixture(t);host.sleep=async()=>{};
 await host.runChore(16,chore(''),host.generation,{taskId:null,cancelled:false});
 assert.equal(host.overlays.get(16).tclGraphicState,null);assert.equal(host.overlays.get(16).graphicState,11);
 await host.runChore(16,chore('hold'),host.generation,{taskId:null,cancelled:false});
 assert.equal(host.overlays.get(16).tclGraphicState,91);assert.equal(host.overlays.get(16).graphicState,91);
});

test('default handoff masks an echoed bridge pin and survives the bridge visual-update roundtrip',async t=>{
 const {host,state}=fixture(t);state.objects[0].fields.tclGraphicState=77;
 // A script may have written the pin before graphicState was present. The
 // handoff must still send its clearing sentinel after the derived frame pin.
 await host.dispatch('@obj',[16,'tclGraphicState',77]);
 await host.dispatch('chore-state',[16,'running']);
 host.ingestState(structuredClone(state));
 assert.equal(host.displayState(state).objects[0].fields.tclGraphicState,null);
 const server=Object.create(NativeTclSession.prototype);
 Object.assign(server,{session:{objects:new Map(state.objects.map(object=>[object.noid,object])),registry:{get:()=>({fields:[]})}},overrides:new Map([[16,{tclGraphicState:77}]]),virtual:new Map(),publish(){}});
 for(const update of host.visualUpdates())for(const [key,value]of Object.entries(update.fields))server.setField(update.noid,key,value);
 assert.equal(server.overrides.get(16).graphicState,11);assert.equal(server.overrides.get(16).tclGraphicState,null);
 const echoed={...state,objects:state.objects.map(object=>({...object,fields:{...object.fields,...server.overrides.get(object.noid)}}))};
 host.ingestState(echoed);assert.equal(host.displayState(echoed).objects[0].fields.tclGraphicState,null);
 await host.dispatch('@obj',[16,'graphicState',88]);assert.equal(host.displayState(echoed).objects[0].fields.tclGraphicState,88);
 const changed={...echoed,objects:echoed.objects.map(object=>({...object,fields:{...object.fields,graphicState:99,tclGraphicState:99}}))};
 host.ingestState(changed);assert.equal(host.overlays.get(16).tclGraphicState,undefined);
});

test('disabled animation freezes chore presentation while preserving script states, deltas, delays and final handoff',async t=>{
 const renderer={preferences:{animation:false}},{host,state}=fixture(t,{renderer}),delays=[];
 state.objects[0].fields.graphicState=9;
 host.sleep=ms=>new Promise(resolve=>delays.push({ms,resolve}));
 const moving={...chore(),commands:[{type:1,state:4,dx:3,dy:4,dz:5},{type:1,state:5,dx:-1,dy:2,dz:-3}]};
 const running=host.runChore(16,moving,host.generation,{taskId:null,cancelled:false});
 assert.equal(host.getObject(16,'graphicState'),4);assert.equal(host.getObject(16,'tclGraphicState'),9);
 assert.deepEqual(host.getObject(16,'position'),[103,204,5]);assert.equal(delays[0].ms,175);
 delays.shift().resolve();await flush();
 assert.equal(host.getObject(16,'graphicState'),5);assert.equal(host.getObject(16,'tclGraphicState'),9);
 assert.deepEqual(host.getObject(16,'position'),[102,206,2]);assert.equal(delays[0].ms,175);
 delays.shift().resolve();await running;
 assert.equal(host.getObject(16,'choreState'),1);assert.equal(host.getObject(16,'graphicState'),11);assert.equal(host.getObject(16,'tclGraphicState'),null);
 await host.dispatch('@obj',[16,'graphicState',88]);assert.equal(host.getObject(16,'tclGraphicState'),88);
});

test('animation toggles during a chore freeze its last pose and resume at the current command before a custom ending',async t=>{
 const renderer={preferences:{animation:true}},{host}=fixture(t,{renderer}),delays=[];
 host.sleep=()=>new Promise(resolve=>delays.push(resolve));
 const moving={...chore('hold'),commands:[4,5,6,7].map(state=>({type:1,state,dx:1,dy:0,dz:0}))};
 const running=host.runChore(16,moving,host.generation,{taskId:null,cancelled:false});
 assert.equal(host.getObject(16,'tclGraphicState'),4);
 renderer.preferences.animation=false;delays.shift()();await flush();
 assert.equal(host.getObject(16,'graphicState'),5);assert.equal(host.getObject(16,'tclGraphicState'),4);
 delays.shift()();await flush();assert.equal(host.getObject(16,'graphicState'),6);assert.equal(host.getObject(16,'tclGraphicState'),4);
 renderer.preferences.animation=true;delays.shift()();await flush();
 assert.equal(host.getObject(16,'graphicState'),7);assert.equal(host.getObject(16,'tclGraphicState'),7);
 renderer.preferences.animation=false;delays.shift()();await running;
 assert.deepEqual(host.getObject(16,'position'),[104,200,0]);assert.equal(host.getObject(16,'graphicState'),91);assert.equal(host.getObject(16,'tclGraphicState'),91);
});
