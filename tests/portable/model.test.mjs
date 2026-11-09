import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeHtml,objectName,objectClass,objectParent,isActor,inventoryObjects,safeUrl,noticeText,displayFields,slotName} from '../../dist/public/model.js';

const object=(noid,classNumber,parent,slot,name)=>({noid,classNumber,fields:{container_noid:parent,position:[slot,0,0],name}});

test('object identity helpers accept decoded native fields and escape visible untrusted text',()=>{
  const avatar=object(15,21,0,0,'<Alice & "Bob">');
  assert.equal(objectName(avatar),'<Alice & "Bob">');
  assert.equal(escapeHtml(objectName(avatar)),'&lt;Alice &amp; &quot;Bob&quot;&gt;');
  assert.equal(objectClass(avatar),21);
  assert.equal(objectParent(avatar),0);
  assert.equal(isActor(avatar),true);
  assert.equal(isActor(object(20,37,0,0,'Paper')),false);
  assert.equal(objectName(null),'World');
});

test('inventory traversal includes nested pockets regardless of ordering and excludes other avatars',()=>{
  const things=[object(70,27,60,0,'Nested item'),object(60,36,15,4,'Bag'),object(61,26,15,2,'Tokens'),object(62,27,16,4,'Other pocket'),object(63,36,64,0,'Cycle A'),object(64,36,63,0,'Cycle B'),object(15,21,0,0,'Me')];
  const result=inventoryObjects({actorNoid:15,objects:things});
  assert.deepEqual(new Set(result.map(o=>o.noid)),new Set([60,61,70]));
  assert.deepEqual(inventoryObjects({actorNoid:null,objects:things}),[]);
  assert.deepEqual(inventoryObjects({objects:things}),[]);
});

test('external world links permit only credential-free HTTP and HTTPS URLs',()=>{
  assert.equal(safeUrl('https://altaway.xyz/world?name=Demo'),'https://altaway.xyz/world?name=Demo');
  for(const value of ['javascript:alert(1)','data:text/html,hello','file:///etc/passwd','https://user:secret@example.com','/relative','not a URL'])assert.equal(safeUrl(value),null,value);
});

test('native scene and bootstrap control flags never appear as gameplay errors',()=>{
  assert.equal(noticeText({noid:10,id:12,fields:{success:1}}),null);
  assert.equal(noticeText({noid:0,id:145,fields:{success:1}}),null);
  assert.equal(noticeText({noid:15,id:72,type:'request',fields:{text:'Hi'}}),null);
  assert.equal(noticeText({noid:0,id:70,fields:{success:16,fail_msg:'Permission denied'}}).text,'Permission denied');
});

test('ESP replies distinguish sender, outbound recipient, and failed delivery',()=>{
  assert.deepEqual(noticeText({noid:0,id:110,fields:{from:'Bob',text:'Hello'}}),{kind:'esp',author:'Bob',text:'Hello',id:110});
  const sent=noticeText({noid:15,id:111,fields:{success:0,to:'Bob',text:'Hello'}});
  assert.equal(sent.author,'You → Bob');assert.equal(sent.kind,'esp');
  const failed=noticeText({noid:15,id:111,fields:{success:1,to:'Bob',text:'Original message'}});
  assert.equal(failed.kind,'error');assert.match(failed.text,/was not delivered/);
  assert.match(noticeText({noid:0,id:243,fields:{to:'Bob',text:'Original message'}}).text,/Bob is unavailable/);
});

test('speech and status replies preserve the semantic conversation channel',()=>{
  const alice=object(15,21,0,0,'Alice');
  assert.equal(noticeText({id:74,noid:15,fields:{speaker:15,text:'Hi'}},[alice]).author,'Alice');
  assert.equal(noticeText({id:73,noid:15,requestId:1916,fields:{success:0,speaker:15,text:'You have 100 tokens.'}},[alice]).kind,'system');
  assert.equal(noticeText({id:73,noid:15,requestId:72,fields:{success:0,speaker:15,text:'Hi'}},[alice]).kind,'say');
});

test('room speech and thoughts retain their native type and speaker identity',()=>{
  const alice=object(15,21,0,0,'Alice');
  for(const id of [73,74]) {
    const speech=noticeText({id,noid:0,requestId:id===73?72:undefined,fields:{success:0,speaker:15,type:0,text:'Hello'}},[alice]);
    assert.deepEqual(speech,{kind:'say',author:'Alice',text:'Hello',id,speakerNoid:15});
    const thought=noticeText({id,noid:0,requestId:id===73?72:undefined,fields:{success:0,speaker:15,type:1,text:'An idea'}},[alice]);
    assert.deepEqual(thought,{kind:'think',author:'Alice',text:'An idea',id,speakerNoid:15});
  }
  assert.equal(noticeText({id:74,noid:15,fields:{type:'1',text:'An idea'}},[alice]).speakerNoid,15);
});

test('status and rejected speech do not acquire avatar placement metadata',()=>{
  for(const requestId of [1916,2003]) {
    const status=noticeText({id:73,noid:15,requestId,fields:{success:0,speaker:15,type:1,text:'Status'}});
    assert.deepEqual(status,{kind:'system',author:'World',text:'Status',id:73});
  }
  const failed=noticeText({id:73,noid:15,requestId:72,fields:{success:1,speaker:15,type:1,text:'An idea'}});
  assert.equal(failed.kind,'error');assert.equal(failed.speakerNoid,undefined);
  for(const speaker of [0,-1,1.5,65536,'invalid']) {
    assert.equal(noticeText({id:74,noid:15,fields:{speaker,type:0,text:'Hello'}}).speakerNoid,undefined);
  }
});

test('mail, lookup, bank and document replies produce readable outcomes',()=>{
  assert.equal(noticeText({noid:0,id:246,fields:{success:0,text:''}}).text,'No unread ESP mail.');
  assert.equal(noticeText({noid:0,id:246,fields:{success:5,fail_msg:'Mail unavailable'}}).kind,'error');
  assert.equal(noticeText({noid:0,id:248,fields:{who:'Bob'}}).text,'New ESP mail from Bob.');
  assert.equal(noticeText({noid:0,id:242,fields:{success:0,realname:'Bob'}}).text,'Found Bob.');
  assert.match(noticeText({noid:33,id:2802,fields:{success:0,balance:100}}).text,/100 tokens/);
  assert.match(noticeText({noid:33,id:2812,fields:{success:0,amount:5,balance:95}}).text,/Withdrew 5 tokens/);
  const page=noticeText({noid:37,id:2780,fields:{success:0,text:'<b>Raw document text</b>'}});
  assert.equal(page.kind,'document');assert.equal(page.text,'<b>Raw document text</b>');
  assert.equal(noticeText({noid:50,id:4458,fields:{success:0,sender:'Bob',contents:'A parcel'}}).author,'Bob');
});

test('field displays omit binary vectors and reserved padding while retaining useful values',()=>{
  assert.deepEqual(displayFields({text:'Hi',contentsVector:[1,2,3],dummyfielda:0,unused:0,position:[1,2,3]}),[['text','Hi'],['position','[1,2,3]']]);
  assert.equal(slotName(0),'Hand');assert.equal(slotName(1),'Head');assert.equal(slotName(4),'Pocket 1');
});

test('conversation speaker names survive region transitions and URLs remain explicit user links',()=>{
 assert.equal(noticeText({id:73,noid:21,speakerName:'Alice',fields:{success:0,text:'Hello',speaker:21}},[]).author,'Alice');
 const link=noticeText({id:162,noid:31,fields:{success:0,URL:'https://example.com/world'}},[]);assert.equal(link.url,'https://example.com/world');
 assert.equal(noticeText({id:162,noid:31,fields:{success:0,URL:'javascript:alert(1)'}},[]),null);
});

test('acknowledged sender facing remains stable across snapshots and a later native notice supersedes it',async()=>{
 const {projectAcknowledgedFacing}=await import('../../dist/public/model.js'),tracker={};
 const object={noid:44,fields:{orientation:0}},history=[{seq:1,type:'message',id:101},{seq:2,type:'request',id:1688,noid:44,fields:{facing:3}},{seq:3,type:'message',id:70,noid:44,requestId:1688,fields:{success:0}}];
 assert.equal(projectAcknowledgedFacing({status:'connected',objects:[object],history},tracker).objects[0].fields.orientation,3);
 assert.equal(projectAcknowledgedFacing({status:'connected',objects:[object],history:[]},tracker).objects[0].fields.orientation,3);
 assert.equal(projectAcknowledgedFacing({status:'connected',objects:[object],history:[{seq:4,type:'message',id:1689,noid:44,fields:{facing:2}}]},tracker).objects[0].fields.orientation,2);
 assert.equal(projectAcknowledgedFacing({status:'connected',objects:[object],history:[{seq:5,type:'message',id:101}]},tracker).objects[0].fields.orientation,0);
 assert.equal(object.fields.orientation,0);
});
