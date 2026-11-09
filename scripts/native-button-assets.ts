/** The complete Windows button set allowed into an application build. */
import {lstat,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';

export const NATIVE_BUTTON_FILES: readonly string[] = Object.freeze([
  ...Array.from({length:21},(_,row)=>Array.from({length:6},(_,state)=>
    `control-${String(row).padStart(2,'0')}${state?`-state-${state}`:''}.png`)).flat(),
  ...Array.from({length:3},(_,row)=>Array.from({length:8},(_,state)=>
    `speech-${String(row).padStart(2,'0')}${state?`-state-${state}`:''}.png`)).flat(),
]);

function crc32(bytes: Buffer): number {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc>>>1^(crc&1?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}

/** Verify the actual PNG, not just its extension, before replacing build output. */
function validateButton(bytes: Buffer): void {
  if(bytes.length>65536||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw new Error('invalid PNG signature or size');
  let offset=8, header=false, ended=false;
  const imageData: Buffer[]=[];
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset), end=offset+12+length;
    if(end>bytes.length)throw new Error('truncated PNG chunk');
    const type=bytes.toString('ascii',offset+4,offset+8), data=bytes.subarray(offset+8,end-4);
    if(crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw new Error('PNG checksum mismatch');
    if(!header&&type!=='IHDR')throw new Error('missing PNG header');
    if(type==='IHDR'){
      if(header||length!==13||data.readUInt32BE(0)!==29||data.readUInt32BE(4)!==28
        ||data[8]!==8||data[9]!==6||data[10]!==0||data[11]!==0||data[12]!==0)
        throw new Error('expected a non-interlaced 29 × 28 RGBA PNG');
      header=true;
    } else if(type==='IDAT')imageData.push(data);
    else if(type==='IEND'){
      if(length!==0||end!==bytes.length)throw new Error('invalid PNG end');
      ended=true;break;
    }
    offset=end;
  }
  if(!ended||!imageData.length)throw new Error('incomplete PNG');
  const stride=29*4+1, pixels=inflateSync(Buffer.concat(imageData),{maxOutputLength:28*stride});
  if(pixels.length!==28*stride)throw new Error('invalid PNG pixel length');
  for(let row=0;row<28;row++)if(pixels[row*stride]>4)throw new Error('invalid PNG row filter');
}

/** Source-only builds may omit artwork entirely. Partial or corrupt sets fail
 * in every mode; hosted builds also require the complete set to be present. */
export async function loadNativeButtons(directory: string,{required=false}: {required?:boolean} = {}): Promise<{name:string;bytes:Buffer}[]> {
  const entries=await readdir(directory).catch((error: NodeJS.ErrnoException)=>{
    if(error.code==='ENOENT')return [];
    throw error;
  });
  const present=new Set(entries), found=NATIVE_BUTTON_FILES.filter(name=>present.has(name));
  if(!found.length&&!required)return [];
  const missing=NATIVE_BUTTON_FILES.filter(name=>!present.has(name));
  if(missing.length)throw new Error(`Native Windows buttons are incomplete: missing ${missing.length} of ${NATIVE_BUTTON_FILES.length} files (${missing.slice(0,3).join(', ')}). Supply the complete public/native-icons set before building.`);
  return Promise.all(NATIVE_BUTTON_FILES.map(async name=>{
    const path=join(directory,name);
    try{
      if(!(await lstat(path)).isFile())throw new Error('expected a regular file');
      const bytes=await readFile(path);
      validateButton(bytes);
      return {name,bytes};
    }catch(error){throw new Error(`Invalid native button ${name}: ${(error as Error).message}`);}
  }));
}
