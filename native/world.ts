/** Bounded decoder for native zero-RLE contents vectors. */
const MAX_EXPANDED_CV = 16 * 1024 * 1024;

/** Expand a size-prefixed byte stream, bounding allocation before decoding.
 * FF FF represents a literal FF; other FF/count pairs represent runs of zeros.
 * The decoded size must exactly match the advertised size, including short input.
 */
export function decodeZeroRle(input: Uint8Array, maxExpandedSize: any = MAX_EXPANDED_CV) {
  const data = Buffer.from(input);
  if (data.length < 4) throw new Error('missing expanded contents-vector size');
  const size = data.readUInt32BE(0);
  if (!Number.isSafeInteger(maxExpandedSize) || maxExpandedSize < 0 || size > maxExpandedSize) {
    throw new RangeError('expanded contents vector is too large');
  }
  const result = Buffer.alloc(size);
  let write = 0;
  for (let offset = 4; offset < data.length; offset++) {
    let value = data[offset];
    let count = 1;
    if (value === 255) {
      if (++offset >= data.length) throw new Error('truncated contents-vector escape');
      count = data[offset];
      if (count === 255) count = 1;
      else value = 0;
    }
    if (write + count > size) throw new Error('contents vector exceeds expanded size');
    result.fill(value, write, write + count);
    write += count;
  }
  if (write !== size) throw new Error('contents vector does not match expanded size');
  return result;
}


/** Split an expanded vector into uint16-length-prefixed object instances.
 * Each object keeps its class bytes; the class registry performs field decoding.
 * Incremental, uncompressed vectors are handled separately by server/contents.
 */
export function decodeContentsVector(input: Uint8Array) {
  const data = decodeZeroRle(input);
  const objects: Buffer[] = [];
  for (let offset = 0; offset < data.length;) {
    if (offset + 2 > data.length) throw new Error('truncated contents-vector object size');
    const size = data.readUInt16BE(offset);
    offset += 2;
    if (size < 2 || offset + size > data.length) throw new Error('invalid contents-vector object');
    objects.push(Buffer.from(data.subarray(offset, offset + size)));
    offset += size;
  }
  return objects;
}
