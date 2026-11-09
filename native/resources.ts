import type {NativeResource} from './protocol.js';

/** allowEmpty enables fresh bridge startup; it does not relax validation of files present. */
export interface ResourceStoreOptions { clientDir?: string; maxFileBytes?: number; filterClassDependencies?: number[] | 'all'; allowEmpty?: boolean; }
export interface FileAsset {version: number; checksum: number; data: Buffer;}
/** Read-only resource adapters for the supplied WorldsAway/AltAway caches.
 *
 * MAG identity/version checks are separate from WSRES filename/checksum checks.
 * No Tcl, executable, configuration, remembered account database or log is read
 * or executed here. The input cache is never modified.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAG_HEADER_BYTES = 8;
const MAG_RECORD_BYTES = 16;
const MAG_TABLE_END = MAG_HEADER_BYTES + 64 * MAG_RECORD_BYTES;

export class CacheFormatError extends Error {
  declare name: any;

  constructor(message: any) {
    super(message);
    this.name = 'CacheFormatError';
  }
}

const hash = (data: any) => createHash('sha256').update(data).digest('hex');
const hex = (value: any) => value.toString(16).padStart(8, '0');

/** Check both stat and read results so a changing cache cannot bypass size limits. */
function readBounded(path: any, maximum: any) {
  const info = statSync(path);
  if (!info.isFile() || info.size > maximum) {
    throw new CacheFormatError(`Cache file is not regular or exceeds the size limit: ${path}`);
  }
  const data = readFileSync(path);
  if (data.length !== info.size || data.length > maximum) {
    throw new CacheFormatError(`Cache changed while reading: ${path}`);
  }
  return data;
}

function directoryNames(path: any) {
  try {
    return readdirSync(path).sort();
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Exact unsigned recurrence recovered from native cache routine 0040d410.
const CHECKSUM_TABLE = Uint32Array.from({ length: 256 }, (_: any, byte: any) => {
  let value = byte >>> 2;
  for (const shift of [24, 23, 22, 20, 19, 17, 16, 14, 13, 12, 8, 2, 1]) {
    value ^= byte << shift;
  }
  if (byte & 1) value ^= 0x76dc4190;
  if (byte & 2) value ^= 0xede88320;
  return value >>> 0;
});

export function cacheChecksum(data: Iterable<number>): number {
  let value = 0;
  for (const byte of data) {
    value = ((value >>> 8) ^ CHECKSUM_TABLE[(value ^ byte) & 255]) >>> 0;
  }
  return value;
}

function validFilename(name: any) {
  return typeof name === 'string' && name.length > 0 && name.length < 64
    && /^[\x20-\x7e]+$/.test(name) && !/[\\/:\0]/.test(name)
    && name !== '.' && name !== '..';
}

/** Return physical records with a matching live index entry.
 *
 * A stale index slot may point to a different current record. Such slots are
 * recorded as anomalies and never create a second alias for that payload.
 */
function readMag(directory: any, anomalies: any) {
  const names = directoryNames(directory);
  const physical = new Map();
  const locations = new Map();
  const live = new Map();
  let indexEntries = 0;
  let invalidIndexEntries = 0;

  for (const name of names) {
    const match = /^cd([\da-f]{2})([\da-f]{4})\.dat$/i.exec(name);
    if (!match) continue;
    const data = readBounded(join(directory, name), MAX_CACHE_BYTES);
    if (data.length < MAG_TABLE_END || data.readUInt16BE(0) !== 0x644d
        || data.readUInt16BE(2) !== 19 || data.readUInt16BE(6) > 64) {
      throw new CacheFormatError(`Invalid version-19 MAG data header: ${name}`);
    }
    const type = Number.parseInt(match[1], 16);
    const fileNumber = Number.parseInt(match[2], 16);
    const count = data.readUInt16BE(6);
    for (let record = 0; record < 64; record++) {
      const position = MAG_HEADER_BYTES + record * MAG_RECORD_BYTES;
      const id = data.readUInt32BE(position);
      if (id === 0xffffffff) continue;
      const version = data.readUInt32BE(position + 4);
      const offset = data.readUInt32BE(position + 8);
      const size = data.readUInt32BE(position + 12);
      if (record >= count || (id >>> 16) !== type || offset < MAG_TABLE_END
          || offset > data.length || size > data.length - offset - 4) {
        anomalies.push({ kind: 'mag-invalid-record', file: name, record, id });
        continue;
      }
      if (data.readUInt16BE(offset) !== 0x734d || data.readUInt16BE(offset + size + 2) !== 0x654d) {
        anomalies.push({ kind: 'mag-invalid-markers', file: name, record, id });
        continue;
      }
      if (physical.has(id)) throw new CacheFormatError(`Duplicate physical MAG resource: ${hex(id)}`);
      const resource: Record<string, any> = { id, version, data: data.subarray(offset + 2, offset + 2 + size) };
      physical.set(id, resource);
      locations.set(`${type}:${fileNumber}:${record}`, resource);
    }
  }

  for (const name of names) {
    const match = /^widx([\da-f]{2})([\da-f]{2})\.idx$/i.exec(name);
    if (!match) continue;
    const data = readBounded(join(directory, name), 2056);
    if (data.length !== 2056 || data.readUInt16BE(0) !== 0x694d || data.readUInt16BE(2) !== 19) {
      throw new CacheFormatError(`Invalid version-19 MAG index header: ${name}`);
    }
    const type = Number.parseInt(match[1], 16);
    const high = Number.parseInt(match[2], 16);
    for (let low = 0; low < 256; low++) {
      const position = 8 + low * 8;
      const fileNumber = data.readUInt16BE(position);
      if (fileNumber === 0x3fff) continue;
      indexEntries++;
      const record = data.readUInt16BE(position + 2);
      const version = data.readUInt32BE(position + 4);
      const id = type * 65536 + high * 256 + low;
      const found = locations.get(`${type}:${fileNumber}:${record}`);
      if (!found || found.id !== id || found.version !== version) {
        invalidIndexEntries++;
        anomalies.push({ kind: 'mag-index-mismatch', file: name, slot: low, id,
          version, actualId: found?.id ?? null, actualVersion: found?.version ?? null });
        continue;
      }
      if (live.has(id)) throw new CacheFormatError(`Duplicate live MAG index: ${hex(id)}`);
      live.set(id, found);
    }
  }

  let resourceCursor = 0;
  if (names.includes('w_status.dat')) {
    const data = readBounded(join(directory, 'w_status.dat'), 12);
    if (data.length !== 12 || data.readUInt16BE(0) !== 0x734d || data.readUInt16BE(2) !== 19) {
      throw new CacheFormatError('Invalid MAG status cursor header');
    }
    resourceCursor = data.readUInt32BE(8);
  }
  return { resources: live, physicalCount: physical.size, indexEntries, invalidIndexEntries, resourceCursor };
}

/** Admit only committed WSRES records whose filename, bounds, and checksum agree. */
function readFilenameCache(directory: any, maximum: any, anomalies: any) {
  const names = directoryNames(directory);
  const files = new Map();
  const ambiguous = new Set();
  let pairs = 0;
  let rejected = 0;
  let committedEntries = 0;
  let uncommittedFilenameBytes = 0;

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.idx')) continue;
    const dataName = name.slice(0, -4) + '.dat';
    if (!names.includes(dataName)) {
      anomalies.push({ kind: 'wsres-index-without-data', file: name });
      continue;
    }
    const index = readBounded(join(directory, name), MAX_INDEX_BYTES);
    const data = readBounded(join(directory, dataName), MAX_CACHE_BYTES);
    if (index.length < 24 || data.length < 4 || index.readUInt32LE(0) !== 0x50424958
        || data.readUInt32LE(0) !== 0x50424446) {
      throw new CacheFormatError(`Invalid WSRES filename cache header: ${name}`);
    }
    const count = index.readUInt32LE(4);
    const recordsStart = index.readUInt32LE(8);
    const recordsSize = index.readUInt32LE(12);
    const namesStart = index.readUInt32LE(16);
    const namesSize = index.readUInt32LE(20);
    const recordsEnd = recordsStart + recordsSize;
    const namesEnd = namesStart + namesSize;
    if (count > 1000000 || recordsSize !== count * 28 || recordsStart < 24
        || recordsEnd > namesStart || namesEnd > index.length) {
      throw new CacheFormatError(`Invalid WSRES committed index ranges: ${name}`);
    }
    // Filename bytes beyond namesEnd may be an unfinished write. Never promote
    // that tail into committed filenames or infer missing records from it.
    const pool = index.subarray(namesStart, namesEnd);
    if (count && (!pool.length || pool[pool.length - 1] !== 0)) {
      throw new CacheFormatError(`Unterminated WSRES filename pool: ${name}`);
    }
    const filenames = count ? pool.subarray(0, -1).toString('latin1').split('\0') : [];
    if (filenames.length !== count || filenames.some((filename: any) => !filename)) {
      throw new CacheFormatError(`WSRES filename count mismatch: ${name}`);
    }
    pairs++;
    committedEntries += count;
    uncommittedFilenameBytes += index.length - namesEnd;
    if (namesEnd < index.length) {
      anomalies.push({ kind: 'wsres-uncommitted-filename-tail', file: name, bytes: index.length - namesEnd });
    }
    const seen = new Set();
    for (let record = 0; record < count; record++) {
      const filename = filenames[record];
      if (seen.has(filename)) {
        rejected++;
        files.delete(filename);
        ambiguous.add(filename);
        anomalies.push({ kind: 'wsres-duplicate-committed-filename', file: name, record, filename });
        continue;
      }
      seen.add(filename);
      const position = recordsStart + record * 28;
      const checksum = index.readUInt32LE(position);
      const version = index.readUInt32LE(position + 4);
      const offset = index.readUInt32LE(position + 8);
      const size = index.readUInt32LE(position + 16);
      if (!validFilename(filename) || offset < 4 || offset > data.length
          || size > data.length - offset || size > maximum) {
        rejected++;
        anomalies.push({ kind: 'wsres-invalid-record', file: name, record, filename });
        continue;
      }
      const payload = data.subarray(offset, offset + size);
      if (cacheChecksum(payload) !== checksum) {
        rejected++;
        anomalies.push({ kind: 'wsres-checksum-mismatch', file: name, record, filename });
        continue;
      }
      const entry: Record<string, any> = { version, checksum, data: payload, digest: hash(payload) };
      const previous = files.get(filename);
      // Conflicting payloads for one filename are ambiguous, even if one claims
      // a newer version. Do not pick artwork based on directory iteration order.
      if (previous && previous.digest !== entry.digest) {
        files.delete(filename);
        ambiguous.add(filename);
        anomalies.push({ kind: 'wsres-ambiguous-filename', file: name, filename });
      } else if (!ambiguous.has(filename) && (!previous || previous.version < version)) {
        files.set(filename, entry);
      }
    }
  }
  return { files, pairs, rejected, committedEntries, ambiguous: ambiguous.size, uncommittedFilenameBytes };
}

/** Apply explicit local scene overrides in memory, never to the source cache. */
function filterMissingClassDependencies(resources: Map<number, NativeResource>, classNumbers: number[]) {
  const overrides: any[] = [];
  for (const classNumber of new Set(classNumbers)) {
    if (!Number.isInteger(classNumber) || classNumber < 0 || classNumber > 65535) {
      throw new TypeError('Class dependency filter numbers must be uint16 integers');
    }
    const id = 0x00010000 + classNumber;
    const resource = resources.get(id);
    if (!resource) throw new CacheFormatError(`Selected scene class is missing: ${classNumber}`);
    const source = resource.data;
    if (source.length < 56 || source.readUInt16BE(0) !== classNumber) {
      throw new CacheFormatError(`Invalid selected scene class header: ${classNumber}`);
    }
    const count = source.readUInt16BE(48);
    const schemaBytes = source.readUInt32BE(52);
    const schemaOffset = 56 + count * 4;
    if (schemaOffset + schemaBytes !== source.length) {
      throw new CacheFormatError(`Invalid selected scene class bounds: ${classNumber}`);
    }
    const retained: any[] = [];
    const removed: any[] = [];
    for (let index = 0; index < count; index++) {
      const dependency = source.readUInt32BE(56 + index * 4);
      (resources.has(dependency) ? retained : removed).push(dependency);
    }
    if (!removed.length) continue;
    if (resource.version === 0xffffffff) {
      throw new CacheFormatError(`Cannot advance selected scene class version: ${classNumber}`);
    }
    // Only resourceCount changes in the fixed header. Copy the complete CUTESI
    // unchanged from after the original dependency array to its new position.
    const data = Buffer.alloc(56 + retained.length * 4 + schemaBytes);
    source.copy(data, 0, 0, 56);
    data.writeUInt16BE(retained.length, 48);
    retained.forEach((dependency: any, index: any) => data.writeUInt32BE(dependency, 56 + index * 4));
    source.copy(data, 56 + retained.length * 4, schemaOffset);
    const version = resource.version + 1;
    resources.set(id, { id, version, data });
    overrides.push(Object.freeze({ classNumber, id, removed: Object.freeze(removed),
      sourceVersion: resource.version, version, sourceHash: hash(source), servedHash: hash(data),
      description: 'Authored scene profile omits unavailable eager class dependencies; missing behavior remains unsupported' }));
  }
  return Object.freeze(overrides);
}

/** Read-only cache snapshot with defensive copies at its public byte boundaries. */
export class ResourceStore {
  declare clientDir: string;
  declare resourceCursor: number;
  declare maxResourceVersion: number;
  declare resourceProfile: string;
  declare summary: Readonly<Record<string, any>>;

  #resources: Map<number, NativeResource>;
  #files: Map<string, FileAsset>;

  constructor({ clientDir, maxFileBytes = 16 * 1024 * 1024, filterClassDependencies = [], allowEmpty = false }: ResourceStoreOptions = {}) {
    if (typeof clientDir !== 'string' || !clientDir) throw new TypeError('clientDir is required');
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) throw new TypeError('Invalid maxFileBytes');
    if (filterClassDependencies !== 'all' && !Array.isArray(filterClassDependencies)) throw new TypeError('filterClassDependencies must be an array or all');
    this.clientDir = resolve(clientDir);
    const anomalies: any[] = [];
    const mag = readMag(join(this.clientDir, 'mag'), anomalies);
    if (!mag.resources.size && !allowEmpty) throw new CacheFormatError(`No valid MAG resources found under ${this.clientDir}`);
    const wsres = readFilenameCache(join(this.clientDir, 'wsres'), maxFileBytes, anomalies);
    const sourceMagPayloadBytes = [...mag.resources.values()].reduce((sum: any, entry: any) => sum + entry.data.length, 0);
    const selectedClasses = filterClassDependencies === 'all'
      ? [...mag.resources.keys()].filter((id: any) => (id >>> 16) === 1).map((id: any) => id & 65535)
      : filterClassDependencies;
    const sceneOverrides = filterMissingClassDependencies(mag.resources, selectedClasses);
    this.#resources = mag.resources;
    this.#files = wsres.files;
    this.resourceCursor = mag.resourceCursor;
    this.maxResourceVersion = [...this.#resources.values()].reduce((maximum: any, entry: any) => Math.max(maximum, entry.version), 0);
    const profile = createHash('sha256').update('wa-resource-profile-v1\0');
    for (const entry of [...this.#resources.values()].sort((left: any, right: any) => left.id - right.id)) {
      const header = Buffer.alloc(12);
      header.writeUInt32BE(entry.id, 0);
      header.writeUInt32BE(entry.version, 4);
      header.writeUInt32BE(entry.data.length, 8);
      profile.update(header).update(createHash('sha256').update(entry.data).digest());
    }
    // Keep cached MAG/bootstrap generations distinct even if a source snapshot
    // reuses a resource version for different payload bytes. No source path or
    // private account state enters this digest.
    this.resourceProfile = profile.digest('hex');
    const types: Record<string, any> = {};
    let magPayloadBytes = 0;
    for (const resource of this.#resources.values()) {
      const type = resource.id >>> 16;
      types[type] = (types[type] ?? 0) + 1;
      magPayloadBytes += resource.data.length;
    }
    this.summary = Object.freeze({ magResources: this.#resources.size, magPayloadBytes, sourceMagPayloadBytes,
      magPhysicalResources: mag.physicalCount, magIndexEntries: mag.indexEntries,
      magIndexRejected: mag.invalidIndexEntries, magUnindexedResources: mag.physicalCount - this.#resources.size,
      resourceTypes: Object.freeze(types), resourceCursor: this.resourceCursor,
      resourceProfile: this.resourceProfile,
      fileAssets: this.#files.size, filePayloadBytes: [...this.#files.values()].reduce((sum: any, entry: any) => sum + entry.data.length, 0),
      fileCachePairs: wsres.pairs, fileCommittedEntries: wsres.committedEntries,
      fileRejected: wsres.rejected, fileAmbiguous: wsres.ambiguous,
      fileUncommittedNameBytes: wsres.uncommittedFilenameBytes,
      sceneOverrides,
      anomalies: Object.freeze(anomalies.map((item: any) => Object.freeze(item))) });
  }

  getResource(id: number): NativeResource | null {
    if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) return null;
    const entry = this.#resources.get(id);
    return entry ? { id: entry.id, version: entry.version, data: Buffer.from(entry.data) } : null;
  }

  /** All admitted resources, with type schemas preceding their consumers.
   *
   * Native bootstrap has dynamic dependencies; sending the admitted resource set
   * avoids assuming that a small lexical dependency closure is complete.
   * This ordering does not imply that every later action has all its assets.
   */
  bootstrapResources(): NativeResource[] {
    return [...this.#resources.keys()].sort((left: any, right: any) => {
      const leftSchema = (left >>> 16) === 10;
      const rightSchema = (right >>> 16) === 10;
      return leftSchema !== rightSchema ? (leftSchema ? -1 : 1) : left - right;
    }).map((id: any) => this.getResource(id)!);
  }

  getFileInfo(filename: string): FileAsset | null {
    if (!validFilename(filename)) return null;
    const entry = this.#files.get(filename);
    return entry ? { version: entry.version, checksum: entry.checksum, data: Buffer.from(entry.data) } : null;
  }

  getFile(filename: string): Buffer | null {
    return this.getFileInfo(filename)?.data ?? null;
  }

  listFileNames() {
    return [...this.#files.keys()].sort();
  }

  /** Skip the class's dependency table before decoding its trailing descriptor. */
  getClassSchema(classNumber: number): string | null {
    if (!Number.isInteger(classNumber) || classNumber < 0 || classNumber > 65535) return null;
    const resource = this.#resources.get(0x00010000 + classNumber);
    if (!resource) return null;
    const data = resource.data;
    if (data.length < 56 || data.readUInt16BE(0) !== classNumber) {
      throw new CacheFormatError(`Invalid class header: ${classNumber}`);
    }
    const referenceCount = data.readUInt16BE(48);
    const schemaSize = data.readUInt32BE(52);
    const schemaOffset = 56 + referenceCount * 4;
    if (schemaOffset + schemaSize !== data.length) {
      throw new CacheFormatError(`Invalid class schema bounds: ${classNumber}`);
    }
    return data.subarray(schemaOffset).toString('latin1').replace(/\0+$/, '');
  }
}
