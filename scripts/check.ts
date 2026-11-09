/** Structural UI checks supplement the compiler, which cannot verify HTML IDs or URLs. */
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot} from './paths.js';
const html=await readFile(join(projectRoot,'dist/public/index.html'),'utf8');
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
const app=await readFile(join(projectRoot,'public/app.ts'),'utf8');
// These selectors refer to elements created by the UI rather than by index.html.
const dynamic=new Set(['action-search','avatar-mood','object-context']);
const errors:string[]=[];
for(const [,id]of app.matchAll(/\$\('#([a-z][\w-]*)'\)/g))if(!ids.has(id)&&!dynamic.has(id))errors.push(`Missing static UI element #${id}`);
for(const [,url]of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)){
  if(url==='/')continue;
  try{await readFile(join(projectRoot,'dist/public',url.slice(1)));}catch{errors.push(`Missing application asset ${url}`);}
}
// Prevent a second, unconverted production entry point from drifting beside TS.
for(const folder of ['public','server','native'])for(const file of await readdir(join(projectRoot,folder))){
  if(file.endsWith('.mjs'))errors.push(`Unconverted production JavaScript: ${folder}/${file}`);
}
if(errors.length)throw new Error(errors.join('\n'));
console.log('Checked strict TypeScript, compiled entry points, UI references, and static assets.');
