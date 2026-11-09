import test from 'node:test';
import assert from 'node:assert/strict';
import {getObjectMenu} from '../../dist/public/menus.js';
import {ApproachError,nativeObjectWalkRequest} from '../../dist/public/approach.js';

const object=(noid,classNumber,name,parent=0,position=[200,200,0],extra={})=>({noid,classNumber,fields:{name,container_noid:parent,position,common_flags:0,...extra}});
function fixture(...objects){
 const actor=object(16,21,'Me',0,[10,20,0]),region=object(0,20,'Room',0,[0,0,0],{horizon:70});
 return {status:'connected',actorNoid:16,region,objects:[region,actor,...objects],history:[]};
}
const walk=(target,state)=>getObjectMenu(target,state).items[0];

test('every item class and avatar context starts with one Walk to command for that object',()=>{
 const classes=[20,21,22,24,26,27,30,31,33,34,36,37,38,40,44,53,57,58,200,999];
 for(const classNumber of classes){
  const target=object(100+classNumber,classNumber,`Class ${classNumber}`),state=fixture(target),menu=getObjectMenu(target,state);
  assert.deepEqual(menu.items[0],{label:'Walk to',command:'walk-to',noid:target.noid,fields:{},disabled:classNumber===22},String(classNumber));
  assert.equal(menu.items.filter(item=>item.command==='walk-to').length,1,String(classNumber));
  assert.ok(menu.items.some(item=>item.label==='Tell me about'),String(classNumber));
 }
 const state=fixture(),self=state.objects.find(item=>item.noid===state.actorNoid);
 assert.deepEqual(walk(self,state),{label:'Walk to',command:'walk-to',noid:16,fields:{},disabled:false});
 assert.ok(getObjectMenu(self,state).items.some(item=>item.label==='Mood'));
 assert.deepEqual(getObjectMenu(null,state),{label:'',items:[]});
});

test('Walk to reflects connection, physical actor, walk permission and world UI availability',()=>{
 const target=object(40,27,'Statue'),state=fixture(target);
 assert.equal(walk(target,state).disabled,false);
 assert.equal(walk(target,{...state,permissions:{}}).disabled,false);
 assert.equal(walk(target,{...state,permissions:{flags:524288}}).disabled,false);
 assert.equal(walk(target,{...state,tcl:{blockCount:0}}).disabled,false);
 for(const change of [{status:'disconnected'},{status:'avatars'},{status:undefined},{actorNoid:null},{actorNoid:999},{permissions:{flags:0}},{permissions:{flags:16}},{tcl:{blockCount:1}}]){
  assert.equal(walk(target,{...state,...change}).disabled,true,JSON.stringify(change));
 }
 for(const classNumber of [22,40,200]){
  const changed=fixture(target);changed.objects.find(item=>item.noid===16).classNumber=classNumber;
  assert.equal(walk(target,changed).disabled,true,`actor class ${classNumber}`);
 }
 const ghostNoid=fixture(target);ghostNoid.actorNoid=15;ghostNoid.objects.find(item=>item.noid===16).noid=15;
 assert.equal(walk(target,ghostNoid).disabled,true,'native Ghost actor identity');
});

test('contained items walk to their scene owner while the command retains the selected item identity',()=>{
 const display=object(40,36,'Display',0,[240,21,45],{common_flags:4}),bag=object(41,36,'Bag',40,[4,0,0]),item=object(42,27,'Flower',41,[2,0,0]);
 const state=fixture(display,bag,item);
 assert.deepEqual(walk(item,state),{label:'Walk to',command:'walk-to',noid:42,fields:{},disabled:false});
 assert.equal(walk(display,state).disabled,false,'native absolute-Y projection is valid');
 const held=object(43,27,'Held',16,[0,0,0]),pocket=object(44,36,'Pocket bag',16,[4,0,0]),nested=object(45,27,'Pocket item',44,[1,0,0]);
 state.objects.push(held,pocket,nested);
 for(const target of [held,pocket,nested])assert.equal(walk(target,state).disabled,false,target.fields.name);
 const seat=object(50,53,'Seat',0,[100,300,0]);state.objects.push(seat);state.objects.find(item=>item.noid===16).fields.container_noid=50;
 assert.equal(walk(nested,state).disabled,false,'a seated actor can stand before walking');
});

test('missing native destinations disable only Walk to while preserving the rest of each menu',()=>{
 const invalidTargets=[
  object(40,27,'Missing position',0,null),
  object(40,27,'Incomplete position',0,[10,20]),
  object(40,27,'Fractional position',0,[10.5,20,0]),
  object(40,27,'Nonfinite position',0,[10,Infinity,0]),
  object(40,27,'Out of range',0,[32768,20,0]),
  object(40,27,'Projected out of range',0,[10,5000,0],{common_flags:4}),
  object(40,27,'Missing ancestor',999,[0,0,0]),
  object(40,22,'Ghost target',0,[200,100,255]),
 ];
 for(const target of invalidTargets){
  const menu=getObjectMenu(target,fixture(target));
  assert.equal(menu.items[0].command,'walk-to',target.fields.name);
  assert.equal(menu.items[0].disabled,true,target.fields.name);
  assert.ok(menu.items.some(item=>item.label==='Tell me about'),target.fields.name);
 }
 const target=object(40,27,'Cycle',41,[0,0,0]),parent=object(41,36,'Cyclic parent',40,[0,0,0]),state=fixture(target,parent);
 assert.equal(walk(target,state).disabled,true);
 assert.ok(getObjectMenu(target,state).items.some(item=>item.label==='Tell me about'));
});

test('explicit object walks preserve full native coordinates and resolve a moved target when invoked',()=>{
 const target=object(40,27,'Statue',0,[240,400,-20]),state=fixture(target),command=walk(target,state);
 assert.deepEqual(nativeObjectWalkRequest(target,state),{id:1570,noid:16,fields:{coords:[240,400,-20]}});
 assert.deepEqual(command.fields,{},'the menu must not freeze a destination');
 const moved=object(40,27,'Statue',0,[300,450,12]);state.objects=state.objects.map(item=>item.noid===40?moved:item);
 const current=state.objects.find(item=>item.noid===command.noid);
 assert.deepEqual(nativeObjectWalkRequest(current,state),{id:1570,noid:16,fields:{coords:[300,450,12]}});
});

test('explicit contained walks use native absolute-Y projection and their physical owner destination',()=>{
 const display=object(40,36,'Display',0,[240,-21,45],{common_flags:4}),bag=object(41,36,'Bag',40,[4,0,0]),item=object(42,27,'Flower',41,[2,0,0]),state=fixture(display,bag,item);
 assert.deepEqual(nativeObjectWalkRequest(item,state),{id:1570,noid:16,fields:{coords:[240,-153,0]}});
 const seat=object(50,53,'Seat',0,[100,300,-10]),held=object(51,27,'Held',16,[0,0,0]);
 state.objects.push(seat,held);state.objects.find(item=>item.noid===16).fields.container_noid=50;
 assert.deepEqual(nativeObjectWalkRequest(held,state),{id:1570,noid:16,fields:{coords:[100,300,-10]}});
});

test('explicit walks reject unavailable targets and Ghost-owned inventory without guessed destinations',()=>{
 const ghost=object(40,22,'Ghost',0,[200,100,255]),item=object(41,27,'Ghost item',40,[0,0,0]),state=fixture(ghost,item);
 for(const target of [undefined,ghost,item])assert.throws(()=>nativeObjectWalkRequest(target,state),ApproachError);
 assert.equal(walk(item,state).disabled,true);
 const valid=object(42,27,'Statue');state.objects.push(valid);
 for(const change of [{status:'disconnected'},{actorNoid:null},{permissions:{flags:0}},{tcl:{blockCount:1}}])assert.throws(()=>nativeObjectWalkRequest(valid,{...state,...change}),ApproachError);
});
