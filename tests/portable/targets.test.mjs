import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleTargets,selectActionTarget,displaySelfName,withPlayerName} from '../../dist/public/targets.js';
import {getAction} from '../../dist/public/actions.js';

const object=(noid,classNumber,name)=>({noid,classNumber,fields:{name}});
const region=object(0,20,'Welcome'),self=object(44,21,'Avatar 44'),peer=object(45,21,'Visitor'),atm=object(50,33,'ATM'),vendroid=object(51,57,'Vendroid');
const state={actorNoid:44,avatar:'RiverFork',region,objects:[region,self,peer,atm,vendroid]};

test('actor and region requests match both scope and native receiver class',()=>{
 assert.deepEqual(compatibleTargets(getAction(1570),state),[self]);
 assert.deepEqual(compatibleTargets(getAction(103),state),[region]);
 assert.deepEqual(compatibleTargets({...getAction(103),classes:[21]},state),[]);
 assert.deepEqual(compatibleTargets({...getAction(1570),classes:[22]},state),[]);
 const ghost=object(15,22,'RiverFork');
 const ghostState={...state,actorNoid:15,objects:[region,ghost,peer,atm]};
 assert.deepEqual(compatibleTargets(getAction(1570),ghostState),[]);
 assert.deepEqual(compatibleTargets(getAction(2005),ghostState),[ghost]);
 assert.deepEqual(compatibleTargets(getAction(103),{...state,objects:[],region}),[region]);
});

test('selection requests expose all matching objects and reject incompatible selected objects',()=>{
 assert.deepEqual(compatibleTargets(getAction(2801),state),[atm]);
 assert.deepEqual(compatibleTargets(getAction(1686),state),[self,peer]);
 assert.equal(selectActionTarget(getAction(2801),state,vendroid.noid),atm);
 assert.equal(selectActionTarget(getAction(1686),state,peer.noid),peer);
 assert.equal(selectActionTarget(getAction(1686),state,atm.noid),null);
 assert.equal(selectActionTarget(getAction(1686),state,null),null);
 assert.equal(selectActionTarget(getAction(1686),state,null,'45'),peer);
});

test('an explicit wrong class, malformed ID or missing object never falls back',()=>{
 for(const explicit of [51,999,'',-1,65536,'4.4',false,{}])assert.equal(selectActionTarget(getAction(2801),state,50,explicit),null);
 assert.equal(selectActionTarget(getAction(2801),state,51,50),atm);
 assert.equal(selectActionTarget(getAction(103),state,44,0),region);
 assert.equal(selectActionTarget(getAction(103),state,null,'0'),region);
 assert.equal(selectActionTarget(getAction(103),state,0,44),null);
});

test('native field class IDs work and invalid or duplicate object identities are excluded',()=>{
 const native={noid:'60',fields:{classNumber:'33',name:'Second ATM'}};
 const next={...state,objects:[...state.objects,native,{...native},object(null,33,'Invalid'),{noid:61,fields:{}},object(true,33,'Invalid')]};
 assert.deepEqual(compatibleTargets(getAction(2801),next),[atm,native]);
 assert.deepEqual(compatibleTargets(null,state),[]);
 assert.deepEqual(compatibleTargets(getAction(2801),{}),[]);
 assert.deepEqual(compatibleTargets(getAction(1570),{...state,actorNoid:null}),[]);
});

test('login name replaces only own synthesized or missing native name without mutating state',()=>{
 const projected=withPlayerName(state);
 assert.notEqual(projected,state);
 assert.notEqual(projected.objects,state.objects);
 assert.equal(projected.objects[1].fields.name,'RiverFork');
 assert.equal(projected.objects[2],peer);
 assert.equal(projected.region,region);
 assert.equal(state.objects[1].fields.name,'Avatar 44');
 assert.equal(displaySelfName(state),'RiverFork');
 assert.equal(withPlayerName(projected),projected);
 const named={...state,objects:[region,object(44,21,'Exact Native Name'),object(45,21,'Avatar 45')]};
 assert.equal(withPlayerName(named),named);
 assert.equal(displaySelfName(named),'Exact Native Name');
 const missing={...state,objects:[{noid:44,classNumber:22,fields:{}}]};
 assert.equal(withPlayerName(missing).objects[0].fields.name,'RiverFork');
 assert.equal(withPlayerName({...state,actorNoid:null}).objects[1],self);
});
