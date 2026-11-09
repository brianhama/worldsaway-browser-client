import test from 'node:test';
import assert from 'node:assert/strict';
import {PaymentPreparation,PaymentError,PaymentCancelledError,nativePaymentQuote,nativeAvatarTokens,nativeRegistryCost,nativeRentPayment,NATIVE_PAYMENT_REQUESTS} from '../../dist/public/payments.js';
import {getAction,coerceActionValues,parseWireSchema,actionsForDefinition} from '../../dist/public/actions.js';
import {selectActionTarget,compatibleTargets} from '../../dist/public/targets.js';
import {DocumentController,parseTclList,parseBinderEntries} from '../../dist/public/documents.js';
import {prepareSeatRequest,availableSeatSpots,SeatingError} from '../../dist/public/seating.js';

const object=(noid,classNumber,parent=0,slot=0,extra={})=>({noid,classNumber,fields:{name:`Object ${noid}`,container_noid:parent,position:[slot,0,0],common_flags:0,...extra}});
function fixture(){const region=object(0,20,0,0,{name:'Room'}),actor=object(16,21,0,0,{reducedCapacity:10,nameChanges:0}),device=object(40,57,0,0,{reducedCapacity:10}),stock=object(41,27,40,0,{salePrice:5}),tokens=object(50,26,16,2,{denom:20});return {status:'connected',worldName:'Local',avatar:'Me',actorNoid:16,region,objects:[region,actor,device,stock,tokens],history:[]};}
const buy={id:2675,noid:40,fields:{slot:0}};
const child=(state,slot)=>state.objects.find(o=>o.fields.container_noid===16&&o.fields.position[0]===slot);
function harness({balance=20,hand,decline,missingHand=false,stall=false,priceList='0 5 10',rentQuote={rent:5,rent_due:10,max_rent:30}}={}){
 const state=fixture();state.objects.find(o=>o.noid===50).fields.denom=balance;if(hand)state.objects.push(hand);const calls=[];let seq=0,controller;
 const api=async(path,body)=>{
  calls.push(body);if(stall)return {sent:true};
  const target=state.objects.find(o=>o.noid===body.noid);let id,fields={success:decline??0};
  if(!decline){
   if(body.id===211){id=212;fields.propdata=priceList;}
   else if(body.id===4016){id=4017;Object.assign(fields,rentQuote);}
   else if(body.id===89){
    if(target.classNumber===26){id=1156;const pocket=child(state,2);fields={success:0,pocket_tokens:pocket?.noid??65535,denom:target.fields.denom+(pocket?.fields.denom??0)};if(pocket)state.objects=state.objects.filter(o=>o.noid!==pocket.noid);target.fields.denom=fields.denom;target.fields.position=[2,0,0];}
    else{id=90;fields.slot=4;target.fields.position=[4,0,0];}
   }else if(body.id===97){id=70;target.fields.position=[0,0,0];}
   else if(body.id===1139){id=1142;target.fields.denom-=body.fields.amount;if(!missingHand)state.objects.push(object(60,26,16,0,{denom:body.fields.amount}));}
  }
  id??=body.id===211?212:body.id===4016?4017:body.id===89?(target.classNumber===26?1156:90):body.id===1139?1142:70;
  state.history.push({seq:++seq,type:'message',id,noid:body.noid,requestId:body.id,requestNoid:body.noid,fields});controller.ingestState(state);return {sent:true};
 };
 controller=new PaymentPreparation({api,getState:()=>state,timeout:20});return {state,calls,controller,api};
}

test('only source-backed wrappers obtain a quote and each uses its exact native price',()=>{
 const state=fixture(),device=state.objects.find(o=>o.noid===40);
 const cases=[
  [1202,56,{rideCost:0},{},1],[1202,56,{rideCost:65535},{},0],[1202,56,{rideCost:7},{},7],
  [2675,57,{reducedCapacity:10},{slot:0},5],[3301,34,{bodycost3:7},{body:3},7],
  [4005,46,{rent:[0,3,10]},{plan:2},10],[4361,43,{cost:2},{copies:1},2],
  [4403,47,{price:4},{actor:16},4],[9908,98,{salePrice:8},{target:70},8],
  [20907,209,{rideCost:9},{},9],[21004,210,{salePrice:6},{},6],[21304,213,{salePrice:11},{},11]
 ];
 for(const [id,klass,fields,values,cost]of cases){device.classNumber=klass;device.fields={...device.fields,...fields};assert.equal(nativePaymentQuote({id,noid:40,fields:values},state).cost,cost,String(id));}
 for(const id of [20504,5302,20105,2678,2810,1570])assert.equal(nativePaymentQuote({id,noid:40},state),null,String(id));
 assert.deepEqual(NATIVE_PAYMENT_REQUESTS,[1202,2675,2924,3301,4005,4009,4361,4403,9908,20907,21004,21304]);
});

test('unavailable costs, wrong receivers, unknown stock, and multi-copy totals cannot be guessed',()=>{
 const state=fixture();assert.throws(()=>nativePaymentQuote({...buy,noid:999},state),PaymentError);
 assert.throws(()=>nativePaymentQuote({...buy,fields:{slot:1}},state),/stock/);
 delete state.objects.find(o=>o.noid===41).fields.salePrice;assert.throws(()=>nativePaymentQuote(buy,state),/price/);
 const device=state.objects.find(o=>o.noid===40);device.classNumber=43;device.fields.cost=3;
 assert.throws(()=>nativePaymentQuote({id:4361,noid:40,fields:{copies:2}},state),/one copy/);
 assert.throws(()=>nativePaymentQuote({id:3301,noid:40,fields:{body:1}},state),/body changer/);
});

test('payment preparation splits the exact hand amount after acknowledgement and never sends the purchase',async()=>{
 const h=harness();assert.equal(await h.controller.perform(buy),buy);
 assert.deepEqual(h.calls,[{id:1139,noid:50,fields:{amount:5}}]);assert.equal(child(h.state,0).fields.denom,5);assert.equal(child(h.state,2).fields.denom,15);h.controller.destroy();
});

test('an exact pocket pile is taken with97 instead of split, including a standard reply on NOID0',async()=>{
 const h=harness({balance:5});await h.controller.perform(buy);assert.deepEqual(h.calls.map(c=>c.id),[97]);assert.equal(child(h.state,0).noid,50);h.controller.destroy();
 const state=fixture();state.objects.find(o=>o.noid===50).fields.denom=5;let c;
 c=new PaymentPreparation({getState:()=>state,api:async(path,body)=>{state.objects.find(o=>o.noid===50).fields.position=[0,0,0];state.history.push({seq:1,type:'message',id:70,noid:0,requestId:97,requestNoid:50,fields:{success:0}});return {state};}});
 await c.perform(buy);c.destroy();
});

test('held and pocket tokens merge via89/1156 before splitting and total excludes bank and nested contents',async()=>{
 const h=harness({balance:3,hand:object(51,26,16,0,{denom:4})});h.state.objects.push(object(80,33,0,0,{bankBalance:500}),object(81,26,41,0,{denom:200}));
 assert.equal(nativeAvatarTokens(h.state),7);await h.controller.perform(buy);
 assert.deepEqual(h.calls.map(c=>c.id),[89,1139]);assert.equal(child(h.state,0).fields.denom,5);assert.equal(child(h.state,2).fields.denom,2);h.controller.destroy();
});

test('native fixHands pockets an ordinary held object but refuses open containers and full pockets',async()=>{
 const h=harness({hand:object(70,27,16,0)});await h.controller.perform(buy);assert.deepEqual(h.calls.map(c=>c.id),[89,1139]);assert.equal(h.state.objects.find(o=>o.noid===70).fields.position[0],4);h.controller.destroy();
 for(const kind of ['open','full']){
  const h=harness({hand:object(70,kind==='open'?36:27,16,0)});if(kind==='full')for(let slot=4;slot<10;slot++)h.state.objects.push(object(70+slot,27,16,slot));
  await assert.rejects(()=>h.controller.perform(buy),kind==='open'?/Close the held container/:/no room/);assert.deepEqual(h.calls,[]);h.controller.destroy();
 }
});

test('newsstand and printing preserve native refusal to clear an ordinary held object automatically',async()=>{
 const h=harness({hand:object(70,27,16,0)}),device=h.state.objects.find(o=>o.noid===40);device.classNumber=47;device.fields.price=3;
 await assert.rejects(()=>h.controller.perform({id:4403,noid:40,fields:{actor:16}}),/Put the held object/);assert.deepEqual(h.calls,[]);h.controller.destroy();
});

test('insufficient funds, failed preparation and absent token CV prevent any final action',async()=>{
 for(const opts of [{balance:4},{decline:5},{missingHand:true}]){
  const h=harness(opts);await assert.rejects(async()=>{await h.controller.perform(buy);await h.api('/api/action',buy);},PaymentError);assert.ok(h.calls.every(call=>call.id!==2675));h.controller.destroy();
 }
});

test('price changes and region changes while awaiting acknowledgement cancel the purchase',async()=>{
 const h=harness(),original=h.controller.api;
 h.controller.api=async(...args)=>{h.state.objects.find(o=>o.noid===41).fields.salePrice=6;return original(...args);};
 await assert.rejects(()=>h.controller.perform(buy),/price changed/);assert.ok(h.calls.every(call=>call.id!==2675));h.controller.destroy();
 const stalled=harness({stall:true}),pending=stalled.controller.perform(buy),rejected=assert.rejects(pending,PaymentCancelledError);await new Promise(resolve=>setImmediate(resolve));stalled.state.region.fields.name='Other room';stalled.controller.ingestState(stalled.state);await rejected;stalled.controller.destroy();
});

test('free devices avoid token moves and a timed-out acknowledgement never sends the final operation',async()=>{
 const h=harness();h.state.objects.find(o=>o.noid===41).fields.salePrice=0;await h.controller.perform(buy);assert.deepEqual(h.calls,[]);h.controller.destroy();
 const stalled=harness({stall:true});await assert.rejects(()=>stalled.controller.perform(buy),/acknowledge/);assert.deepEqual(stalled.calls.map(c=>c.id),[1139]);stalled.controller.destroy();
});

test('registry list selection exactly follows nameChanges, last-entry fallback, free default and -1 refusal',()=>{
 assert.equal(nativeRegistryCost('0 5 10',0),0);assert.equal(nativeRegistryCost('0 5 10',1),5);assert.equal(nativeRegistryCost('0 5 10',100),10);
 assert.equal(nativeRegistryCost('{0} "5" 10',1),5);assert.equal(nativeRegistryCost('',0),0);
 assert.throws(()=>nativeRegistryCost('0 -1',1),/any more name changes/);
 for(const list of ['0 [exec ignored]','0 $price','0 -2','{0 5','  '])assert.throws(()=>nativeRegistryCost(list,1),PaymentError);
 for(const changes of [undefined,-1,1.5,256])assert.throws(()=>nativeRegistryCost('0 5',changes),/counter/);
 assert.throws(()=>nativeRegistryCost(undefined,0),/no native price list/);
});

test('registry reads .priceList on region NOID0 and prepares the acknowledged quoted amount',async()=>{
 const h=harness(),device=h.state.objects.find(o=>o.noid===40);device.classNumber=52;device.fields.common_flags=1024;h.state.objects.find(o=>o.noid===16).fields.nameChanges=1;
 const action={id:2924,noid:40,fields:{name:'New name'}};await h.controller.perform(action);
 assert.deepEqual(h.calls.map(c=>c.id),[211,1139]);assert.deepEqual(h.calls[0],{id:211,noid:0,fields:{target:40,propname:'.priceList'}});assert.equal(child(h.state,0).fields.denom,5);
 assert.equal(h.controller.lastQuote.source,'00050b58/00050b59:.priceList');assert.equal(h.controller.lastQuote.details.priceList,'0 5 10');assert.equal(h.controller.lastQuote.details.nameChanges,1);
 assert.equal(device.fields.priceList,undefined);h.controller.destroy();
 const free=harness();free.state.objects.find(o=>o.noid===40).classNumber=52;await free.controller.perform(action);assert.deepEqual(free.calls,[]);free.controller.destroy();
});

test('registry rejects declined, malformed or exhausted quotes before moving inventory',async()=>{
 for(const opts of [{decline:5},{priceList:'0 -1'},{priceList:'0 invalid'}]){
  const h=harness(opts),device=h.state.objects.find(o=>o.noid===40);device.classNumber=52;device.fields.common_flags=1024;h.state.objects.find(o=>o.noid===16).fields.nameChanges=1;
  await assert.rejects(()=>h.controller.perform({id:2924,noid:40,fields:{name:'New'}}),PaymentError);assert.deepEqual(h.calls.map(c=>c.id),[211]);h.controller.destroy();
 }
});

test('rent quote validates a positive exact increment inside due/max bounds and prepares only that chosen amount',async()=>{
 const h=harness(),device=h.state.objects.find(o=>o.noid===40);device.classNumber=46;
 const item={id:4009,noid:40,fields:{address:'Chez Me',pay_amount:15}},quotes=[];h.controller.onQuote=quote=>quotes.push(quote);
 await h.controller.perform(item);assert.deepEqual(h.calls.map(c=>c.id),[4016,1139]);assert.deepEqual(h.calls[0],{id:4016,noid:40,fields:{address:'Chez Me'}});assert.equal(child(h.state,0).fields.denom,15);
 assert.deepEqual(h.controller.lastQuote.details,{address:'Chez Me',rent:5,rent_due:10,max_rent:30});assert.equal(quotes.at(-1).cost,15);assert.equal(device.fields.rent_due,undefined);assert.equal(h.calls.some(c=>c.id===4009),false);h.controller.destroy();
});

test('invalid rent totals and failed quotes never prepare currency or send pay-rent',async()=>{
 for(const total of [undefined,0,-5,5,11,35,1.5,'[exec ignored]']){
  const h=harness();h.state.objects.find(o=>o.noid===40).classNumber=46;
  await assert.rejects(()=>h.controller.perform({id:4009,noid:40,fields:{address:'Chez Me',pay_amount:total}}),PaymentError);assert.deepEqual(h.calls.map(c=>c.id),[4016]);h.controller.destroy();
 }
 for(const quote of [{rent:0,rent_due:0,max_rent:30},{rent:5,rent_due:20,max_rent:10},{rent:5,rent_due:0,max_rent:0},{rent:5,rent_due:10}])assert.throws(()=>nativeRentPayment(quote,10),PaymentError);
 const h=harness({decline:5});h.state.objects.find(o=>o.noid===40).classNumber=46;await assert.rejects(()=>h.controller.perform({id:4009,noid:40,fields:{address:'Chez Me',pay_amount:10}}),PaymentError);assert.deepEqual(h.calls.map(c=>c.id),[4016]);h.controller.destroy();
});

test('a changed registry name counter invalidates the cached quote before final dispatch',async()=>{
 const h=harness(),device=h.state.objects.find(o=>o.noid===40);device.classNumber=52;device.fields.common_flags=1024;h.state.objects.find(o=>o.noid===16).fields.nameChanges=1;const api=h.controller.api;
 h.controller.api=async(path,body)=>{if(body.id===1139)h.state.objects.find(o=>o.noid===16).fields.nameChanges=2;return api(path,body);};
 await assert.rejects(()=>h.controller.perform({id:2924,noid:40,fields:{name:'New'}}),/price changed/);assert.deepEqual(h.calls.map(c=>c.id),[211,1139]);h.controller.destroy();
});


function documentFixture({index=false}={}){
 let seq=0;const requests=[],pages=['First page','Second page'];let subject='Original subject';let entries=index?'{{First document} Alice {7 November} 0 42} {{Nested binder} Bob {7 November} 1 43}':'';
 const object={noid:80,classNumber:37,fields:{name:'Notebook',docState:2,textid:12,documentFlags:index?2:0,blank_page_count:8,container_noid:44,position:[4,0,0]}};
 let state={actorNoid:44,objects:[object],history:[]},controller;
 const api=async(path,body)=>{
  assert.equal(path,'/api/action');requests.push(body);let reply,fields={success:0};
  switch(body.id){
   case 2710:reply=2711;fields={success:0,owner:1,size:8192,max_size:32000,flags:0,days_to_live:0,date:'Today',author:'Alice',subject};break;
   case 2781:reply=2780;fields={success:0,page:body.fields.page,text:pages[body.fields.page]??''};break;
   case 2771:reply=2770;pages[body.fields.page]=body.fields.text;fields={success:0,doc_page_count:pages.length,blank_page_count:7};break;
   case 2712:reply=2713;subject=body.fields.subject;break;
   case 2715:reply=2716;fields={success:0,owner:1,num_entries:2,max_entries:100,flags:0,date:'Today',author:'Alice',subject};break;
   case 2735:reply=2736;fields={success:0,count:2,contents:entries};break;
   case 2743:reply=2744;fields={success:0,count:3,pages:0};break;
   case 2747:reply=2748;fields={success:0,slot:4};break;
   case 2761:reply=2762;[pages[0],pages[1]]=[pages[1],pages[0]];break;
   default:throw new Error(`Unexpected operation ${body.id}`);
  }
  queueMicrotask(()=>{state={...state,history:[...state.history,{seq:++seq,type:'message',noid:80,id:reply,requestId:body.id,fields}]};controller.ingestState(state);});
  return {sent:true};
 };
 controller=new DocumentController({api,getState:()=>state,timeout:100});
 return {controller,object,requests,pages,get state(){return state;}};
}

test('binder list parser handles native nested titles and preserves scripts as inert data',()=>{
 assert.deepEqual(parseTclList('{A title} "Another title" plain'),['A title','Another title','plain']);
 const entries=parseBinderEntries('{{A {nested} title} Alice {7 November} 0 42} {{[exec dangerous]} Bob Today 1 43}');
 assert.equal(entries[0].title,'A {nested} title');assert.equal(entries[0].id,42);assert.equal(entries[1].title,'[exec dangerous]');assert.equal(entries[1].type,1);
 assert.deepEqual(parseBinderEntries('{{Local title} 123}')[0].id,123);
 assert.throws(()=>parseTclList('{unclosed'),/Unterminated/);assert.throws(()=>parseTclList('x '.repeat(5000)),/too many/);
});

test('document controller reads distinct native pages, saves text and metadata, and reorders pages',async()=>{
 const {controller,object,requests,pages}=documentFixture();await controller.open(object);
 assert.equal(controller.model.text,'First page');assert.equal(controller.model.pageCount,2);assert.equal(controller.model.readOnly,false);
 await controller.page(1);assert.equal(controller.model.text,'Second page');assert.equal(controller.model.page,1);
 await controller.save('Updated page',{subject:'New subject',daysToLive:5});assert.equal(pages[1],'Updated page');assert.equal(controller.model.header.subject,'New subject');
 assert(requests.some(r=>r.id===2771&&r.fields.page===1&&r.fields.text==='Updated page'));
 assert.deepEqual(requests.find(r=>r.id===2712).fields,{max_size_allowed:32000,days_to_live:5,author:'Alice',subject:'New subject'});
 await controller.reorder(true);assert.equal(controller.model.page,0);assert.equal(controller.model.text,'Updated page');controller.destroy();
});

test('binder navigation selects exact native document and nested index IDs',async()=>{
 const {controller,object,requests}=documentFixture({index:true});await controller.open(object);assert.equal(controller.model.entries.length,2);
 await controller.openEntry(controller.model.entries[0]);assert.equal(controller.model.index,false);assert(requests.some(r=>r.id===2710&&r.fields.doc_id===42));
 await controller.backToIndex();assert.equal(controller.model.index,true);await controller.openEntry(controller.model.entries[1]);assert.equal(controller.model.indexId,43);assert(requests.some(r=>r.id===2735&&r.fields.idx_id===43));
 await controller.insert(100);assert(requests.some(r=>r.id===2743&&r.fields.src===100));await controller.remove(0);assert(requests.some(r=>r.id===2747&&r.fields.entry===0));controller.destroy();
});

test('document requests enforce native text bounds and preserve declined writes',async()=>{
 const {controller,object}=documentFixture();await controller.open(object);await assert.rejects(controller.save('Not native 🦄'),/Windows-1252/);assert.equal(controller.model.text,'First page');
 controller.model.readOnly=true;await assert.rejects(controller.save('Denied'),/read-only/);controller.destroy();
});

test('document controller closes outstanding operations without leaving a timeout',async()=>{
 let state={history:[],objects:[],actorNoid:44};const controller=new DocumentController({api:async()=>({sent:true}),getState:()=>state,timeout:100});
 const opening=controller.open({noid:80,classNumber:37,fields:{docState:2,textid:12,documentFlags:0}});await new Promise(resolve=>setTimeout(resolve,0));controller.close();await assert.rejects(opening,/closed/);assert.equal(controller.pending.length,0);assert.equal(controller.model.open,false);
});

// These tiny graphical metadata fixtures are authored for the tests. They are
// deliberately independent of original game images, artwork, and class caches.
function seatFixture() {
  const actor=object(16,21,0,0,{imageURL:'test-avatar.img'});
  const seat=object(40,53,0,0,{imageURL:'test-seat.img',orientation:0,reducedCapacity:1});
  const seatImage={spotFlags:Array(16).fill(0)};
  seatImage.spotFlags[3]=0x40000;
  const actorImage={
    chores:[{name:'unused',next:'default'},{name:'sit',next:'sitting'},{name:'sit_on_stool',next:'stool'}],
    namedStates:[
      {name:'default',entries:[{name:'sit',chore:1},{name:'sit_on_stool',chore:2}]},
      {name:'sitting',entries:[]},{name:'stool',entries:[]}
    ]
  };
  const state={status:'connected',actorNoid:16,worldName:'Fixture',avatar:'Player',objects:[actor,seat],history:[]};
  const item={id:2401,noid:40,fields:{spot:0,choreState:0,clothingChore:0}};
  const getImage=async noid=>noid===40?seatImage:actorImage;
  return {actor,seat,seatImage,actorImage,state,item,getImage};
}

test('seat preparation uses advertised actor spot and animation end state without mutating world state',async()=>{
  const f=seatFixture(),prepared=await prepareSeatRequest(f.item,f.state,f);
  assert.deepEqual(prepared.fields,{spot:3,choreState:1,clothingChore:0});
  assert.equal(f.item.fields.spot,0);
  assert.equal(f.actor.fields.container_noid,0);
  f.seat.fields.seat_type=1;
  assert.equal((await prepareSeatRequest(f.item,f.state,f)).fields.choreState,2);
});

test('seat occupancy and native contents prevent requests for unavailable spots',async()=>{
  const f=seatFixture();
  f.state.objects.push(object(17,21,40,3));
  assert.deepEqual(availableSeatSpots(f.seat,f.state,f.seatImage),[]);
  await assert.rejects(()=>prepareSeatRequest(f.item,f.state,f),/no empty places/);
  f.state.objects.pop();
  f.seat.fields.contents=[65535,65535,65535,900];
  await assert.rejects(()=>prepareSeatRequest(f.item,f.state,f),/no empty places/);
});

test('seat preparation refreshes occupancy after asynchronous image loading',async()=>{
  const f=seatFixture();f.seatImage.spotFlags[6]=0x40000;
  let resolveImage;
  const pending=prepareSeatRequest(f.item,f.state,{getState:()=>f.state,getImage:async noid=>noid===40?new Promise(resolve=>{resolveImage=resolve;}):f.actorImage});
  f.state.objects.push(object(17,21,40,3));
  resolveImage(f.seatImage);
  assert.equal((await pending).fields.spot,6);
});

test('seat preparation cancels if the avatar changes during image loading',async()=>{
  const f=seatFixture();let resolveImage;
  const pending=prepareSeatRequest(f.item,f.state,{getState:()=>f.state,getImage:async noid=>noid===40?new Promise(resolve=>{resolveImage=resolve;}):f.actorImage});
  const rejected=assert.rejects(pending,error=>error instanceof SeatingError&&error.silent===true);
  f.state.actorNoid=99;resolveImage(f.seatImage);await rejected;
});

test('seat preparation resolves clothing state and rejects ghost or facing-away actors',async()=>{
  const f=seatFixture();f.state.objects.push(object(20,206,16,3));
  const prepared=await prepareSeatRequest(f.item,f.state,{getImage:async noid=>noid===20?{namedStates:[{name:'default'},{name:'seated'}]}:f.getImage(noid)});
  assert.equal(prepared.fields.clothingChore,1);
  f.actor.classNumber=22;
  await assert.rejects(()=>prepareSeatRequest(f.item,f.state,f),/Become an avatar/);
  f.actor.classNumber=21;f.seat.fields.orientation=2;
  await assert.rejects(()=>prepareSeatRequest(f.item,f.state,f),/facing away/);
});

test('action validation preserves reserved native fields and enforces coordinate bounds',()=>{
  assert.deepEqual(coerceActionValues(1570,{coords:'1 2 -3'}).coords,[1,2,-3]);
  assert.throws(()=>coerceActionValues(1570,{coords:'1 2 32768'}),RangeError);
  assert.throws(()=>coerceActionValues(1570,{coords:[1,2]}),RangeError);
  assert.throws(()=>coerceActionValues(72,{text:'invalid\0text'}),/NUL/);
  assert.throws(()=>coerceActionValues(72,{text:'invalid 🦄'}),/Windows-1252/);
  assert.equal(coerceActionValues(72,{text:'Hello €'}).text,'Hello €');
});

test('explicit incompatible receivers are rejected without substituting a valid actor',()=>{
  const state=fixture(),action=getAction(1570);
  assert.deepEqual(compatibleTargets(action,state).map(object=>object.noid),[16]);
  assert.equal(selectActionTarget(action,state,40).noid,16);
  assert.equal(selectActionTarget(action,state,40,40),null);
  assert.equal(selectActionTarget(action,state,40,16).noid,16);
});

test('extension request schemas expose only declared IDs on their receiver classes',()=>{
  const custom=actionsForDefinition({classNumber:600,requests:[{id:60001,label:'Custom request',target:'$actor',receiverClasses:[21],replyId:70}]},[{id:60001,schema:'bu2target;bstext;;'}]);
  const action=custom.find(action=>action.id===60001);
  assert.deepEqual(action.classes,[21]);assert.equal(action.receiver,'actor');
  assert.equal(coerceActionValues(action,{target:'16',text:'Hello'}).target,16);
  assert.equal(custom.some(action=>action.id===60002),false);
  assert.throws(()=>parseWireSchema('bu2target'),/Invalid message descriptor/);
});
