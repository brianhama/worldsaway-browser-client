#!/usr/bin/env node
/** Build the official pinned Tcl sources locally; no system installation. */
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {projectRoot} from './paths.js';
export const TCL_VERSION='8.6.16';
export const TCL_SOURCE_URL='https://codeload.github.com/tcltk/tcl/tar.gz/refs/tags/core-8-6-16';
export const TCL_SOURCE_SHA256='05c061cca79a17efc61ef7c1cd873227a02a7c1fdc114aa6a4ecdd33ecf167f4';
const root=projectRoot;
export const TCL_RUNTIME_DIR=resolve(root,'.runtime',`tcl-${TCL_VERSION}`);
export const TCL_EXECUTABLE=resolve(TCL_RUNTIME_DIR,'bin','tclsh8.6');
const run=(command: string,args: string[],{cwd,input,quiet=false}: {cwd?: string; input?: string; quiet?: boolean}={})=>new Promise<string>((resolve,reject)=>{
 const child=spawn(command,args,{cwd,stdio:['pipe',quiet?'pipe':'inherit',quiet?'pipe':'inherit']});let output='';
 if(quiet){child.stdout!.on('data',(chunk: any)=>{output+=chunk;if(output.length>1048576)child.kill();});child.stderr!.on('data',(chunk: any)=>{output+=chunk;if(output.length>1048576)child.kill();});}
 child.on('error',reject);child.on('exit',(code: any)=>code===0?resolve(output):reject(new Error(`${command} exited ${code}${quiet?`: ${output.slice(-2000)}`:''}`)));child.stdin!.end(input??'');
});
/** Probe coroutine support as well as version: host RPC depends on yielding Tcl tasks. */
export async function checkTcl(executable: string=TCL_EXECUTABLE){
 const version=(await run(executable,[],{quiet:true,input:'puts [info patchlevel]\nputs [expr {[llength [info commands coroutine]] > 0}]\n'})).trim().split(/\s+/);
 if(!/^8\.(?:[6-9]|[1-9]\d)\./.test(version[0])||version[1]!=='1')throw new Error(`A coroutine-capable Tcl 8.6+ runtime is required; found ${version[0]??'unknown'}.`);
 return version[0];
}
/** Reuse a compatible local install, or build the checksum-pinned official source. */
export async function setupTcl({force=false}: {force?: boolean}={}){
 if(!force){try{const version=await checkTcl();return {version,executable:TCL_EXECUTABLE,existing:true};}catch{}}
 const runtime=resolve(root,'.runtime'),archive=resolve(runtime,'tcl-core-8-6-16.tar.gz'),source=resolve(runtime,'tcl-core-8-6-16');
 await mkdir(runtime,{recursive:true});let bytes;try{bytes=await readFile(archive);}catch{}
 // Verify cached downloads too. No archive is extracted or compiled until its
 // digest matches the reviewed source release, regardless of download origin.
 if(!bytes||createHash('sha256').update(bytes).digest('hex')!==TCL_SOURCE_SHA256){
  const response=await fetch(TCL_SOURCE_URL);if(!response.ok)throw new Error(`Official Tcl download failed: HTTP ${response.status}`);
  bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==TCL_SOURCE_SHA256)throw new Error('Official Tcl source checksum mismatch.');
  await writeFile(archive,bytes);
 }
 await rm(source,{recursive:true,force:true});await run('tar',['-xzf',archive,'-C',runtime]);
 await access(resolve(source,'unix','configure'));
 // Keep the upstream loader compiled: --disable-load has an incompatible
 // TclpLoadMemoryGetBuffer declaration in this pinned release on Apple Clang.
 // Safe child interpreters never expose load or unload.
 await run('./configure',[`--prefix=${TCL_RUNTIME_DIR}`,'--disable-shared','--disable-threads'],{cwd:resolve(source,'unix')});
 await run('make',['-j2'],{cwd:resolve(source,'unix')});
 await run('make',['install'],{cwd:resolve(source,'unix')});
 return {version:await checkTcl(),executable:TCL_EXECUTABLE,existing:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.includes('--check'))console.log(JSON.stringify({version:await checkTcl(),executable:TCL_EXECUTABLE}));else console.log(JSON.stringify(await setupTcl({force:process.argv.includes('--force')})));}
 catch(error: any){console.error(error.message);process.exitCode=1;}
}
