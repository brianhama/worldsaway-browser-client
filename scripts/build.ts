/** Compile checked ESM and copy web assets plus optional native button images. */
import {spawnSync} from 'node:child_process';
import {mkdir,readdir,copyFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot} from './paths.js';
import {loadNativeButtons} from './native-button-assets.js';
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--require-native-buttons'))throw new Error('Usage: npm run build -- [--require-native-buttons]');
// Validate and retain the complete artwork before touching the previous build.
// Production must never silently replace Windows buttons with placeholders.
const nativeButtons=await loadNativeButtons(join(projectRoot,'public/native-icons'),{required:args.includes('--require-native-buttons')});
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
// Copy only the validated cells, never arbitrary neighboring local extracts.
if(nativeButtons.length)await mkdir(join(projectRoot,'dist/public/native-icons'),{recursive:true});
for(const {name,bytes} of nativeButtons)await writeFile(join(projectRoot,'dist/public/native-icons',name),bytes);
// Tcl workers are source assets, not TypeScript modules, and need an explicit copy.
await mkdir(join(projectRoot,'dist/server'),{recursive:true});
for(const file of await readdir(join(projectRoot,'server'))){
  if(file.endsWith('.tcl')) await copyFile(join(projectRoot,'server',file),join(projectRoot,'dist/server',file));
}
console.log(`Built TypeScript server, native codecs, browser modules, static assets, and ${nativeButtons.length} native button images.`);
