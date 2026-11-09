/** Native indexed-art decoding and canvas presentation. Resource metadata drives
 * frames and attachment slots; rendering never executes an embedded program. */
import type { WorldObject, WorldState, WireFields } from './types.js';
export type BinaryData = Uint8Array | ArrayBuffer | ArrayLike<number>;
export type ColorPalette = readonly (readonly number[])[];
export interface NativeCel {
    width: number;
    height: number;
    stride: number;
    flags: number;
    source: Uint8Array;
    pixels: Uint8Array | null;
}
export interface NativeFramePart {
    cel: number;
    x: number;
    y: number;
    flags: number;
}
export interface NativeFrame {
    width: number;
    height: number;
    anchor: NativeFramePart;
    parts: NativeFramePart[];
}
export interface NativeChoreCommand {
    type: number;
    state: number;
    dx: number;
    dy: number;
    dz: number;
}
export interface NativeChore {
    name: string;
    next: string;
    commands: NativeChoreCommand[];
}
export interface ChoreographyPlan {
    states: number[];
    endState: number;
}
export interface NativeImage {
    palette: Uint8Array;
    remap: Uint8Array;
    dictionary: Uint16Array;
    offsets: number[];
    cels: NativeCel[];
    frames: NativeFrame[];
    animations: {
        name: string;
        frames: number[];
    }[];
    states: number[][];
    chores: NativeChore[];
    namedStates: {
        name: string;
        entries: {
            name: string;
            next: string;
            chore: number;
        }[];
    }[];
    spotFlags: number[];
    trailingBytes: number;
    error?: string;
    surfaceCache?: Map<string, AlphaCanvas>;
    decodeCel(index: number): Uint8Array;
    frameFor(state?: number, orientation?: number, mood?: number): NativeFrame | undefined;
    choreography(names: string[], namedState?: number, includeEndState?: false): number[];
    choreography(names: string[], namedState: number | undefined, includeEndState: true): ChoreographyPlan;
}
export interface AlphaCanvas extends HTMLCanvasElement {
    waAlpha?: Uint8Array;
}
export interface ObjectBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    object: WorldObject;
}
interface HitRegion extends ObjectBounds {
    flipX?: boolean;
    flipY?: boolean;
    alpha?: Uint8Array;
    sourceNoid?: number;
}
interface Motion {
    from: number[];
    to: number[];
    start: number;
    duration: number;
    distance: number;
    orientation: number;
    holding: boolean;
    plan?: ChoreographyPlan;
    image?: NativeImage;
}
interface ExitRequest {
    sequence: number;
    direction: number;
    scene: WorldState;
    motion?: Motion;
}
interface RegionDeparture {
    actorNoid: number;
    motion: Motion;
    next: WorldState;
}
interface Playback {
    seq: number;
    gesture: string;
    sequence: number[];
    image: NativeImage;
    namedState: number;
    endState?: number;
    started?: number;
}
interface DefaultAnimation {
    states: number[];
    loopStart: number | null;
}
interface IdlePlayback {
    image: NativeImage;
    namedState: number;
    started: number;
    afterGesture?: number;
    plan: DefaultAnimation;
}
// Native default chores can enter another named state before settling into a
// cycle. Compile that prefix and cycle once per image/state, not once per draw.
const defaultAnimations = new WeakMap<NativeImage, Map<number, DefaultAnimation>>();
function defaultAnimation(image: NativeImage, namedState: number): DefaultAnimation {
    let cache = defaultAnimations.get(image);
    if (!cache)
        defaultAnimations.set(image, cache = new Map());
    const cached = cache.get(namedState);
    if (cached)
        return cached;
    const states: number[] = [], visited = new Map<number, number>();
    let current = namedState, loopStart: number | null = null;
    // Bound authored/malformed state chains as well as the decoder's per-chore
    // budget. An exhausted chain holds its last pose rather than running code.
    while (visited.size < 256 && states.length < 16384) {
        if (visited.has(current)) {
            const start = visited.get(current)!;
            if (start < states.length)
                loopStart = start;
            break;
        }
        visited.set(current, states.length);
        const plan = image.choreography(['default'], current, true);
        if (!plan.states.length)
            break;
        states.push(...plan.states.slice(0, 16384 - states.length));
        current = plan.endState;
    }
    const plan = { states, loopStart };
    cache.set(namedState, plan);
    return plan;
}
export interface RendererPreferences {
    names?: boolean;
    showNames?: boolean;
    animation?: boolean;
    [key: string]: unknown;
}
export interface RendererOptions {
    onSelect?: (object: WorldObject | null, destination?: [number, number, number]) => void;
    onMove?: (x: number, y: number, z: number) => void;
    onAssetError?: (name: string, message: string) => void;
    onLayout?: (bounds: readonly ObjectBounds[], width: number) => void;
}
export interface ConversationQuip {
    speakerNoid: number;
    type: 0 | 1;
    until: number;
}
interface PendingAsset<T> {
    task: (signal: AbortSignal) => Promise<T> | T;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}
import { MASTER_PALETTE } from './palette.js';
const MAX_PIXELS = 8 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
// Shipped native renoFrameTimeDelay initial value at WA VA 0x61f910.
const FRAME_TIME = 175;
export class ImageFormatError extends Error {
    constructor(message: string) { super(message); this.name = 'ImageFormatError'; }
}
const ensure: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok)
    throw new ImageFormatError(message); };
const bytesOf = (input: BinaryData) => input instanceof Uint8Array ? input : new Uint8Array(input);
/** Decoder for the shipped ten-section WA IMG format. All reads are bounded.
 * Native provenance: image_v1.cpp 0x433880 (sections), 0x434050 (frame layout),
 * 0x487070 (dictionary), 0x488680 (scanline commands), 0x439a10 (attachments).
 * This decodes data only. The original Tcl and arbitrary server scripts never run. */
export function decodeImage(input: BinaryData): NativeImage {
    const data = bytesOf(input);
    ensure(data.byteLength >= 40 && data.byteLength <= MAX_FILE, 'Invalid IMG length');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Filename caches and MAG resources can use different byte orders. The
    // first section must begin at byte 40 in either admitted representation.
    const littleEndian = view.getUint32(0, true) === 40;
    const u16 = (p: number) => { ensure(p >= 0 && p + 2 <= data.length, 'Truncated IMG word'); return view.getUint16(p, littleEndian); };
    const i16 = (p: number) => { ensure(p >= 0 && p + 2 <= data.length, 'Truncated IMG word'); return view.getInt16(p, littleEndian); };
    const u32 = (p: number) => { ensure(p >= 0 && p + 4 <= data.length, 'Truncated IMG dword'); return view.getUint32(p, littleEndian); };
    const offsets = Array.from({ length: 10 }, (_, i) => u32(i * 4));
    ensure(offsets[0] === 40, 'Unsupported IMG header');
    let previous = 40;
    for (let i = 0; i < 10; i++)
        if (offsets[i]) {
            ensure(offsets[i] >= previous && offsets[i] <= data.length, 'Invalid IMG section offsets');
            previous = offsets[i];
        }
    const sectionEnd = (i: number) => offsets.slice(i + 1).find((value) => value > 0) ?? data.length;
    const paletteCount = u16(offsets[0]);
    ensure(paletteCount <= 256 && offsets[0] + 2 + paletteCount <= sectionEnd(0), 'Invalid IMG palette');
    const palette = data.slice(offsets[0] + 2, offsets[0] + 2 + paletteCount);
    const remapCount = u16(offsets[1]);
    ensure(remapCount <= 256 && offsets[1] + 2 + remapCount <= sectionEnd(1), 'Invalid IMG color remapping');
    const remap = data.slice(offsets[1] + 2, offsets[1] + 2 + remapCount);
    // IMG section 2 contains the sixteen native attachment-spot masks. Seats
    // advertise usable actor spots with 0x40000 (00050961's spot-find mask).
    ensure(offsets[2] > 0 && sectionEnd(2) - offsets[2] === 64, 'Invalid IMG attachment spots');
    const spotFlags = Array.from({ length: 16 }, (_, index) => u32(offsets[2] + index * 4));
    const dictionary = new Uint16Array(512);
    let cursor = offsets[3] ? offsets[3] + 4 : sectionEnd(3);
    for (let half = 0; offsets[3] && half < 2; half++) {
        let item = 0;
        while (item < 256) {
            ensure(cursor < sectionEnd(3), 'Truncated IMG dictionary');
            const command = data[cursor++], count = (command & 127) + 1;
            ensure(item + count <= 256, 'IMG dictionary overrun');
            if (command & 128) {
                ensure(cursor + count * 2 <= sectionEnd(3), 'Truncated IMG dictionary literals');
                for (let i = 0; i < count; i++)
                    dictionary[(item + i) * 2 + half] = (data[cursor + i * 2] << 8) | data[cursor + i * 2 + 1];
                cursor += count * 2;
            }
            else {
                ensure(cursor + 2 <= sectionEnd(3), 'Truncated IMG dictionary repeat');
                const word = data[cursor] * 256 + data[cursor + 1];
                cursor += 2;
                for (let i = 0; i < count; i++)
                    dictionary[(item + i) * 2 + half] = word;
            }
            item += count;
        }
    }
    ensure(cursor === sectionEnd(3), 'IMG dictionary size mismatch');
    const celCount = u32(offsets[4]);
    ensure(celCount <= 8192, 'Too many IMG cels');
    const cels: NativeCel[] = [];
    cursor = offsets[4] + 4;
    for (let i = 0; i < celCount; i++) {
        const length = u32(cursor), start = cursor + 4, end = start + length;
        ensure(length >= 8 && end <= sectionEnd(4), 'Invalid IMG cel bounds');
        const width = u16(start), height = u16(start + 2), stride = u16(start + 4), flags = u16(start + 6);
        ensure(width > 0 && height > 0 && width * height <= MAX_PIXELS, 'Invalid IMG cel dimensions');
        cels.push({ width, height, stride, flags, source: data.subarray(start + 8, end), pixels: null });
        cursor = end;
    }
    ensure(cursor === sectionEnd(4), 'IMG cel section size mismatch');
    const frameCount = u32(offsets[5]);
    ensure(frameCount <= 16384, 'Too many IMG frames');
    const frames: NativeFrame[] = [];
    cursor = offsets[5] + 4;
    for (let i = 0; i < frameCount; i++) {
        const count = u16(cursor), width = u16(cursor + 2), height = u16(cursor + 4);
        ensure(count <= 4096 && width * height <= MAX_PIXELS && cursor + 14 + count * 8 <= sectionEnd(5), 'Invalid IMG frame');
        const anchor = { cel: i16(cursor + 6), x: i16(cursor + 8), y: i16(cursor + 10), flags: u16(cursor + 12) };
        const parts = Array.from({ length: count }, (_, j) => { const p = cursor + 14 + j * 8; return { cel: i16(p), x: i16(p + 2), y: i16(p + 4), flags: u16(p + 6) }; });
        frames.push({ width, height, anchor, parts });
        cursor += 14 + count * 8;
    }
    ensure(cursor === sectionEnd(5), 'IMG frame section size mismatch');
    const animationCount = u32(offsets[6]);
    ensure(animationCount <= 16384 && offsets[6] + 4 + animationCount * 40 === sectionEnd(6), 'Invalid IMG animation section');
    const animations = Array.from({ length: animationCount }, (_, i) => {
        const p = offsets[6] + 4 + i * 40;
        return { name: String.fromCharCode(...data.subarray(p, p + 8)).replace(/\0.*$/, ''), frames: [0, 1, 2, 3].map((j) => u16(p + 32 + j * 2)) };
    });
    const stateCount = u32(offsets[7]);
    ensure(stateCount <= 16384, 'Too many IMG states');
    const states: number[][] = [];
    cursor = offsets[7] + 4;
    for (let i = 0; i < stateCount; i++) {
        const count = u16(cursor);
        ensure(count <= 8192 && cursor + 2 + count * 2 <= sectionEnd(7), 'Invalid IMG state');
        states.push(Array.from({ length: count }, (_, j) => u16(cursor + 2 + j * 2)));
        cursor += 2 + count * 2;
    }
    ensure(cursor === sectionEnd(7), 'IMG state section size mismatch');
    const text = (p: number, n: number) => String.fromCharCode(...data.subarray(p, p + n)).replace(/\0.*$/, '');
    const choreCount = u32(offsets[8]);
    ensure(choreCount <= 16384, 'Too many IMG chores');
    const chores: NativeChore[] = [];
    cursor = offsets[8] + 4;
    for (let i = 0; i < choreCount; i++) {
        const count = u16(cursor + 72);
        ensure(count <= 16384 && cursor + 76 + count * 12 <= sectionEnd(8), 'Invalid IMG chore');
        const commands = Array.from({ length: count }, (_, j) => { const p = cursor + 76 + j * 12; return { type: u16(p), state: u16(p + 2), dx: i16(p + 4), dy: i16(p + 6), dz: i16(p + 8) }; });
        chores.push({ name: text(cursor, 32), next: text(cursor + 64, 8), commands });
        cursor += 76 + count * 12;
    }
    ensure(cursor === sectionEnd(8), 'IMG chore section size mismatch');
    const namedStateCount = u32(offsets[9]);
    ensure(namedStateCount <= 16384, 'Too many IMG named states');
    const namedStates: NativeImage['namedStates'] = [];
    cursor = offsets[9] + 4;
    for (let i = 0; i < namedStateCount; i++) {
        const count = u16(cursor + 10);
        ensure(count <= 16384 && cursor + 12 + count * 42 <= sectionEnd(9), 'Invalid IMG named state');
        const entries = Array.from({ length: count }, (_, j) => { const p = cursor + 12 + j * 42; return { next: text(p, 8), name: text(p + 8, 32), chore: u16(p + 40) }; });
        namedStates.push({ name: text(cursor, 8), entries });
        cursor += 12 + count * 42;
    }
    ensure(cursor <= sectionEnd(9), 'IMG named state section size mismatch');
    const trailingBytes = sectionEnd(9) - cursor;
    const image: NativeImage = { palette, remap, cels, frames, animations, states, dictionary, offsets, chores, namedStates, spotFlags, trailingBytes,
        decodeCel(index: number) { const cel = cels[index]; ensure(!!cel, 'Unknown IMG cel'); return cel.pixels ??= decodeCel(cel, dictionary); },
        frameFor(state = 0, orientation = 0, mood = 0) {
            const sequence = states[state] ?? states[0];
            const animation = animations[sequence?.[Math.max(0, mood)] ?? sequence?.[0] ?? 0];
            return frames[animation?.frames[orientation & 3] ?? 0] ?? frames[0];
        },
        choreography(names: string[], namedState = 0, includeEndState: boolean = false): any {
            let context = namedStates[namedState] ?? namedStates[0];
            const result: number[] = [];
            for (const name of names) {
                // Some images alias an entry to its state name (e.g. invisible seat
                // 'two') while the referenced chore is named 'default'. Resolve that
                // chore inside this state before considering a global same-name chore.
                const entry = context?.entries.find((entry) => entry.name === name) ?? context?.entries.find((entry) => chores[entry.chore]?.name === name) ?? namedStates[0]?.entries.find((entry) => entry.name === name) ?? namedStates[0]?.entries.find((entry) => chores[entry.chore]?.name === name);
                const chore = (entry ? chores[entry.chore] : undefined) ?? chores.find((chore) => chore.name === name);
                if (!chore)
                    continue;
                const visited = new Set();
                let pc = 0, operations = 0;
                while (pc < chore.commands.length && operations++ < 4096) {
                    const command = chore.commands[pc];
                    if (command.type === 1) {
                        result.push(command.state);
                        pc++;
                    }
                    else if (command.type === 2 || command.type === 3) {
                        if (visited.has(pc))
                            break;
                        visited.add(pc);
                        pc = command.type === 3 ? 0 : command.state + 1;
                    }
                    else
                        pc++;
                }
                context = namedStates.find((state) => state.name === chore.next) ?? context;
            }
            return includeEndState ? { states: result, endState: Math.max(0, context ? namedStates.indexOf(context) : 0) } : result;
        },
    };
    return image;
}
/** Expand a raw or dictionary-coded cel into palette indices. Colors are resolved
 * later so one decoded pixel buffer can serve different object color maps. */
function decodeCel(cel: NativeCel, dictionary: Uint16Array): Uint8Array {
    const { width, height, stride, flags, source } = cel;
    const pixels = new Uint8Array(width * height);
    if (!(flags & 0x10)) {
        const bpp = 1 << (flags & 3);
        const rowBytes = stride || Math.ceil(width * bpp / 8);
        ensure(source.length >= rowBytes * height, 'Truncated raw IMG cel');
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const bit = x * bpp;
                pixels[y * width + x] = source[y * rowBytes + (bit >>> 3)] >>> (8 - bpp - (bit & 7)) & ((1 << bpp) - 1);
            }
        return pixels;
    }
    let bit = 0;
    const read = (n: number) => {
        ensure(bit + n <= source.length * 8, 'Truncated compressed IMG scanline');
        let value = 0;
        for (let i = 0; i < n; i++, bit++)
            value = value * 2 + (source[bit >>> 3] >>> (7 - (bit & 7)) & 1);
        return value;
    };
    const peek = () => {
        let value = 0;
        for (let i = 0; i < 8; i++)
            value = value * 2 + (bit + i < source.length * 8 ? source[(bit + i) >>> 3] >>> (7 - ((bit + i) & 7)) & 1 : 0);
        return value;
    };
    for (let y = 0; y < height; y++) {
        let x = 0, operations = 0;
        while (x < width) {
            const entry = peek() * 2;
            for (let half = 0; half < 2 && x < width; half++) {
                const word = dictionary[entry + half], type = word >>> 12;
                if (!type) {
                    ensure(half === 1, 'Invalid IMG scanline command');
                    break;
                }
                ensure(type <= 6, 'Unsupported IMG scanline command');
                read((word >>> 9 & 7) + 1);
                const arg = word & 256 ? read(8) : word & 255;
                const count = type === 1 ? 1 : type === 2 || type === 6 ? (arg >>> 4) + 1 : arg + 1;
                ensure(x + count <= width, 'IMG scanline exceeds cel width');
                for (let i = 0; i < count; i++, x++) {
                    const out = y * width + x;
                    if (type === 1)
                        pixels[out] = arg;
                    else if (type === 2) {
                        const from = out - (arg & 15) - 1;
                        ensure(from >= y * width, 'Invalid IMG horizontal reference');
                        pixels[out] = pixels[from];
                    }
                    else if (type === 5)
                        pixels[out] = x ? pixels[out - 1] : 0;
                    else if (type === 6) {
                        const from = (y - 1) * width + x - 7 + (arg & 15);
                        pixels[out] = y > 0 && from >= (y - 1) * width && from < y * width ? pixels[from] : 0;
                    }
                }
            }
            ensure(++operations <= width * 4 + 1, 'IMG scanline makes no progress');
        }
        bit = Math.ceil(bit / 8) * 8;
    }
    return pixels;
}
/** Resolve local palette entries, object-customizable colors, and transparency.
 * Global index zero stays transparent rather than becoming opaque black. */
export function celRGBA(image: NativeImage, index: number, colorMap?: ArrayLike<number>, masterPalette: ColorPalette = MASTER_PALETTE) {
    const cel = image.cels[index], pixels = image.decodeCel(index), rgba = new Uint8ClampedArray(cel.width * cel.height * 4);
    for (let i = 0; i < pixels.length; i++) {
        let global = image.palette[pixels[i]] ?? 0;
        if (global >= 239) {
            const custom = colorMap?.[global - 239];
            global = custom === undefined || custom === 0 ? image.remap[global - 239] ?? 0 : custom;
        }
        if (!global)
            continue;
        const color = masterPalette[global] ?? [255, 0, 255];
        rgba.set([...color, 255], i * 4);
    }
    return { width: cel.width, height: cel.height, data: rgba };
}
// Native 0x43a380 projects depth using the region horizon. The Windows
// raster is bottom-up; browser coordinates are top-down. Background positions
// already contain the projected vertical coordinate.
export function projectPosition(position: readonly number[], { height = 288, horizon = 70, background = false } = {}): [
    number,
    number
] {
    const [x = 0, depth = 0, z = 0] = position;
    return [Number(x), height - (background ? Number(depth) : Math.floor(Number(depth) * horizon / 512) + Number(z))];
}
/** Convert a ground click to native depth; screen coordinates cannot recover
 * height above the floor, so a requested walk always uses z = 0. */
export function unprojectPosition([x, y]: readonly number[], { height = 288, horizon = 70 } = {}): [
    number,
    number,
    number
] {
    return [Math.round(x), Math.round(Math.max(0, Math.min(512, (height - y) * 512 / (horizon || 70)))), 0];
}
/** Native 0x4146b0 enables two alternate palettes; 0x440db0 selects them
 * from HereIs offset102 (`unused` in the cached schema). Unavailable slots
 * 3..10 return the master palette. Region values above10 preserve current. */
export function regionPalette(paletteId = 0, master: ColorPalette = MASTER_PALETTE): ColorPalette {
    if (paletteId !== 1 && paletteId !== 2)
        return master;
    return master.map((color, index) => {
        if (index < 3)
            return color;
        if (paletteId === 1)
            return color.map((channel) => Math.floor(channel / 2));
        const gray = Math.floor(color[0] * 0.2125 + color[1] * 0.7154 + color[2] * 0.0721);
        return [gray, gray, gray];
    });
}
export function activePresentationSpeech(object: WorldObject | null | undefined, now = Date.now()): string | null {
    const speech = object?.fields?.presentationSpeech;
    return speech && !(Number(object?.fields?.common_flags) & 1) && Number(speech.until) > now && typeof speech.text === 'string' ? speech.text : null;
}
/** Translate bottom-origin native frame anchors into top-origin canvas bounds.
 * A supplied attachment slot lets a seated actor align with its parent frame. */
export function frameGeometry(frame: NativeFrame, x: number, y: number, anchorSlot?: number) {
    const anchor = Number.isInteger(anchorSlot) ? frame.parts.find((part) => (part.flags & 0x8000) && (part.flags & 15) === anchorSlot) ?? { x: 0, y: 0 } : frame.anchor;
    const originX = x - anchor.x, bottomY = y + anchor.y;
    return { originX, bottomY, originY: bottomY - frame.height, width: frame.width, height: frame.height };
}
// Exact complex-gesture aliases recovered from 00050001.tcl:939-978.
const GESTURE_ALIASES: Record<string, string[]> = {
    '0XF00B': ['begin_wave', 'waving', 'end_wave'], '0XF009': ['squat', 'fiddle'],
    '0XF00A': ['fiddle_return', 'return_to_stand'], '0XF00C': ['bow', 'bow_return'],
    '0XF00D': ['shrug', 'shrug_return'], '0XF00E': ['pay', 'fiddle', 'pay_return'],
    '0XF00F': ['show', 'show_return'], '0XF010': ['fiddle', 'fiddling'],
    '0XF011': ['arms_to_head', 'arms_to_head_return'],
    FLUTTER: ['wing_up', 'begin_flutter', 'flutter', 'end_flutter', 'wing_down'],
};
function field(object: WorldObject | null | undefined, name: string, fallback?: any): any { return object?.fields?.[name] ?? object?.[name] ?? fallback; }
function objectNoid(object: WorldObject | null | undefined): number { return object?.noid ?? field(object, 'noid', 0); }
const samePosition = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a.every((value, i) => Number(value) === Number(b[i]));
const validPosition = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every((number) => Number.isFinite(Number(number)));
function motionPosition(motion: Motion, now: number): number[] {
    const progress = Math.max(0, Math.min(1, (now - motion.start) / motion.duration));
    return motion.from.map((value, i) => value + (motion.to[i] - value) * progress);
}
function prepareMotion(motion: Motion, image: NativeImage, namedState: number, now: number) {
    if (motion.image === image)
        return;
    // Art can arrive after a walk starts. Keep the displayed progress when its
    // native pose count replaces the fallback duration, rather than rewinding.
    const progress = Math.max(0, Math.min(1, (now - motion.start) / motion.duration));
    motion.plan = walkingChoreography(image, namedState, motion.distance, motion.holding);
    motion.image = image;
    if (motion.plan.states.length) {
        motion.duration = motion.plan.states.length * FRAME_TIME;
        motion.start = now - progress * motion.duration;
    }
}
// 000c0003's firstStep/frames_xi/final_frame use i/x for alternate legs.
// Direction is selected by frameFor's orientation, not by a different chore.
export function walkingChoreography(image: NativeImage, namedState: number, distance: number, holding = false): ChoreographyPlan {
    const steps: string[] = [];
    let remaining = Math.max(0, distance);
    for (const [name, size] of [['long', 70], ['med', 35], ['short', 10]] as const) {
        const count = Math.min(128, Math.floor(remaining / size));
        for (let i = 0; i < count; i++)
            steps.push(name);
        remaining -= count * size;
    }
    if (!steps.length)
        steps.push('short');
    const prefix = holding && image.chores.some((chore) => chore.name.startsWith('hold_stand_to_walk_')) ? 'hold_' : '';
    const names = [`${prefix}stand_to_walk_${steps[0]}_i`, ...steps.map((length, i) => `${prefix}walk_${length}_${i & 1 ? 'x' : 'i'}`), `${prefix}walk_${steps.at(-1)}_${steps.length & 1 ? 'x' : 'i'}_to_stand`];
    return image.choreography(names, namedState, true);
}
/** Keep HTTP/1.1 image downloads below the per-origin connection limit so
 * the event stream and interactive requests always have connection slots. */
export class AssetRequestQueue {
    declare limit: number;
    declare pending: PendingAsset<unknown>[];
    declare active: Set<AbortController>;
    declare closed: boolean;
    constructor(limit = 3) { this.limit = limit; this.pending = []; this.active = new Set(); this.closed = false; }
    run<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
        if (this.closed)
            return Promise.reject(this.abortError());
        return new Promise<T>((resolve, reject) => { this.pending.push({ task, resolve: value => resolve(value as T), reject }); this.drain(); });
    }
    abortError() { const error = new Error('Asset loading stopped'); error.name = 'AbortError'; return error; }
    drain() {
        while (!this.closed && this.active.size < this.limit && this.pending.length) {
            const job = this.pending.shift()!, controller = new AbortController();
            this.active.add(controller);
            Promise.resolve().then(() => job.task(controller.signal)).then(job.resolve, job.reject).finally(() => { this.active.delete(controller); this.drain(); });
        }
    }
    destroy() {
        this.closed = true;
        for (const job of this.pending.splice(0))
            job.reject(this.abortError());
        for (const controller of this.active)
            controller.abort();
    }
}
/** Retains presentation-only motion, decoded art, and hit regions between
 * authoritative snapshots. Missing art still leaves a selectable fallback. */
export class WorldRenderer {
    declare canvas: HTMLCanvasElement;
    declare context: CanvasRenderingContext2D;
    declare onSelect: RendererOptions['onSelect'];
    declare onMove: RendererOptions['onMove'];
    declare onAssetError: RendererOptions['onAssetError'];
    declare onLayout: RendererOptions['onLayout'];
    declare conversationQuip: ConversationQuip | null;
    declare assets: Map<string, NativeImage | {
        error: string;
    } | null>;
    declare surfaces: Map<string, AlphaCanvas>;
    declare assetQueue: AssetRequestQueue;
    declare paletteId: number;
    declare masterPalette: ColorPalette;
    declare playbacks: Map<number, Playback>;
    declare idles: Map<number, IdlePlayback>;
    declare motions: Map<number, Motion>;
    declare bounds: ObjectBounds[];
    declare hitRegions: HitRegion[];
    declare state: WorldState;
    declare selected: number | null;
    declare width: number;
    declare height: number;
    declare preferences: RendererPreferences;
    declare tick: number;
    declare lastTime: number;
    declare destroyed: boolean;
    declare click: (event: MouseEvent) => void;
    declare doubleClick: (event: MouseEvent) => void;
    declare animate: (now: number) => void;
    declare raf: number;
    declare walkFacings: Map<number, number>;
    declare motionSequence: number | undefined;
    declare motionSceneSequence: number | undefined;
    declare exitRequest: ExitRequest | undefined;
    declare departure: RegionDeparture | undefined;
    constructor(canvas: HTMLCanvasElement, { onSelect, onMove, onAssetError, onLayout }: RendererOptions = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d')!;
        this.onSelect = onSelect;
        this.onMove = onMove;
        this.onAssetError = onAssetError;
        this.onLayout = onLayout;
        this.conversationQuip = null;
        this.assets = new Map();
        this.surfaces = new Map();
        this.assetQueue = new AssetRequestQueue(3);
        this.paletteId = 0;
        this.masterPalette = MASTER_PALETTE;
        this.playbacks = new Map();
        this.idles = new Map();
        this.motions = new Map();
        this.walkFacings = new Map();
        this.bounds = [];
        this.hitRegions = [];
        this.state = { objects: [] };
        this.selected = null;
        this.width = 512;
        this.height = 288;
        this.preferences = { names: true, animation: true };
        this.tick = 0;
        this.lastTime = 0;
        this.destroyed = false;
        this.click = (event) => {
            if (this.transitioning)
                return;
            const rect = canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) * this.width / rect.width, y = (event.clientY - rect.top) * this.height / rect.height;
            const hit = this.hitTest(x, y);
            const destination = unprojectPosition([x, y], { height: this.height, horizon: Number(field(this.getRegion(), 'horizon', 70)) || 70 });
            this.onSelect?.(hit ?? null, destination);
        };
        this.doubleClick = (event) => {
            if (this.transitioning)
                return;
            const rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * this.width / rect.width, y = (event.clientY - rect.top) * this.height / rect.height;
            if (!this.hitTest(x, y)) {
                const world = unprojectPosition([x, y], { height: this.height, horizon: Number(field(this.getRegion(), 'horizon', 70)) || 70 });
                this.onMove?.(...world);
            }
        };
        canvas.addEventListener('click', this.click);
        canvas.addEventListener('dblclick', this.doubleClick);
        this.animate = (now) => {
            if (this.destroyed)
                return;
            this.finishDeparture();
            // Interpolated positions follow the display clock. Native sprite
            // poses still advance at FRAME_TIME in frame(), independently.
            if (this.preferences.animation !== false && this.motions.size > 0 || now - this.lastTime >= FRAME_TIME) {
                this.tick = Math.floor(now / FRAME_TIME);
                this.lastTime = now;
                this.draw();
            }
            this.raf = requestAnimationFrame(this.animate);
        };
        this.raf = requestAnimationFrame(this.animate);
    }
    // Interpolate only movements backed by native walk replies in the same
    // scene. Arbitrary position changes and scene resets snap to server state.
    setState(state: WorldState) {
        const now = this.time(), history = state?.history ?? [], sequence = Math.max(0, ...history.map((entry) => Number(entry.seq) || 0));
        if (this.departure) {
            if (state.status === 'connected' && state.worldName === this.departure.next.worldName && state.avatar === this.departure.next.avatar && this.preferences.animation !== false) {
                this.departure.next = state;
                if (!this.finishDeparture())
                    this.draw();
                return;
            }
            this.departure = undefined;
            this.exitRequest = undefined;
        }
        this.walkFacings ??= new Map();
        this.idles ??= new Map();
        const sameSession = this.motionSequence !== undefined && state.status === 'connected' && this.state.status === 'connected' && state.worldName === this.state.worldName && state.avatar === this.state.avatar && sequence >= this.motionSequence;
        // A HereIs can fall out of bounded history during a long stay. Keep the
        // current scene identity until another HereIs or a connection change.
        const sceneSequence = Math.max(0, ...history.filter((entry) => entry.type === 'message' && Number(entry.id) === 101 && Number(entry.noid) === 0).map((entry) => Number(entry.seq) || 0)) || (sameSession ? this.motionSceneSequence ?? 0 : 0);
        if (sameSession) {
            const request = history.findLast(entry => entry.type === 'request' && Number(entry.id) === 103 && Number(entry.noid) === 0 && Number(entry.seq) > (this.motionSequence ?? 0));
            const self = this.state.objects?.find(object => Number(object.noid) === Number(this.state.actorNoid));
            if (request && Number(self?.classNumber) === 21 && !(Number(field(self, 'common_flags', 0)) & 1)) {
                const direction = Number(request.fields?.exitDir);
                if (Number.isInteger(direction) && direction >= 0 && direction <= 3)
                    this.exitRequest = { sequence: Number(request.seq), direction, scene: this.state, motion: this.motions.get(Number(this.state.actorNoid)) };
            }
            const exit = this.exitRequest;
            if (exit) {
                const reply = history.find(entry => entry.type === 'message' && Number(entry.id) === 70 && Number(entry.requestId) === 103 && Number(entry.seq) > exit.sequence && (entry.requestSeq === undefined || Number(entry.requestSeq) === exit.sequence));
                if (reply && Number(reply.fields?.success) !== 0)
                    this.exitRequest = undefined;
                else if (reply && sceneSequence > (this.motionSceneSequence ?? 0) && this.preferences.animation !== false && this.beginDeparture(exit, state, now))
                    return;
            }
        }
        else
            this.exitRequest = undefined;
        const sameScene = sameSession && sceneSequence === this.motionSceneSequence;
        const previousObjects = new Map((this.state.objects ?? []).map((object) => [Number(objectNoid(object)), object]));
        const walks = new Map(), stands = new Map();
        if (!sameScene) {
            this.motions.clear();
            this.playbacks.clear();
            this.idles.clear();
            this.walkFacings.clear();
        }
        else
            for (const entry of history) {
                if (Number(entry.seq) <= (this.motionSequence ?? 0) || entry.type !== 'message')
                    continue;
                const id = Number(entry.id), fields = entry.fields ?? {};
                if ((id === 70 && Number(entry.requestId) === 1688 || [1689, 1595, 1596].includes(id)) && (!Object.hasOwn(fields, 'success') || Number(fields.success) === 0))
                    this.walkFacings.delete(Number(entry.requestNoid ?? entry.noid));
                if (id === 2406 && Number(entry.requestId) === 2405 && Number(fields.success) === 0 && validPosition(fields.coords))
                    stands.set(Number(state.actorNoid), { coords: fields.coords.map(Number), seat: Number(entry.requestNoid ?? entry.noid), seq: Number(entry.seq) });
                if ((id === 1571 && Number(entry.requestId) === 1570 || id === 1572) && (!Object.hasOwn(fields, 'success') || Number(fields.success) === 0) && validPosition(fields.coords))
                    walks.set(Number(entry.noid), { coords: fields.coords.map(Number), seq: Number(entry.seq) });
            }
        const present = new Set();
        for (const next of state?.objects ?? []) {
            const noid = Number(objectNoid(next));
            present.add(noid);
            const previous = previousObjects.get(noid), before = field(previous, 'position'), to = field(next, 'position'), motion = this.motions.get(noid);
            const validActor = [21, 200, 201].includes(Number(next.classNumber));
            const inRoom = Number(field(next, 'container_noid', 0)) === Number(objectNoid(state?.region ?? (state?.objects ?? []).find((object) => Number(object.classNumber) === 20)));
            const walk = walks.get(noid), stand = stands.get(noid), stoodBeforeWalk = stand && walk && stand.seq < walk.seq && stand.seat === Number(field(previous, 'container_noid', 0));
            if (!validActor || !inRoom || !previous || !validPosition(before) || !validPosition(to) || Number(field(previous, 'container_noid', 0)) !== Number(field(next, 'container_noid', 0)) && !stoodBeforeWalk || Number(field(next, 'common_flags', 0)) & 1) {
                this.motions.delete(noid);
                this.walkFacings.delete(noid);
                continue;
            }
            if (Number(field(previous, 'orientation', 0)) !== Number(field(next, 'orientation', 0)))
                this.walkFacings.delete(noid);
            const destination = walk?.coords;
            if (destination && samePosition(destination, to)) {
                // SSE can repeat snapshots while an old walk is still on screen. A
                // new destination starts at that displayed point, never the old server
                // destination, and a duplicate destination does not restart the stride.
                if (motion && samePosition(motion.to, to))
                    continue;
                const from = stoodBeforeWalk ? stand.coords : motion ? motionPosition(motion, now) : before.map(Number), dx = Number(to[0]) - from[0], dy = Number(to[1]) - from[1], distance = Math.max(Math.abs(dx), Math.abs(dy));
                if (distance > 0 && this.preferences.animation !== false) {
                    const orientation = dx !== 0 && Math.abs(dy / dx) < 10 ? dx > 0 ? 1 : 3 : dy > 0 ? 2 : 0;
                    this.walkFacings.set(noid, orientation);
                    const nextMotion: Motion = { from, to: to.map(Number), start: now, duration: FRAME_TIME * 8, distance, orientation, holding: (state.objects ?? []).some((child) => Number(field(child, 'container_noid', 0)) === noid && Number(field(child, 'position', [])[0]) === 0) };
                    const image = this.assets.get(`${field(next, 'imageURL', '')}@${field(next, 'imageVersion', 0)}#${Number(field(next, 'imageDefault', 0)) ? 0x20000 + Number(field(next, 'imageDefault', 0)) : 0}`);
                    if (image && !('error' in image))
                        prepareMotion(nextMotion, image, Number(field(next, 'choreState', 0)), now);
                    this.motions.set(noid, nextMotion);
                }
            }
            else if (!samePosition(before, to)) {
                this.motions.delete(noid);
                this.walkFacings.delete(noid);
            }
        }
        for (const noid of this.motions.keys())
            if (!present.has(Number(noid)))
                this.motions.delete(noid);
        for (const noid of this.walkFacings.keys())
            if (!present.has(Number(noid)))
                this.walkFacings.delete(noid);
        for (const cache of [this.idles, this.playbacks])
            for (const noid of cache.keys())
                if (!present.has(Number(noid)))
                    cache.delete(noid);
        this.motionSequence = sequence;
        this.motionSceneSequence = sceneSequence;
        const hereIs = [...(state?.history ?? [])].reverse().find((entry) => Number(entry.id) === 101 && Number(entry.noid) === 0 && entry.fields);
        const paletteId = Number(state?.paletteId ?? hereIs?.fields?.unused ?? 0);
        if (Number.isInteger(paletteId) && paletteId >= 0 && paletteId <= 10 && paletteId !== this.paletteId) {
            this.paletteId = paletteId;
            this.masterPalette = regionPalette(paletteId);
        }
        this.state = state ?? { objects: [] };
        this.draw();
    }
    get transitioning() { return Boolean(this.departure); }
    /** Keep the departing scene on screen until the successful exit's final
     * stride finishes. Authoritative snapshots continue to arrive in `next`;
     * no walking request or durable position is invented for this effect. */
    beginDeparture(exit: ExitRequest, next: WorldState, now: number) {
        const scene = exit.scene, actorNoid = Number(scene.actorNoid), actor = scene.objects?.find(object => Number(object.noid) === actorNoid);
        if (!actor || Number(field(actor, 'container_noid', 0)) !== 0 || !validPosition(field(actor, 'position')))
            return false;
        const previousMotion = this.motions.get(actorNoid) ?? exit.motion;
        const from = previousMotion ? motionPosition(previousMotion, now) : field(actor, 'position').map(Number), to = [...from];
        // Native depth grows toward the horizon; compass north therefore
        // leaves through the far edge, south through the near edge.
        if (exit.direction === 0) to[1] = 512;
        else if (exit.direction === 1) to[0] = 612;
        else if (exit.direction === 2) to[1] = -100;
        else to[0] = -100;
        const motion: Motion = { from, to, start: now, duration: FRAME_TIME * 8,
            distance: Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])),
            orientation: [2, 1, 0, 3][exit.direction],
            holding: (scene.objects ?? []).some(child => Number(field(child, 'container_noid', 0)) === actorNoid && Number(field(child, 'position', [])[0]) === 0) };
        this.exitRequest = undefined;
        this.departure = { actorNoid, motion, next };
        this.state = scene;
        this.motions.clear();
        this.motions.set(actorNoid, motion);
        this.walkFacings.set(actorNoid, motion.orientation);
        this.conversationQuip = null;
        this.draw();
        return true;
    }
    finishDeparture() {
        const departure = this.departure;
        if (!departure || this.preferences.animation !== false && this.time() - departure.motion.start < departure.motion.duration)
            return false;
        this.departure = undefined;
        this.exitRequest = undefined;
        // Consume the deferred history before applying it so the same exit
        // cannot be replayed by duplicate snapshots or Tcl redraws.
        this.motionSequence = Math.max(0, ...(departure.next.history ?? []).map(entry => Number(entry.seq) || 0));
        this.setState(departure.next);
        return true;
    }
    time() { return performance.now(); }
    /** The transcript owns the text; the scene retains only its native pointer. */
    setConversationQuip(quip: ConversationQuip | null) {
        this.conversationQuip = quip;
        this.draw();
    }
    activeConversationQuip(now = Date.now()) {
        const quip = this.conversationQuip;
        return this.state.status === 'connected' && quip && Number.isFinite(quip.until) && quip.until > now ? quip : null;
    }
    setPreferences(preferences: RendererPreferences = {}) {
        const animated = this.preferences.animation !== false;
        Object.assign(this.preferences, preferences);
        if (animated !== (this.preferences.animation !== false)) {
            this.finishDeparture();
            this.idles?.clear();
            this.motions.clear();
            // Consume interrupted gestures so re-enabling animation cannot
            // replay an old action or an old walk from its starting position.
            for (const playback of this.playbacks.values()) {
                playback.sequence = [];
                playback.endState = undefined;
            }
        }
        this.draw();
    }
    getRegion() { return this.state.region && typeof this.state.region === 'object' ? this.state.region : (this.state.objects ?? []).find((o) => o.classNumber === 20); }
    setSelected(noid: number | null | undefined) { this.selected = noid === null || noid === undefined ? null : Number(noid); this.draw(); }
    // Match reverse paint order and per-cel alpha, so transparent areas reveal
    // the object behind them instead of intercepting the click.
    hitTest(x: number, y: number): WorldObject | null {
        if (this.hitRegions) {
            for (let i = this.hitRegions.length - 1; i >= 0; i--) {
                const region = this.hitRegions[i];
                if (x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height)
                    continue;
                let localX = Math.floor(x - region.x), localY = Math.floor(y - region.y);
                if (region.flipX)
                    localX = region.width - 1 - localX;
                if (region.flipY)
                    localY = region.height - 1 - localY;
                if (!region.alpha || region.alpha[localY * region.width + localX])
                    return region.object;
            }
            return null;
        }
        for (let i = this.bounds.length - 1; i >= 0; i--) {
            const b = this.bounds[i];
            if (x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height)
                return b.object;
        }
        return null;
    }
    // The advertised version is part of asset identity. A filename alone can
    // otherwise reuse stale art after the world changes that resource.
    async load(name: string, version = 0, resourceId = 0) {
        const key = `${name}@${version}#${resourceId}`;
        if ((!name && !resourceId) || this.assets.has(key))
            return this.assets.get(key);
        this.assets.set(key, null);
        try {
            const data = await this.assetQueue.run(async (signal) => {
                const options: RequestInit = { signal, priority: 'low' };
                let response = await fetch(name ? `/api/asset?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}` : `/api/resource?id=${resourceId}`, options);
                if (!response.ok && name && resourceId)
                    response = await fetch(`/api/resource?id=${resourceId}`, options);
                if (!response.ok)
                    throw new Error(`${name || `resource ${resourceId}`}: ${response.status}`);
                return response.arrayBuffer();
            });
            if (this.destroyed)
                return null;
            const image = decodeImage(data);
            this.assets.set(key, image);
            this.draw();
            return image;
        }
        catch (error: any) {
            if (!this.destroyed && error.name !== 'AbortError') {
                this.assets.set(key, { error: error.message });
                this.onAssetError?.(name, error.message);
            }
            return null;
        }
    }
    // Cache the palette-dependent canvas and its alpha mask together; drawing
    // and hit testing must agree after a region or object color-map change.
    surface(image: NativeImage, index: number, map?: number[], fixedPalette = false): AlphaCanvas {
        const key = `${fixedPalette ? 'master' : this.paletteId}:${index}:${(map ?? []).join(',')}`;
        image.surfaceCache ??= new Map();
        if (image.surfaceCache.has(key))
            return image.surfaceCache.get(key)!;
        const rgba = celRGBA(image, index, map, fixedPalette ? MASTER_PALETTE : this.masterPalette), canvas = document.createElement('canvas') as AlphaCanvas;
        canvas.width = rgba.width;
        canvas.height = rgba.height;
        canvas.getContext('2d')!.putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
        canvas.waAlpha = Uint8Array.from({ length: rgba.width * rgba.height }, (_, i) => rgba.data[i * 4 + 3]);
        image.surfaceCache.set(key, canvas);
        return canvas;
    }
    frame(object: WorldObject, image: NativeImage, parent?: WorldObject) {
        const noid = objectNoid(object), namedState = Number(field(object, 'choreState', 0)), gesture = field(object, 'gesture', ''), gestureSeq = field(object, 'gestureSeq', 0), now = this.time(), animated = this.preferences.animation !== false;
        let playback = this.playbacks.get(noid);
        if (!gesture && playback) {
            this.playbacks.delete(noid);
            playback = undefined;
        }
        else if (playback && (playback.image !== image || playback.namedState !== namedState)) {
            this.playbacks.delete(noid);
            playback = undefined;
        }
        if (gesture && (!playback || playback.seq !== gestureSeq || playback.gesture !== gesture)) {
            const plan = image.choreography(GESTURE_ALIASES[gesture.toUpperCase()] ?? [gesture], namedState, true);
            playback = { seq: gestureSeq, gesture, sequence: animated ? plan.states : [], endState: animated ? plan.endState : undefined, started: now, image, namedState };
            this.playbacks.set(noid, playback);
        }
        let graphicState = Number(field(object, 'graphicState', 0));
        let defaultState = namedState;
        if (parent?.classNumber === 53 && object.classNumber === 21) {
            const sitChore = Number(field(parent, 'seat_type', 0)) === 1 && image.chores.some((chore) => chore.name === 'sit_on_stool') ? 'sit_on_stool' : 'sit';
            defaultState = image.choreography([sitChore], namedState, true).endState;
        }
        const gestureIndex = Math.max(0, Math.floor((now - (playback?.started ?? now)) / FRAME_TIME));
        const settled = animated && playback && playback.sequence.length > 0 && gestureIndex >= playback.sequence.length ? playback : undefined;
        if (settled)
            defaultState = settled.endState ?? defaultState;
        const afterGesture = settled ? settled.started! + settled.sequence.length * FRAME_TIME : undefined;
        this.idles ??= new Map();
        let idle = this.idles.get(noid);
        if (!idle || idle.image !== image || idle.namedState !== defaultState || idle.afterGesture !== afterGesture) {
            idle = { image, namedState: defaultState, started: afterGesture ?? now, afterGesture, plan: defaultAnimation(image, defaultState) };
            this.idles.set(noid, idle);
        }
        const defaults = idle.plan.states;
        if (defaults.length) {
            let index = animated ? Math.max(0, Math.floor((now - idle.started) / FRAME_TIME)) : 0;
            if (index >= defaults.length)
                index = idle.plan.loopStart === null ? defaults.length - 1 : idle.plan.loopStart + (index - idle.plan.loopStart) % (defaults.length - idle.plan.loopStart);
            graphicState = defaults[index];
        }
        const motion = this.motions.get(noid);
        if (motion)
            prepareMotion(motion, image, namedState, now);
        const walking = motion && now - motion.start < motion.duration && animated;
        if (walking) {
            const sequence = motion.plan?.states ?? [];
            if (sequence.length)
                graphicState = sequence[Math.min(sequence.length - 1, Math.floor((now - motion.start) / FRAME_TIME))];
        }
        else if (animated && playback?.sequence.length && gestureIndex < playback.sequence.length)
            graphicState = playback.sequence[gestureIndex];
        // A real Tcl chore host can write individual native frame states. Its
        // retained overlay takes precedence over the convenience gesture player.
        const tclGraphicState = field(object, 'tclGraphicState');
        if (Number.isInteger(tclGraphicState) && !walking)
            graphicState = tclGraphicState;
        const moodOwner = parent?.classNumber === 21 ? parent : object;
        const parentMotion = parent?.classNumber === 21 ? this.motions.get(Number(objectNoid(parent))) : undefined;
        const orientation = walking ? motion.orientation : parentMotion && now - parentMotion.start < parentMotion.duration && this.preferences.animation !== false ? parentMotion.orientation : this.walkFacings?.get(Number(objectNoid(parent ?? object))) ?? Number(field(parent ?? object, 'orientation', 0));
        return image.frameFor(graphicState, orientation, Number(field(moodOwner, 'mood', 0)));
    }
    drawObject(object: WorldObject, x: number, y: number, depth = 0, parent?: WorldObject, hitOwner?: WorldObject): ObjectBounds | null {
        if (depth > 8 || (object.classNumber !== 20 && (field(object, 'common_flags', 0) & 1)))
            return null;
        // Ghosts are a corner indicator, independent of world depth and height.
        // Position the frame itself so custom anchors and loading art also fit.
        const cornerGhost = !depth && object.classNumber === 22, cornerInset = 8;
        const avatar = [21, 22].includes(Number(object.classNumber)), heldItem = parent?.classNumber === 21 && Number(field(object, 'container_noid', 0)) === objectNoid(parent) && Number(field(object, 'position', [0])[0]) === 0, owner = avatar || heldItem ? object : hitOwner ?? object;
        const ctx = this.context, name = field(object, 'imageURL', ''), version = field(object, 'imageVersion', 0), defaultImage = Number(field(object, 'imageDefault', 0)), resourceId = defaultImage ? 0x20000 + defaultImage : 0, key = `${name}@${version}#${resourceId}`, image = this.assets.get(key);
        if (!this.assets.has(key) && (name || resourceId))
            this.load(name, version, resourceId);
        if (!image || 'error' in image) {
            if (object.classNumber === 20)
                return null;
            if (cornerGhost) {
                x = Math.max(6, this.width - cornerInset - 6);
                y = cornerInset + 12;
            }
            const label = field(object, 'name', object.className ?? `Object ${objectNoid(object)}`);
            ctx.save();
            ctx.fillStyle = '#82958c';
            ctx.strokeStyle = '#c0d6c6';
            ctx.lineWidth = 1;
            ctx.fillRect(x - 6, y - 12, 12, 12);
            ctx.strokeRect(x - 6, y - 12, 12, 12);
            ctx.fillStyle = '#d9e6df';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            if (image?.error && !depth)
                ctx.fillText(`${label} · art unavailable`, x, y + 12);
            ctx.restore();
            this.hitRegions.push({ x: x - 6, y: y - 12, width: 12, height: 12, object: owner, sourceNoid: objectNoid(object) });
            const bound = { x: x - 30, y: y - 16, width: 60, height: 30, object };
            // Conversation layout follows selectable avatars while artwork is
            // pending or unavailable, using the same projection as the marker.
            if (!depth || avatar)
                this.bounds.push(bound);
            return bound;
        }
        const frame = this.frame(object, image as NativeImage, parent);
        if (!frame)
            return null;
        if (cornerGhost) {
            x = Math.max(0, this.width - cornerInset - frame.width) + frame.anchor.x;
            y = cornerInset + frame.height - frame.anchor.y;
        }
        const anchorSlot = avatar && parent?.classNumber === 53 ? 2 : undefined;
        const { originX, originY, bottomY } = frameGeometry(frame, x, y, anchorSlot);
        const bound = { x: originX, y: originY, width: frame.width, height: frame.height, object };
        const children = (this.state.objects ?? []).filter((o) => Number(field(o, 'container_noid', 0)) === Number(objectNoid(object)));
        const map = field(object, 'colorMap');
        // Attachment markers select children by their native slot. They are
        // layout metadata rather than drawable cels, and recursion is bounded.
        for (const part of frame.parts) {
            if (part.flags & 0x8000) {
                const slot = part.flags & 15;
                const child = children.find((o) => Number(field(o, 'position', [0])[0]) === slot);
                if (child) {
                    const childBound = this.drawObject(child, originX + part.x, bottomY - part.y, depth + 1, avatar ? object : parent ?? object, owner);
                    if (avatar && childBound) {
                        const right = Math.max(bound.x + bound.width, childBound.x + childBound.width), bottom = Math.max(bound.y + bound.height, childBound.y + childBound.height);
                        bound.x = Math.min(bound.x, childBound.x);
                        bound.y = Math.min(bound.y, childBound.y);
                        bound.width = right - bound.x;
                        bound.height = bottom - bound.y;
                    }
                }
            }
            else if (part.cel >= 0 && part.cel < (image as NativeImage).cels.length && !(part.flags & 0xff00)) {
                try {
                    const surface = this.surface(image as NativeImage, part.cel, map);
                    ctx.save();
                    ctx.translate(originX + part.x + (part.flags & 16 ? surface.width : 0), bottomY - part.y - surface.height + (part.flags & 32 ? surface.height : 0));
                    ctx.scale(part.flags & 16 ? -1 : 1, part.flags & 32 ? -1 : 1);
                    ctx.drawImage(surface, 0, 0);
                    ctx.restore();
                    if (object.classNumber !== 20)
                        this.hitRegions.push({ x: originX + part.x, y: bottomY - part.y - surface.height, width: surface.width, height: surface.height, flipX: !!(part.flags & 16), flipY: !!(part.flags & 32), alpha: surface.waAlpha, object: owner, sourceNoid: objectNoid(object) });
                }
                catch (error: any) {
                    image.error = error.message;
                    this.onAssetError?.(name, error.message);
                }
            }
        }
        if ((!depth || avatar) && object.classNumber !== 20) {
            this.bounds.push(bound);
            if (Number(objectNoid(object)) === this.selected) {
                ctx.strokeStyle = '#f1cb82';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(bound.x - 2, bound.y - 2, bound.width + 4, bound.height + 4);
                ctx.setLineDash([]);
            }
        }
        return bound;
    }
    draw() {
        if (this.finishDeparture())
            return;
        if (!this.context || this.destroyed)
            return;
        const ctx = this.context, objects = this.state.objects ?? [], now = this.time();
        const region = this.getRegion();
        const width = Number(this.state.viewport?.width ?? 512), height = Number(this.state.viewport?.height ?? 288);
        this.width = Number.isFinite(width) && width > 0 && width <= 4096 ? width : 512;
        this.height = Number.isFinite(height) && height > 0 && height <= 4096 ? height : 288;
        if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
            this.canvas.width = this.width;
            this.canvas.height = this.height;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.fillStyle = '#15231e';
        ctx.fillRect(0, 0, this.width, this.height);
        this.bounds = [];
        this.hitRegions = [];
        if (region)
            this.drawObject(region, 0, this.height);
        const regionNoid = objectNoid(region);
        const quip = this.activeConversationQuip();
        const visible = objects.filter((o) => o !== region && o.classNumber !== 20 && !(quip && Number(objectNoid(o)) === 14 && Number(o.classNumber) === 23) && !(field(o, 'common_flags', 0) & 1) && (Number(field(o, 'container_noid', 0)) === Number(regionNoid) || !field(o, 'container_noid', 0)));
        const positions = new Map<number, number[]>();
        for (const object of visible) {
            let p = field(object, 'position', [0, 0, 0]);
            const motion = this.motions.get(objectNoid(object));
            if (motion && this.preferences.animation !== false) {
                const image = this.assets.get(`${field(object, 'imageURL', '')}@${field(object, 'imageVersion', 0)}#${Number(field(object, 'imageDefault', 0)) ? 0x20000 + Number(field(object, 'imageDefault', 0)) : 0}`);
                if (image && !('error' in image))
                    prepareMotion(motion, image, Number(field(object, 'choreState', 0)), now);
                p = motionPosition(motion, now);
                if (now - motion.start >= motion.duration)
                    this.motions.delete(objectNoid(object));
            }
            positions.set(objectNoid(object), p);
        }
        // Occlusion follows the same displayed position as the sprite, rather
        // than jumping to the server's destination at the start of a walk.
        visible.sort((a, b) => { const pa = positions.get(objectNoid(a))!, pb = positions.get(objectNoid(b))!; const ba = !!(field(a, 'common_flags', 0) & 4), bb = !!(field(b, 'common_flags', 0) & 4); return Number(a.classNumber === 22) - Number(b.classNumber === 22) || Number(bb) - Number(ba) || Number(pb[ba ? 2 : 1] ?? 0) - Number(pa[ba ? 2 : 1] ?? 0) || objectNoid(b) - objectNoid(a); });
        const horizon = Number(field(region, 'horizon', 70)) || 70;
        for (const object of visible) {
            const p = positions.get(objectNoid(object))!;
            const projected = projectPosition(p, { height: this.height, horizon, background: !!(field(object, 'common_flags', 0) & 4) });
            this.drawObject(object, ...projected);
        }
        this.drawLabels();
        this.onLayout?.(this.bounds, this.width);
        if (!region && !visible.length) {
            ctx.fillStyle = '#9aafa2';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.state.status === 'connected' ? 'Waiting for region contents…' : 'Connect to a world to begin', this.width / 2, this.height / 2);
        }
    }
    drawLabels() {
        const ctx = this.context;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        for (const b of this.bounds) {
            if (this.preferences.names === false || this.preferences.showNames === false)
                continue;
            if (![21, 22, 200, 201].includes(Number(b.object.classNumber)) && objectNoid(b.object) !== this.selected)
                continue;
            const name = String(field(b.object, 'name', '')).slice(0, 60);
            if (!name)
                continue;
            const width = Math.min(this.width - 8, ctx.measureText(name).width + 10);
            const ghost = b.object.classNumber === 22;
            const x = ghost ? Math.max(width / 2 + 4, Math.min(this.width - width / 2 - 4, b.x + b.width / 2)) : Math.max(20, Math.min(this.width - 20, b.x + b.width / 2));
            const y = ghost ? Math.min(this.height - 4, b.y + b.height + 14) : Math.max(12, b.y - 6);
            ctx.fillStyle = '#10221de0';
            ctx.fillRect(x - width / 2, y - 10, width, 14);
            ctx.fillStyle = '#eef7ee';
            ctx.fillText(name, x, y);
        }
        this.drawConversationQuip();
    }
    drawConversationQuip() {
        const quip = this.activeConversationQuip();
        if (!quip)
            return;
        const speaker = this.bounds.find((bound) => Number(objectNoid(bound.object)) === quip.speakerNoid && !(Number(field(bound.object, 'common_flags', 0)) & 1));
        if (!speaker)
            return;
        const center = speaker.x + speaker.width / 2;
        if (!Number.isFinite(center) || center < 0 || center > this.width)
            return;
        const object = (this.state.objects ?? []).find((item) => Number(objectNoid(item)) === 14 && Number(item.classNumber) === 23);
        const name = String(field(object, 'imageURL', '') || 'o.quips1.img'), version = Number(field(object, 'imageVersion', 0)), resourceId = 0x20000 + (Number(field(object, 'imageDefault', 4)) || 4);
        const key = `${name}@${version}#${resourceId}`;
        if (!this.assets.has(key))
            void this.load(name, version, resourceId);
        const image = this.assets.get(key);
        if (image && !('error' in image)) {
            const state = image.namedStates.findIndex((item) => item.name === (quip.type === 1 ? 'thinkdow' : 'talkdown'));
            if (state >= 0) {
                const graphicState = image.choreography(['default'], state)[0], frame = graphicState === undefined ? undefined : image.frameFor(graphicState, 0, 0);
                if (frame && frame.width > 0 && frame.height > 0 && frame.width <= this.width && frame.height <= this.height) {
                    // Quip is UI decoration: draw at the transcript boundary,
                    // with its own native shape, and create no world hit region.
                    const left = Math.round(Math.max(0, Math.min(this.width - frame.width, center - frame.width / 2))), ctx = this.context;
                    try {
                        let painted = false;
                        for (const part of frame.parts) {
                            if (part.cel < 0 || part.cel >= image.cels.length || part.flags & 0xff00)
                                continue;
                            // Native customizable slots 239..254 all use the
                            // transcript green at master palette index 6.
                            const surface = this.surface(image, part.cel, Array(16).fill(6), true);
                            ctx.save();
                            try {
                                ctx.translate(left + part.x + (part.flags & 16 ? surface.width : 0), frame.height - part.y - surface.height + (part.flags & 32 ? surface.height : 0));
                                ctx.scale(part.flags & 16 ? -1 : 1, part.flags & 32 ? -1 : 1);
                                ctx.drawImage(surface, 0, 0);
                            }
                            finally { ctx.restore(); }
                            painted = true;
                        }
                        if (painted)
                            return;
                    }
                    catch {
                        // Pending or unusable artwork retains a simple pointer.
                    }
                }
            }
        }
        const ctx = this.context, x = Math.round(Math.max(10, Math.min(this.width - 10, center)));
        ctx.fillStyle = '#009f00';
        ctx.beginPath();
        if (quip.type === 1) {
            for (const [y, radius] of [[5, 5], [18, 3.5], [29, 2]] as const) {
                ctx.moveTo(x + radius, y);
                ctx.arc(x, y, radius, 0, Math.PI * 2);
            }
        }
        else {
            ctx.moveTo(x - 7, 0);
            ctx.lineTo(x + 7, 0);
            ctx.lineTo(x, 34);
            ctx.closePath();
        }
        ctx.fill();
    }
    destroy() { this.destroyed = true; this.departure = undefined; this.exitRequest = undefined; this.assetQueue.destroy(); cancelAnimationFrame(this.raf); this.canvas.removeEventListener('click', this.click); this.canvas.removeEventListener('dblclick', this.doubleClick); this.assets.clear(); this.surfaces.clear(); this.idles?.clear(); this.playbacks.clear(); this.motions.clear(); this.walkFacings.clear(); }
}
