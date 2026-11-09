/** Resolve the package root from source or compiled modules, independent of cwd. */
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Source modules live one level below the package; emitted modules live two
// levels below it. Walking upward keeps both layouts independent of shell cwd.
let current = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(current, 'package.json'))) {
  const parent = dirname(current);
  if (parent === current) throw new Error('Cannot locate the browser client package.json');
  current = parent;
}
export const projectRoot = current;
