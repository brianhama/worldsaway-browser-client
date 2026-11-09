import {projectRoot} from './paths.js';
import {resolve as resolveProjectPath} from 'node:path';
/** Extract the original WA Windows toolbar resources without running the EXE.
 * Reads PE RT_BITMAP/RT_ICON leaves and decodes uncompressed DIB pixels.
 * Extracted pixels retain the original Win32 16-color button backgrounds. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/asset-toolbar.ts /path/to/wa32.exe [output-directory]');
const input = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? resolveProjectPath(projectRoot,'public/native-icons'));
const data = await readFile(input), pe = data.readUInt32LE(0x3c);
if (data.readUInt32LE(pe) !== 0x4550) throw new Error('Invalid PE signature');
const optional = pe + 24, sections: any[] = [], count = data.readUInt16LE(pe + 6), directoryOffset = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
for (let i = 0; i < count; i++) { const p = optional + data.readUInt16LE(pe + 20) + i * 40; sections.push({ rva: data.readUInt32LE(p + 12), size: data.readUInt32LE(p + 16), file: data.readUInt32LE(p + 20) }); }
function fromRva(rva: any) { const section = sections.find((s: any) => rva >= s.rva && rva < s.rva + s.size); if (!section) throw new Error('Resource RVA outside PE sections'); return section.file + rva - section.rva; }
const resourceRva = data.readUInt32LE(directoryOffset + 16), base = fromRva(resourceRva), leaves: any[] = [];
/** Walk PE resource directories as data; bound depth and reject cycles before descent. */
function visit(relative: any, path: any = [], seen: any = new Set()) {
  if (seen.has(relative) || path.length > 4) throw new Error('Invalid PE resource tree');
  const p = base + relative, entries = data.readUInt16LE(p + 12) + data.readUInt16LE(p + 14);
  if (entries > 4096) throw new Error('Excessive PE resources');
  for (let i = 0; i < entries; i++) { const q = p + 16 + i * 8, id = data.readUInt32LE(q), target = data.readUInt32LE(q + 4), key = id & 0x80000000 ? `name@${id & 0x7fffffff}` : id;
    if (target & 0x80000000) visit(target & 0x7fffffff, [...path, key], new Set([...seen, relative]));
    else { const descriptor = base + target, offset = fromRva(data.readUInt32LE(descriptor)), size = data.readUInt32LE(descriptor + 4); if (offset + size > data.length) throw new Error('Truncated PE resource'); leaves.push({ path: [...path, key], data: data.subarray(offset, offset + size) }); }
  }
}
visit(0);
function crc32(bytes: any) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
/** Write RGBA PNGs directly so extracting legacy UI needs no image-library runtime. */
function png(width: any, height: any, pixels: any) {
  const chunks = [Buffer.from([137,80,78,71,13,10,26,10])];
  function chunk(type: any, body: any) { const name = Buffer.from(type), header = Buffer.alloc(4), crc = Buffer.alloc(4); header.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([name, body]))); chunks.push(header, name, body, crc); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; chunk('IHDR', ihdr);
  const rows = Buffer.alloc(height * (width * 4 + 1)); for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  chunk('IDAT', deflateSync(rows)); chunk('IEND', Buffer.alloc(0)); return Buffer.concat(chunks);
}
function dib(bytes: any) {
  if (bytes.readUInt32LE(0) < 40 || bytes.readUInt32LE(16) !== 0) throw new Error('Unsupported DIB compression/header');
  const width = bytes.readInt32LE(4), signedHeight = bytes.readInt32LE(8), height = Math.abs(signedHeight), bpp = bytes.readUInt16LE(14), count = bytes.readUInt32LE(32) || (bpp <= 8 ? 1 << bpp : 0), header = bytes.readUInt32LE(0), stride = Math.ceil(width * bpp / 32) * 4, start = header + count * 4;
  if (width <= 0 || height <= 0 || width * height > 4000000 || ![1,4,8,24,32].includes(bpp) || start + stride * height > bytes.length) throw new Error('Invalid DIB dimensions/bounds');
  const pixels = new Uint8Array(width * height * 4);
  // Positive DIB heights store rows bottom-up. Normalize both orientations to
  // top-down RGBA while expanding packed palette indices and BGR channels.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = start + (signedHeight > 0 ? height - y - 1 : y) * stride, out = (y * width + x) * 4; let color;
    if (bpp <= 8) { const bit = x * bpp, index = bytes[row + (bit >>> 3)] >>> (8 - bpp - (bit & 7)) & ((1 << bpp) - 1), p = header + index * 4; color = [bytes[p + 2], bytes[p + 1], bytes[p], 255]; }
    else { const p = row + x * bpp / 8; color = [bytes[p + 2], bytes[p + 1], bytes[p], bpp === 32 ? bytes[p + 3] : 255]; }
    pixels.set(color, out);
  }
  return { width, height, pixels };
}
function crop(image: any, x: any, y: any, width: any, height: any) { const pixels = new Uint8Array(width * height * 4); for (let row = 0; row < height; row++) pixels.set(image.pixels.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4), row * width * 4); return { width, height, pixels }; }
await mkdir(output, { recursive: true });
const manifest: Record<string, any> = { source: 'wa32.exe', sourceSha256: createHash('sha256').update(data).digest('hex'), resources: [] };
for (const [id, name] of [[15390, 'toolbar-strip'], [15391, 'controls-strip']]) {
  const leaf = leaves.find((item: any) => item.path[0] === 2 && item.path[1] === id); if (!leaf) throw new Error(`Missing RT_BITMAP ${id}`);
  const image = dib(leaf.data); await writeFile(`${output}/${name}.png`, png(image.width, image.height, image.pixels)); manifest.resources.push({ file: `${name}.png`, resourcePath: leaf.path, width: image.width, height: image.height, sha256: createHash('sha256').update(leaf.data).digest('hex') });
  const rows = id === 15391 ? 21 : 3, columns = id === 15391 ? 6 : 8, prefix = id === 15391 ? 'control' : 'speech';
  const labels = id === 15391 ? ['west','north','south','east','ghost','avatar','neutral','happy','sad','angry','wave','bow','shrug','present','jump','react','turn-left','turn-right','turn-around','clock','tokens'] : ['speak','think','esp'];
  manifest.buttons ??= [];
  for (let row = 0; row < rows; row++) {
    const button = crop(image, 0, row * 28, 29, 28), stem = `${prefix}-${String(row).padStart(2,'0')}`;
    await writeFile(`${output}/${stem}.png`, png(button.width, button.height, button.pixels));
    // Standalone glyphs let CSS supply a native focus/pressed border without
    // doubling the border already present in the complete button resource.
    const glyph = crop(image, 4, row * 28 + 4, 20, 20);
    await writeFile(`${output}/${stem}-glyph.png`, png(glyph.width, glyph.height, glyph.pixels));
    for (let column = 1; column < columns; column++) {
      const state = crop(image, column * 29, row * 28, 29, 28);
      await writeFile(`${output}/${stem}-state-${column}.png`, png(state.width, state.height, state.pixels));
    }
    manifest.buttons.push({ file: `${stem}.png`, glyph: `${stem}-glyph.png`, label: labels[row], width:29, height:28, source: {file:`${name}.png`,x:0,y:row*28}, states:columns });
  }
}
const icon = leaves.find((item: any) => item.path[0] === 3 && item.path[1] === 1); if (icon?.data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) await writeFile(`${output}/app-icon.png`, icon.data);
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
