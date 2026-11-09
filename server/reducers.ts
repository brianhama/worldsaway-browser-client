import type {NativeSession} from './session.js';
import type {NativePacket,PendingRequest} from './types.js';
import type {NativeFields} from './types.js';
/** Browser-side object-state equivalents of recovered native/Tcl notices.
 * No server-provided scripts are executed. Replies use the issuing operation's
 * captured fields because the original wire protocol has no transaction ID.
 */
export function applyWorldUpdate(session: NativeSession,packet: NativePacket,fields: NativeFields,request?: PendingRequest){
 const {noid,id}=packet,objects=session.objects;
 const actor=()=>session.state.actorNoid!;
 const object=(n: number | null)=>objects.get(n!);
 const set=(n: number | null,patch: NativeFields)=>session.updateObject(n!,patch);
 const flags=(n: number | null,mask: number,value: number)=>{const o=object(n);if(o)set(n,{common_flags:((o.fields.common_flags??0)&~mask)|(value&mask)});};
 const move=(n: number | null,container: number | null | undefined,position: number | number[] | undefined)=>{if(n===undefined||container===undefined)return;set(n,{container_noid:container,position:Array.isArray(position)?position:[position??0,0,0]});};
 const inSlot=(n: number | null,slot: number)=>[...objects.values()].find(o=>o.fields.container_noid===n&&o.fields.position?.[0]===slot);
 // Native containers can own other containers. Track visited identities while
 // removing descendants so malformed containment cycles cannot recurse forever.
 const destroyed=new Set();
 const destroy=(n: number | null)=>{if(destroyed.has(n))return;destroyed.add(n);for(const child of [...objects.values()])if(child.noid!==n&&child.fields.container_noid===n)destroy(child.noid);objects.delete(n!);};
 const clear=(n: number | null)=>{for(const child of [...objects.values()])if(child.noid!==n&&child.fields.container_noid===n)destroy(child.noid);};
 const swap=(first: number | null,slotA: number,second: number | null,slotB: number)=>{const a=inSlot(first,slotA),b=inSlot(second,slotB);if(a)move(a.noid,second,slotB);if(b)move(b.noid,first,slotA);};
 const animate=(n: number | null,gesture: string)=>set(n,{gesture,gestureSeq:session.sequence+1});
 const wearAccessory=(actorNoid: number | null)=>{const holding=inSlot(actorNoid,0),head=inSlot(actorNoid,1);if(holding&&head)swap(actorNoid,0,head.noid,holding.fields.slot??0);};
 const wearClothing=(actorNoid: number | null,clothingChore?: number)=>{const holding=inSlot(actorNoid,0),wearing=inSlot(actorNoid,3);swap(actorNoid,0,actorNoid,3);if(wearing)set(wearing.noid,{choreState:0});if(holding){if(clothingChore!==undefined)set(holding.noid,{choreState:clothingChore});else if(object(object(actorNoid)?.fields.container_noid)?.classNumber===53)animate(holding.noid,'seated');}};
 const changeBody=(machineNoid: number,actorNoid: number | null,body: number,cost: number)=>{const machine=object(machineNoid);if(!machine)return;if(cost>0){const payment=inSlot(actorNoid,0);if(payment)destroy(payment.noid);}set(actorNoid,{imageDefault:machine.fields[`bodyDefault${body}`]??0,imageURL:machine.fields[`bodyURL${body}`]??object(actorNoid)?.fields.imageURL,orientation:0,bodyStyle:body});};
 const sit=(seatNoid: number,actorNoid: number | null,spot: number,commonFlags: number,choreState?: number,clothingChore?: number)=>{move(actorNoid,seatNoid,spot);set(actorNoid,{orientation:object(seatNoid)?.fields.orientation??0,...(choreState!==undefined?{choreState}:{})});set(seatNoid,{common_flags:commonFlags});animate(actorNoid,object(seatNoid)?.fields.seat_type===1?'sit_on_stool':'sit');const clothing=inSlot(actorNoid,3);if(clothing){if(clothingChore!==undefined)set(clothing.noid,{choreState:clothingChore});else animate(clothing.noid,'seated');}};
 const stand=(seatNoid: number,actorNoid: number | null,coords: number[],commonFlags: number)=>{move(actorNoid,0,coords);set(actorNoid,{choreState:0});set(seatNoid,{common_flags:commonFlags});animate(actorNoid,object(seatNoid)?.fields.seat_type===1?'get_off_stool':'return_to_stand');const clothing=inSlot(actorNoid,3);if(clothing)set(clothing.noid,{choreState:0});};
 const ghost=(target: number,coords: number[])=>{if(target===actor()){
   if(!object(15)){const source=object(target);objects.set(15,{noid:15,classNumber:22,className:'Ghost',fields:{...(source?.fields??{}),classNumber:22,noid:15,container_noid:0,imageURL:'o.ghost.img',position:coords,common_flags:0}});}
   flags(target,1,1);flags(15,1,0);set(15,{position:coords});session.state.actorNoid=15;
 }else flags(target,1,1);};
 // Native reply schemas conventionally encode success as zero; unsolicited
 // notices without a success field still carry authoritative state changes.
 const success=!Object.hasOwn(fields,'success')||fields.success===0;
 // These are unsolicited notices. Their meaning is anchored in the resource
 // method bearing this message number, rather than a number-name heuristic.
 if([68,91].includes(id))destroy(noid);
 if(id===50){flags(noid,1,0);set(noid,{position:fields.coords});}
 if(id===51)flags(noid,1,1);
 if(id===69)set(noid,{common_flags:fields.common_flags});
 if(id===28)set(noid,{name:fields.newName});
 if(id===87)move(noid,fields.container,fields.slot);
 if(id===95)move(noid,fields.actor,0);
 if(id===105)destroy(fields.actor);
 if(id===107)set(fields.actor,{position:fields.new_coords,orientation:fields.facing});
 if(id===1576)move(fields.item,noid,0);
 if(id===1581)move(fields.item,0,fields.at);
 if([1571,1572,1573].includes(id)&&success)set(noid,{position:fields.coords});
 if([1588,1589].includes(id)&&success)ghost(noid,fields.coords);
 if(id===2000){flags(15,1,0);set(15,{position:fields.coords});}
 if(id===2001)flags(15,1,1);
 if(id===2006&&success){session.state.actorNoid=fields.actor_noid;if(fields.hide_ghost)flags(15,1,1);}
 if(id===2007&&fields.hide_ghost)flags(15,1,1);
 if(id===1601)set(noid,{following:fields.leader});
 if(id===1604)set(noid,{following:65535});
 if(id===1606){const item=inSlot(fields.giver,0);if(item)move(item.noid,fields.givee,0);}
 if(id===1610){flags(fields.item,8,0);}
 if(id===1612){flags(fields.item,8,8);clear(fields.item);}
 if(id===1617)set(noid,{mood:fields.mood});
 if([1689,1595,1596].includes(id)&&success&&fields.facing!==65535&&fields.facing!==undefined)set(noid,{orientation:fields.facing});
 if(id===1595&&fields.gesture)set(noid,{gesture:fields.gesture,gestureSeq:session.sequence+1});
 if(id===1596&&request?.id===1594&&(success||fields.success===11))set(noid,{gesture:fields.success===11?'0xF00B':request.fields.gesture,gestureSeq:session.sequence+1});
 if(id===1141)set(noid,{denom:fields.amount});
 if(id===1153){if(fields.container_tokens!==65535)destroy(fields.container_tokens);set(noid,{denom:fields.denom});move(noid,fields.container,fields.slot);}
 if(id===1156&&success){if(fields.pocket_tokens!==65535&&fields.pocket_tokens!==noid)destroy(fields.pocket_tokens);set(noid,{denom:fields.denom});move(noid,actor(),2);}
 if(id===188)set(fields.item,{common_flags:fields.flags});
 if([190,191,192].includes(id)&&success)set(fields.item,{position:fields.coords,orientation:fields.orientation});
 if(id===301)flags(fields.direct??noid,16,fields.state);
 if(id===304)flags(noid,8,fields.state);
 if(id===1036)set(fields.target,{colorMap:fields.colors});
 if(id===5334)set(fields.target,{colorMap:fields.colors});
 if([2749,2793].includes(id))move(noid,fields.actor,fields.slot);
 if(id===4305)destroy(fields.destroy);
 if(id===3203)wearAccessory(fields.actor);
 if(id===20603)wearClothing(fields.actor);
 if(id===3302)changeBody(noid,fields.actor,fields.body,fields.cost);
 if(id===2403)sit(noid,fields.actor,fields.spot,fields.common_flags);
 if(id===2407)stand(noid,fields.actor,fields.coords,fields.common_flags);
 if(id===2772)set(noid,{doc_page_count:fields.doc_page_count,blank_page_count:fields.blank_page_count});
 if(id===2722)set(noid,{docState:fields.state});
 if(id===2732)set(noid,{docOrient:fields.orient});
 if(id===3603)swap(fields.actor,0,fields.actor,1);
 if(id===3607)move(noid,fields.actor,0);
 if(id===3207)move(noid,fields.actor,0);
 if(id===20606){move(noid,fields.actor,0);set(noid,{choreState:0});}
 if(id===21507){flags(fields.target,1,fields.state?1:0);if(fields.position)set(fields.target,{position:fields.position});}
 // Requests change local state only after the server acknowledges success.
 if(!request||!success)return;
 const r=request.fields,target=request.noid;
 // Standard replies carry little state themselves; use the request snapshot
 // rather than guessing which item happens to be in the player's hand now.
 if(id===70){
   if([93,97].includes(request.id))move(target,request.actorNoid,0);
   if(request.id===1575)move(r.item,request.actorNoid,0);
   if(request.id===26)set(target,{name:r.newName});
   if(request.id===1616)set(target,{mood:r.mood});
   if(request.id===1688)set(target,{orientation:r.facing});
   if(request.id===1603)set(target,{following:65535});
   if(request.id===1611){flags(r.item,8,8);clear(r.item);}
   if(request.id===303)flags(target,8,r.state);
   if(request.id===300)flags(r.indirect??target,16,r.state);
   if(request.id===5333)set(r.target,{colorMap:r.colorMap});
   if(request.id===5318)destroy(r.target);
   if(request.id===2730)set(target,{docOrient:r.orient});
   if(request.id===20605){move(target,request.actorNoid,0);set(target,{choreState:0});}
   if(request.id===3601)swap(request.actorNoid,0,request.actorNoid,1);
   if(request.id===3605)move(target,request.actorNoid,0);
   if(request.id===3205)move(target,request.actorNoid,0);
   if(request.id===3201)wearAccessory(request.actorNoid);
   if(request.id===20602)wearClothing(request.actorNoid,r.clothingChore);
   if(request.id===3301)changeBody(target,request.actorNoid,r.body,object(target)?.fields[`bodycost${r.body}`]??0);
 }
 if(id===2402&&request.id===2401)sit(target,request.actorNoid,r.spot,fields.common_flags,r.choreState,r.clothingChore);
 if(id===2406&&request.id===2405)stand(target,request.actorNoid,fields.coords,fields.common_flags);
 if(id===2770&&request.id===2771)set(target,{doc_page_count:fields.doc_page_count,blank_page_count:fields.blank_page_count});
 if(id===2721&&request.id===2720)set(target,{docState:r.state,textid:fields.textid});
 if(id===86){if(r.in_pocket)destroy(target);else move(target,r.container,fields.slot);}
 if(id===90)move(target,request.actorNoid,fields.slot);
 if(id===1152){
   if(r.in_pocket)destroy(target);
   else {if(fields.container_tokens!==65535&&fields.container_tokens!==target)destroy(fields.container_tokens);set(target,{denom:fields.denom});move(target,r.container,fields.slot);}
 }
 if(id===1142&&request.id===1139&&Number.isFinite(request.before?.denom))set(target,{denom:request.before.denom-r.amount});
 if(id===80&&request.id===1608)flags(r.item,8,0);
 if(id===1582){const item=request.handNoid;if(item!==undefined)move(item,0,fields.at);}
 if(id===1609&&request.id===1605&&request.handNoid!==undefined)move(request.handNoid,target,0);
 if(id===2731)set(target,{docOrient:r.orient});
 if(id===5334)set(r.target,{colorMap:r.colorMap});
}
