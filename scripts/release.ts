/** Create a source-only distribution from a positive file allowlist. */
import {createHash} from 'node:crypto';
import {copyFile,lstat,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectRoot} from './paths.js';

const top = new Set(['package.json','package-lock.json','tsconfig.json','README.md',
  'LICENSE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md',
  '.gitignore','.editorconfig','.env.example','.dockerignore','Dockerfile']);
const sourceTools = new Set(['build.ts','check.ts','paths.ts','release.ts',
  'setup-tcl.ts','asset-toolbar.ts','native-button-assets.ts']);
/** Decide source-release membership independently of Git tracking and ignore rules. */
export function isReleaseFile(file: string): boolean {
  return top.has(file) || /^(public|native)\/[^/]+\.ts$/.test(file)
    || /^public\/[^/]+\.(html|css|svg)$/.test(file)
    || /^server\/[^/]+\.(ts|tcl|md)$/.test(file)
    || (file.startsWith('scripts/') && sourceTools.has(file.slice('scripts/'.length)))
    || /^tests\/portable\/[^/]+\.test\.mjs$/.test(file)
    || file === '.github/workflows/ci.yml'
    || file === 'docs/architecture.md'
    || file === 'docs/licenses/Tcl-license.terms';
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(directory,{withFileTypes:true})) {
    if (['node_modules','dist','.runtime','release','.git','native-icons','screenshots','evidence'].includes(item.name)) continue;
    const full=join(directory,item.name), name=relative(projectRoot,full).split('\\').join('/');
    // Do not follow links into private caches or include links that would resolve
    // differently after a contributor extracts the source elsewhere.
    if(item.isSymbolicLink()) continue;
    if(item.isDirectory()) result.push(...await files(full));
    else if(isReleaseFile(name)) result.push(name);
  }
  return result.sort();
}

/** Rebuild the versioned staging tree and archive from allowed regular source files. */
export async function prepareRelease(): Promise<string> {
  const pkg=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8')) as {name:string;version:string};
  if(!/^[a-z0-9-]+$/.test(pkg.name)||!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error('Unsafe release name/version');
  const name=`${pkg.name}-${pkg.version}`, output=join(projectRoot,'release'), stage=join(output,name);
  await mkdir(output,{recursive:true});
  await rm(stage,{recursive:true,force:true});
  const hashes:Record<string,string>={};
  for(const file of await files(projectRoot)){
    const source=join(projectRoot,file);
    if(!(await lstat(source)).isFile())throw new Error(`Release input must be a regular file: ${file}`);
    const bytes=await readFile(source), text=bytes.toString('utf8');
    // Report paths only; never echo a matched credential into a build log.
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b|\/Users\/[^/\s]+\//.test(text))throw new Error(`Potential private material in release input: ${file}`);
    if(/^(public|server|native)\//.test(file)&&/from\s*['"][^'"]*wa-server\//.test(text))throw new Error(`External sibling dependency in ${file}`);
    const destination=join(stage,file);
    await mkdir(dirname(destination),{recursive:true});
    await copyFile(source,destination);
    hashes[file]=createHash('sha256').update(bytes).digest('hex');
  }
  // The manifest hashes source inputs, not itself; the separate archive digest
  // covers the complete packaged tree including this generated manifest.
  await writeFile(join(stage,'SOURCE_MANIFEST.json'),JSON.stringify({name:pkg.name,version:pkg.version,files:hashes},null,2)+'\n');
  const archive=join(output,`${name}.tar.gz`);
  // macOS copyfile metadata/resource forks are not part of the portable source.
  const result=spawnSync('tar',['-czf',archive,'-C',output,name],{stdio:'inherit',env:{...process.env,COPYFILE_DISABLE:'1'}});
  if(result.status!==0)throw new Error('Could not create source archive');
  const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`,`${digest}  ${name}.tar.gz\n`);
  console.log(`Prepared ${Object.keys(hashes).length} allowlisted source files: ${archive}`);
  return archive;
}

if(process.argv[1]&&/[/\\]release\.(ts|js)$/.test(process.argv[1]))await prepareRelease();
