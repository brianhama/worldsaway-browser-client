import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {NATIVE_BUTTON_FILES,loadNativeButtons} from '../../dist/scripts/native-button-assets.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc>>>1^(crc&1?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([head,name,data,tail]);}
function png({width=29,pixels=Buffer.alloc(28*(29*4+1)),compressed}={}){
    const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(28,4);header[8]=8;header[9]=6;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',compressed??deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function temporary(t){const path=await mkdtemp(join(tmpdir(),'native-button-assets-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function complete(directory){const bytes=png();await Promise.all(NATIVE_BUTTON_FILES.map(name=>writeFile(join(directory,name),bytes)));return bytes;}

test('source-only builds can omit artwork; hosted builds require all 150 cells',async t=>{
    const path=join(await temporary(t),'missing');
    assert.deepEqual(await loadNativeButtons(path),[]);
    await assert.rejects(loadNativeButtons(path,{required:true}),/missing 150 of 150/);
    assert.equal(NATIVE_BUTTON_FILES.length,150);assert.equal(new Set(NATIVE_BUTTON_FILES).size,150);
});

test('a complete validated set excludes unrelated neighboring files',async t=>{
    const path=await temporary(t),bytes=await complete(path);
    await writeFile(join(path,'controls-strip.png'),'not an allowed button');
    await writeFile(join(path,'manifest.json'),'{}');
    const assets=await loadNativeButtons(path,{required:true});
    assert.deepEqual(assets.map(asset=>asset.name),NATIVE_BUTTON_FILES);
    assert(assets.every(asset=>asset.bytes.equals(bytes)));
});

test('partial artwork cannot produce a mixed Windows/placeholder build in either mode',async t=>{
    const path=await temporary(t);await writeFile(join(path,NATIVE_BUTTON_FILES[0]),png());
    for(const required of [false,true])await assert.rejects(loadNativeButtons(path,{required}),/missing 149 of 150/);
});

test('corrupt dimensions, chunks, compression, and row data fail validation',async t=>{
    const path=await temporary(t),valid=await complete(path),name=NATIVE_BUTTON_FILES[0];
    const badChecksum=Buffer.from(valid);badChecksum[29]^=1;
    for(const [bytes,message] of [
        [png({width:30}),/29 × 28/],
        [badChecksum,/checksum mismatch/],
        [valid.subarray(0,valid.length-3),/incomplete PNG/],
        [png({compressed:Buffer.from('invalid zlib')}),/Invalid native button/],
        [png({pixels:Buffer.alloc(5)}),/pixel length/],
        [png({pixels:Buffer.alloc(28*(29*4+1),5)}),/row filter/],
    ]){
        await writeFile(join(path,name),bytes);
        await assert.rejects(loadNativeButtons(path,{required:true}),message);
    }
});

test('a strict build with missing artwork fails before deleting the last working dist',async t=>{
    const stage=await temporary(t);
    await mkdir(join(stage,'scripts'));await mkdir(join(stage,'dist'));
    await writeFile(join(stage,'package.json'),'{"type":"module"}');
    await writeFile(join(stage,'dist','previous-build'),'keep this working build');
    for(const name of ['build.ts','paths.ts','native-button-assets.ts'])await copyFile(join(root,'scripts',name),join(stage,'scripts',name));
    const result=spawnSync(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),join(stage,'scripts/build.ts'),'--require-native-buttons'],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/missing 150 of 150/);
    assert.equal(await readFile(join(stage,'dist','previous-build'),'utf8'),'keep this working build');
});
