import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FrameDecoder,ProtocolError,frame,resourcePackets} from '../../dist/native/protocol.js';
import {SchemaError,parseSchema,encodeFields,decodeFields,encodeClientString,decodeClientString} from '../../dist/native/classes.js';
import {decodeZeroRle,decodeContentsVector} from '../../dist/native/world.js';
import {ResourceStore,CacheFormatError} from '../../dist/native/resources.js';

async function temporaryDirectory(t) {
 const directory=await mkdtemp(join(tmpdir(),'altaway-native-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));return directory;
}
function expanded(bytes) {
 const data=Buffer.from(bytes),prefix=Buffer.alloc(4);prefix.writeUInt32BE(data.length);
 return Buffer.concat([prefix,...[...data].map(byte=>Buffer.from(byte===255?[255,255]:[byte]))]);
}

test('frame decoding preserves ordered messages across partial headers, payloads and coalesced packets',()=>{
 const expected=[{noid:16,id:72,payload:Buffer.from('hello')},{noid:0,id:101,payload:Buffer.from([0,255,1])},{noid:10,id:18,payload:Buffer.alloc(0)}];
 const stream=Buffer.concat(expected.map(item=>frame(item.noid,item.id,item.payload)));
 const decoder=new FrameDecoder(),actual=[];
 const sizes=[1,2,4,1,3,2,7,1,32];let offset=0;
 for(const size of sizes){actual.push(...decoder.feed(new Uint8Array(stream.subarray(offset,offset+size))));offset+=size;if(offset>=stream.length)break;}
 assert.deepEqual(actual,expected);assert.equal(decoder.buffer.length,0);
 const pair=Buffer.concat([frame(65535,65535),frame(1,2,Buffer.from([3]))]);
 assert.deepEqual(decoder.feed(pair).map(packet=>[packet.noid,packet.id,packet.payload.length]),[[65535,65535,0],[1,2,1]]);
});

test('frame and buffered-input limits reject announced oversized payloads and bound incomplete frames',()=>{
 const oversized=frame(1,2,Buffer.alloc(9));
 assert.throws(()=>new FrameDecoder(8,32).feed(oversized.subarray(0,8)),error=>error instanceof ProtocolError&&/frame limit/.test(error.message));
 const decoder=new FrameDecoder(32,12),packet=frame(1,2,Buffer.alloc(5));
 assert.deepEqual(decoder.feed(packet.subarray(0,10)),[]);
 assert.throws(()=>decoder.feed(packet.subarray(10)),/input buffer limit/);
 assert.equal(decoder.buffer.length,10);
});

test('resource bootstrap fragments retain IDs, versions, totals and exact bytes through frame decoding',()=>{
 const resources=[{id:0x6002a,version:7,data:Buffer.from([0,1,2,3,255,4,5,6])},{id:0xa0001,version:9,data:Buffer.from('schema')}];
 const stream=Buffer.concat([...resourcePackets(resources,3)]),decoder=new FrameDecoder(),packets=[];
 for(let offset=0;offset<stream.length;offset+=5)packets.push(...decoder.feed(stream.subarray(offset,offset+5)));
 assert.equal(packets[0].id,16);assert.equal(packets[0].payload.readUInt32BE(0),2);assert.equal(packets[0].payload.readUInt32BE(4),14);
 assert.equal(packets.at(-1).id,18);assert.deepEqual(packets.at(-1).payload,Buffer.alloc(1));
 for(const resource of resources){
  const fragments=packets.filter(packet=>packet.id===17&&packet.payload.readUInt32BE(0)===resource.id);
  assert.equal(fragments[0].payload.readUInt32BE(8),resource.data.length);
  assert.deepEqual(fragments.map(packet=>packet.payload.readUInt32BE(4)),Array(fragments.length).fill(resource.version));
  for(const fragment of fragments)assert.equal(fragment.payload.readUInt32BE(12),fragment.payload.length-16);
  if(fragments.length>2)assert.equal(fragments[1].payload.readUInt32BE(8),0xffffffff);
  assert.equal(fragments.at(-1).payload.readUInt32BE(8),0);
  assert.deepEqual(Buffer.concat(fragments.map(packet=>packet.payload.subarray(16))),resource.data);
 }
 assert.throws(()=>[...resourcePackets([{id:1,version:1,data:Buffer.alloc(0)}])],/Empty resource/);
});

test('dynamic CUTESI arrays infer their count and roundtrip signed values, Windows-1252 and selected scopes',()=>{
 const schema='bu2count;bi2values,count;bslabel;ccprivate,4;;';
 const values={values:[-32768,0,32767],label:'Café € — “quoted”',private:'hide'};
 const encoded=encodeFields(schema,values),decoded=decodeFields(schema,encoded);
 assert.deepEqual(decoded,{count:3,values:values.values,label:values.label});
 assert.equal(decoded.bytesRead,encoded.length);assert.equal(Object.keys(decoded).includes('bytesRead'),false);
 const complete=encodeFields(schema,values,{scopes:['b','c']});
 assert.equal(decodeFields(schema,complete,{scopes:['b','c']}).private,'hide');
 const text='€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ café';
 assert.equal(decodeClientString(encodeClientString(text)),text);
 const bytes=encodeFields('bu1length;bu1data,length;;',{data:Buffer.from([0,128,255])});
 assert.deepEqual(decodeFields('bu1length;bu1data,length;;',bytes),{length:3,data:Buffer.from([0,128,255])});
});

test('CUTESI rejects invalid schemas, count mismatches, truncation, invalid values and oversized allocations',()=>{
 for(const schema of ['bu2count','bu2count;bu2count;;','bu1data,later;bu1later;;'])assert.throws(()=>parseSchema(schema),SchemaError);
 assert.throws(()=>encodeFields('bu1count;bu1data,count;;',{count:2,data:[1]}),/Array length differs/);
 assert.throws(()=>encodeFields('bi2value;;',{value:32768}),/out of range/);
 assert.throws(()=>encodeFields('bbflag;;',{flag:2}),/Boolean/);
 assert.throws(()=>decodeFields('bbflag;;',Buffer.from([2])),/Noncanonical boolean/);
 assert.throws(()=>decodeFields('bu4value;;',Buffer.alloc(3)),/Truncated/);
 assert.throws(()=>decodeFields('bsvalue;;',Buffer.from('no terminator')),/Unterminated/);
 assert.throws(()=>decodeFields('bu1count;bu1data,count;;',Buffer.from([255]),{maxArrayElements:4}),/out of bounds/);
 assert.throws(()=>encodeFields('bu1data,8;;',{}, {maxPayloadBytes:4}),/payload limit/);
 assert.throws(()=>decodeFields('bu1value;;',Buffer.from([1,0])),/trailing/);
 assert.equal(decodeFields('bu1value;;',Buffer.from([1,0]),{allowTrailingZeroBytes:1}).value,1);
 for(const text of ['embedded\0NUL','unsupported 😀'])assert.throws(()=>encodeClientString(text),SchemaError);
});

test('zero-RLE and contents-vector decoding enforce expanded size, escapes and complete record boundaries',()=>{
 const compressed=Buffer.from([0,0,0,7,1,255,3,255,255,2,3]);
 assert.deepEqual(decodeZeroRle(compressed),Buffer.from([1,0,0,0,255,2,3]));
 assert.throws(()=>decodeZeroRle(compressed,6),RangeError);
 assert.throws(()=>decodeZeroRle(Buffer.alloc(3)),/missing expanded/);
 assert.throws(()=>decodeZeroRle(Buffer.from([0,0,0,1,255])),/truncated.*escape/);
 assert.throws(()=>decodeZeroRle(Buffer.from([0,0,0,1,1,2])),/exceeds expanded/);
 assert.throws(()=>decodeZeroRle(Buffer.from([0,0,0,2,1])),/does not match/);
 const records=[Buffer.from([0,21,0,16]),Buffer.from([0,37,255,1,2])];
 const raw=Buffer.concat(records.flatMap(record=>{const size=Buffer.alloc(2);size.writeUInt16BE(record.length);return [size,record];}));
 assert.deepEqual(decodeContentsVector(expanded(raw)),records);
 for(const invalid of [[0],[0,1,0],[0,5,0,21]])assert.throws(()=>decodeContentsVector(expanded(invalid)),/contents-vector/);
});

test('empty caches require an explicit opt-in and malformed MAG headers remain rejected',async t=>{
 const directory=await temporaryDirectory(t);
 assert.throws(()=>new ResourceStore(),/clientDir is required/);
 assert.throws(()=>new ResourceStore({clientDir:directory}),/No valid MAG/);
 const empty=new ResourceStore({clientDir:directory,allowEmpty:true});
 assert.deepEqual(empty.bootstrapResources(),[]);assert.equal(empty.summary.magResources,0);assert.equal(empty.getResource(1),null);
 await mkdir(join(directory,'mag'));
 await writeFile(join(directory,'mag/cd060000.dat'),Buffer.alloc(1032));
 assert.throws(()=>new ResourceStore({clientDir:directory,allowEmpty:true}),error=>error instanceof CacheFormatError&&/MAG data header/.test(error.message));
});

test('synthetic indexed MAG admits only the exact live record, rejects stale aliases and returns defensive copies',async t=>{
 const directory=await temporaryDirectory(t),mag=join(directory,'mag');await mkdir(mag);
 const id=0x6002a,version=7,payload=Buffer.from('Authored test resource\0'),tableEnd=8+64*16;
 const data=Buffer.alloc(tableEnd+payload.length+4);
 data.writeUInt16BE(0x644d,0);data.writeUInt16BE(19,2);data.writeUInt16BE(1,6);
 for(let record=0;record<64;record++)data.writeUInt32BE(0xffffffff,8+record*16);
 data.writeUInt32BE(id,8);data.writeUInt32BE(version,12);data.writeUInt32BE(tableEnd,16);data.writeUInt32BE(payload.length,20);
 data.writeUInt16BE(0x734d,tableEnd);payload.copy(data,tableEnd+2);data.writeUInt16BE(0x654d,tableEnd+payload.length+2);
 const index=Buffer.alloc(2056);index.writeUInt16BE(0x694d,0);index.writeUInt16BE(19,2);
 for(let low=0;low<256;low++)index.writeUInt16BE(0x3fff,8+low*8);
 for(const low of [42,43]){index.writeUInt16BE(0,8+low*8);index.writeUInt16BE(0,10+low*8);index.writeUInt32BE(version,12+low*8);}
 const status=Buffer.alloc(12);status.writeUInt16BE(0x734d,0);status.writeUInt16BE(19,2);status.writeUInt32BE(123,8);
 await Promise.all([writeFile(join(mag,'cd060000.dat'),data),writeFile(join(mag,'widx0600.idx'),index),writeFile(join(mag,'w_status.dat'),status)]);
 const store=new ResourceStore({clientDir:directory});
 assert.deepEqual(store.bootstrapResources(),[{id,version,data:payload}]);assert.equal(store.resourceCursor,123);
 assert.equal(store.summary.magResources,1);assert.equal(store.summary.magPhysicalResources,1);assert.equal(store.summary.magIndexRejected,1);
 assert.equal(store.getResource(id+1),null);assert.equal(store.summary.anomalies[0].kind,'mag-index-mismatch');
 const copy=store.getResource(id);copy.data[0]=0;
 assert.deepEqual(store.getResource(id).data,payload);assert.match(store.resourceProfile,/^[a-f0-9]{64}$/);
 index.writeUInt32BE(version+1,12+42*8);await writeFile(join(mag,'widx0600.idx'),index);
 assert.throws(()=>new ResourceStore({clientDir:directory}),/No valid MAG/);
 const stale=new ResourceStore({clientDir:directory,allowEmpty:true});assert.equal(stale.summary.magIndexRejected,2);assert.deepEqual(stale.bootstrapResources(),[]);
});
