import type {NativeFields} from './types.js';
/** Native TAG_STRING storage. Source: wa32 0x4477c0,0x447730,0x444b60,
 * 0x444c20 and0x444d50. Only set/var/get/del/compare exist in that handler.
 * Handles are scoped identifiers, never native pointers or JavaScript code.
 */
import {encodeClientString,decodeClientString} from '../native/classes.js';

export class NativeLongStringError extends Error{constructor(message: string){super(message);this.name='NativeLongStringError';}}
export const NATIVE_LONG_STRING_OPERATIONS=Object.freeze(['set','var','get','del','compare']);
/** Reproduce the native textual handle and its low-nibble checksum. */
export function nativeStringHandle(id: number){
 if(!Number.isSafeInteger(id)||id<1||id>0xffffffff)throw new NativeLongStringError('Invalid TAG_STRING identifier');
 let bits=id,checksum=0;while(bits){checksum+=bits&15;bits=Math.floor(bits/16);}
 return `STR${id}STR${(checksum&15).toString(16)}`;
}
const usage='usage: lstring [set | var | get | del | compare] ...';
const own=(object: NativeFields,key: string)=>object!==null&&typeof object==='object'&&Object.hasOwn(object,key);
const thenValue=(value: any,callback: (value: any)=>any)=>value&&typeof value.then==='function'?value.then(callback):callback(value);

interface LongStringOptions {
 maxEntries?: number;maxStringBytes?: number;maxBytes?: number;
 getVariable?: (name: string,context: NativeFields)=>unknown;
 getBindingField?: (binding: string,field: string,context: NativeFields)=>unknown;
}
/** Session-scoped long strings with native byte comparison and explicit budgets. */
export class NativeLongStrings{
 limits: {maxEntries: number;maxStringBytes: number;maxBytes: number};
 getVariable: LongStringOptions['getVariable']; getBindingField: LongStringOptions['getBindingField'];
 values: Map<string,{text: string;bytes: Buffer;size: number}>;bytes: number;serial: number;
 constructor({maxEntries=4096,maxStringBytes=262144,maxBytes=8*1024*1024,getVariable,getBindingField}: LongStringOptions={}){
  for(const [name,value]of Object.entries({maxEntries,maxStringBytes,maxBytes}))if(!Number.isSafeInteger(value)||value<1)throw new TypeError(`Invalid long-string ${name}`);
  this.limits={maxEntries,maxStringBytes,maxBytes};this.getVariable=getVariable;this.getBindingField=getBindingField;this.values=new Map();this.bytes=0;this.serial=0;
 }
 text(value: unknown): string{
  // The native implementation copies strlen()+1, so embedded NUL terminates
  // a text value before storage and comparison. Preserve that C boundary.
  if(Buffer.isBuffer(value)||value instanceof Uint8Array){const bytes=Buffer.from(value),zero=bytes.indexOf(0);return decodeClientString(zero<0?bytes:bytes.subarray(0,zero));}
  if(value===undefined||value===null)return '';
  const string=String(value),zero=string.indexOf('\0');return zero<0?string:string.slice(0,zero);
 }
 create(value: unknown){
  const text=this.text(value);let bytes;try{bytes=encodeClientString(text);}catch(error: any){throw new NativeLongStringError(error.message);}
  const size=bytes.length+1;
  if(bytes.length>this.limits.maxStringBytes)throw new NativeLongStringError('Native long string exceeds its byte limit');
  if(this.values.size>=this.limits.maxEntries||this.bytes+size>this.limits.maxBytes)throw new NativeLongStringError('Native long-string storage is full');
  if(this.serial>=0xffffffff)throw new NativeLongStringError('Native long-string identifier space is exhausted');
  // Never reuse a released identifier: a stale script handle must not become
  // an alias for an unrelated string allocated later in the same session.
  const handle=nativeStringHandle(++this.serial);this.values.set(handle,{text,bytes,size});this.bytes+=size;return handle;
 }
 has(handle: unknown){return typeof handle==='string'&&this.values.has(handle);}
 get(handle: unknown){const value=this.values.get(String(handle));if(!value)throw new NativeLongStringError(`invalid lstring "${String(handle).slice(0,128)}"`);return value.text;}
 // Native callers may pass either an existing handle or literal text. Commands
 // that require a handle opt into strict resolution instead of coercing a miss.
 resolve(value: unknown,{strict=false}={}){if(this.has(value))return this.get(value);if(strict)throw new NativeLongStringError('invalid TAG_STRING id');return value;}
 delete(handle: unknown){const key=String(handle),value=this.values.get(key);if(!value)throw new NativeLongStringError('invalid TAG_STRING id');this.values.delete(key);this.bytes-=value.size;return '';}
 compare(left: unknown,right: unknown){
  const bytes=(value: unknown)=>{try{return encodeClientString(this.text(this.resolve(value)));}catch(error: any){throw new NativeLongStringError(error.message);}};
  const a=bytes(left),b=bytes(right),count=Math.max(a.length,b.length);
  for(let index=0;index<count;index++){const delta=(a[index]??0)-(b[index]??0);if(delta)return delta;}return 0;
 }
 dispatch(args: string[],context: NativeFields={}){
  if(!Array.isArray(args)||!args.length)throw new NativeLongStringError(usage);
  const [operation,...values]=args;
  switch(operation){
   case 'set':{
    if(values.length===1)return this.create(values[0]);
    if(values.length!==2)throw new NativeLongStringError('usage: lstring set { <value> | <binding> <field> }');
    const [binding,field]=values,lookup=this.getBindingField??context.getBindingField;
    const result=lookup?lookup(binding,field,context):own(context.bindings,binding)&&own(context.bindings[binding],field)?context.bindings[binding][field]:undefined;
    return thenValue(result,value=>{if(value===undefined)throw new NativeLongStringError(`unknown field "${field}" of struct "${binding}"`);return this.create(value);});
   }
   case 'var':{
    if(values.length!==1)throw new NativeLongStringError('usage: lstring var <variable>');
    const name=values[0],lookup=this.getVariable??context.getVariable,result=lookup?lookup(name,context):own(context.variables,name)?context.variables[name]:undefined;
    return thenValue(result,value=>{if(value===undefined)throw new NativeLongStringError(`invalid variable "${name}"`);return this.create(value);});
   }
   case 'get':if(values.length!==1)throw new NativeLongStringError('usage: lstring get <lstringid>');return this.get(values[0]);
   case 'del':if(values.length!==1)throw new NativeLongStringError('usage: lstring del <lstringid>');return this.delete(values[0]);
   case 'compare':if(values.length!==2)throw new NativeLongStringError('usage: lstring compare <str1> <str2>');return this.compare(values[0],values[1]);
   default:throw new NativeLongStringError(usage);
  }
 }
 // Keep serial monotonic across a world reset even though storage is released.
 clear(){this.values.clear();this.bytes=0;}
 get size(){return this.values.size;}
}
