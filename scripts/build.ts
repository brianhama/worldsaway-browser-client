/** Compile checked ESM and copy web assets plus optional native button images. */
import {spawnSync} from 'node:child_process';
import {mkdir,readdir,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot} from './paths.js';
// Clear old output first: a renamed or deleted source module must not remain
// runnable as stale JavaScript and conceal a broken clean-checkout build.
await rm(join(projectRoot,'dist'),{recursive:true,force:true});
const compiler = join(projectRoot,'node_modules/typescript/bin/tsc');
const compiled = spawnSync(process.execPath,[compiler,'-p',join(projectRoot,'tsconfig.json')],{cwd:projectRoot,stdio:'inherit'});
if(compiled.status !== 0) process.exit(compiled.status ?? 1);
// Copy static files by extension rather than copying public wholesale. Native
// fonts, caches, and other local files remain outside the application output.
await mkdir(join(projectRoot,'dist/public'),{recursive:true});
for(const file of await readdir(join(projectRoot,'public'))){
  if(/\.(html|css|svg)$/.test(file)) await copyFile(join(projectRoot,'public',file),join(projectRoot,'dist/public',file));
}
// Button images are supplied separately from the source release. Include only
// the known complete controls and their states, never arbitrary local extracts.
const nativeIcons=join(projectRoot,'public/native-icons');
const iconFiles=await readdir(nativeIcons,{withFileTypes:true}).catch((error: NodeJS.ErrnoException)=>{
  if(error.code==='ENOENT')return [];
  throw error;
});
let nativeIconCount=0;
for(const item of iconFiles){
  if(!item.isFile()||!/^(?:control-(?:[01][0-9]|20)(?:-state-[1-5])?|speech-0[0-2](?:-state-[1-7])?)\.png$/.test(item.name))continue;
  const destination=join(projectRoot,'dist/public/native-icons');
  if(nativeIconCount===0)await mkdir(destination,{recursive:true});
  await copyFile(join(nativeIcons,item.name),join(destination,item.name));
  nativeIconCount++;
}
// Tcl workers are source assets, not TypeScript modules, and need an explicit copy.
await mkdir(join(projectRoot,'dist/server'),{recursive:true});
for(const file of await readdir(join(projectRoot,'server'))){
  if(file.endsWith('.tcl')) await copyFile(join(projectRoot,'server',file),join(projectRoot,'dist/server',file));
}
console.log(`Built TypeScript server, native codecs, browser modules, static assets, and ${nativeIconCount} optional native button images.`);
