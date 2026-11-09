import type { ClassRegistry } from '../native/classes.js';
import type { NativeObject } from './types.js';
import {decodeContentsVector} from '../native/world.js';

const MAX_CV_BYTES=16*1024*1024;
/** Numeric-only diagnostics; never includes object names, inventory, or payload bytes. */
export function contentsDiagnostics(input: Uint8Array){
 const data=Buffer.from(input);let written=0,offset=4,truncatedEscape=false;
 if(data.length>=4)for(;offset<data.length;offset++){if(data[offset]===255){if(++offset>=data.length){truncatedEscape=true;break;}written+=data[offset]===255?1:data[offset];}else written++;if(written>MAX_CV_BYTES)break;}
 return {bodyBytes:data.length,declaredExpandedBytes:data.length>=4?data.readUInt32BE(0):null,expandedBytesWritten:written,truncatedEscape};
}
// Incremental vectors are length-prefixed records without the region vector
// expansion header; treating that prefix as compressed data corrupts framing.
function rawRecords(input: Uint8Array){
 const data=Buffer.from(input);if(data.length>MAX_CV_BYTES)throw new Error('Contents vector exceeds browser limit');const records=[];
 for(let offset=0;offset<data.length;){if(offset+2>data.length)throw new Error('Truncated raw contents-vector record size');const size=data.readUInt16BE(offset);offset+=2;if(size<2||offset+size>data.length)throw new Error('Invalid raw contents-vector record size');records.push(data.subarray(offset,offset+size));offset+=size;}
 return records;
}
/** Resolve every record through its advertised class before returning any objects. */
function decodeRecords(records: Buffer[], registry: ClassRegistry): NativeObject[]{return records.map(record=>{const classNumber=record.readUInt16BE(0),fields=registry.decodeInstance(classNumber,record);return {noid:fields.noid,classNumber,className:registry.get(classNumber)?.name??`Class ${classNumber}`,fields};});}
/** Region101 explicitly zero-RLE decodes before unpacking. Tcl unpackContents
 * (wa32 0x447be0 -> 0x447b70 -> 0x442300) feeds its field bytes directly to the
 * record unpacker. Incremental CVs such as materialize2006 are therefore raw.
 * Accept the local compatibility server's compressed incremental CVs as well,
 * but require one complete, schema-valid interpretation before updating state.
 */
export function decodeNativeContents(input: Uint8Array,registry: ClassRegistry,{compressed=false}={}){
 const data=Buffer.from(input),attempts=compressed?['compressed']:['raw','compressed'];const failures=[];
 for(const mode of attempts){try{return {objects:decodeRecords(mode==='raw'?rawRecords(data):decodeContentsVector(data),registry),encoding:mode};}catch(error: any){failures.push(`${mode}: ${error.message}`);}}
 const error=new Error(`Contents vector could not be decoded (${failures.join('; ')})`);Object.assign(error,{diagnostics:contentsDiagnostics(data)});throw error;
}
