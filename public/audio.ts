/** Decode native sound data and schedule cues from acknowledged world events.
 * Playback is opt-in and must also pass the browser's user-gesture gate. */
import type { WorldState, WorldObject, WorldEvent, WireFields } from './types.js';
import type { BinaryData } from './renderer.js';
export interface DecodedAudio {
    sampleRate: number;
    channels: Float32Array<ArrayBuffer>[];
    channelCount: number;
    frames: number;
    bits: number;
    duration: number;
    encodingRepairPasses: number;
}
export interface WorldAudioOptions {
    onError?: (error: any) => void;
    fetchResource?: (sound: number) => Promise<BinaryData>;
    AudioContext?: typeof AudioContext;
    now?: () => number;
}
/** Native MAG sound playback. Type-3 records are a two-byte native prefix followed
 * by AIFF PCM. No Tcl, plug-in, or executable is evaluated to play an asset. */
export class AudioFormatError extends Error {
    constructor(message: string) { super(message); this.name = 'AudioFormatError'; }
}
const MAX_BYTES = 16 * 1024 * 1024, MAX_SAMPLES = 16 * 1024 * 1024;
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition)
    throw new AudioFormatError(message); };
const bytesOf = (value: BinaryData) => value instanceof Uint8Array ? value : new Uint8Array(value);
const tag = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
/** Validate chunk and sample dimensions before allocating channel buffers.
 * AIFF samples are signed, big-endian, and interleaved; Web Audio expects
 * separate floating-point channels normalized around zero. */
function decodePCM(input: BinaryData): DecodedAudio {
    const bytes = bytesOf(input);
    check(bytes.length >= 12 && bytes.length <= MAX_BYTES, 'Invalid AIFF asset length');
    const base = tag(bytes, 0) === 'FORM' ? 0 : tag(bytes, 2) === 'FORM' ? 2 : -1;
    check(base >= 0, 'Missing AIFF FORM header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset: number) => { check(offset >= 0 && offset + 2 <= bytes.length, 'Truncated AIFF word'); return view.getUint16(offset, false); };
    const u32 = (offset: number) => { check(offset >= 0 && offset + 4 <= bytes.length, 'Truncated AIFF dword'); return view.getUint32(offset, false); };
    const end = base + 8 + u32(base + 4);
    check(end >= base + 12 && end <= bytes.length, 'AIFF FORM length exceeds asset');
    check(tag(bytes, base + 8) === 'AIFF', 'Only uncompressed AIFF PCM is supported');
    let common: {
        channels: number;
        frames: number;
        bits: number;
        sampleRate: number;
    } | null = null, sound: {
        start: number;
        end: number;
    } | null = null, cursor = base + 12, chunks = 0;
    while (cursor + 8 <= end) {
        check(++chunks <= 4096, 'Too many AIFF chunks');
        const kind = tag(bytes, cursor), length = u32(cursor + 4), start = cursor + 8, chunkEnd = start + length;
        check(chunkEnd <= end, 'AIFF chunk length exceeds FORM');
        if (kind === 'COMM') {
            check(!common && length >= 18, 'Invalid AIFF COMM chunk');
            const channels = u16(start), frames = u32(start + 2), bits = u16(start + 6), exponent = u16(start + 8);
            check(!(exponent & 0x8000) && (exponent & 0x7fff) > 0 && (exponent & 0x7fff) < 0x7fff, 'Invalid AIFF sample rate');
            const mantissa = u32(start + 10) * 2 ** 32 + u32(start + 14);
            const sampleRate = mantissa * 2 ** ((exponent & 0x7fff) - 16383 - 63);
            check(Number.isFinite(sampleRate) && sampleRate >= 1000 && sampleRate <= 384000, 'Unsupported AIFF sample rate');
            check(channels >= 1 && channels <= 8 && frames >= 1 && channels * frames <= MAX_SAMPLES, 'AIFF sample count exceeds limit');
            check([8, 16, 24, 32].includes(bits), 'Unsupported AIFF PCM sample width');
            common = { channels, frames, bits, sampleRate };
        }
        else if (kind === 'SSND') {
            check(!sound && length >= 8, 'Invalid AIFF SSND chunk');
            const offset = u32(start);
            check(offset <= length - 8, 'AIFF sound offset exceeds chunk');
            sound = { start: start + 8 + offset, end: chunkEnd };
        }
        cursor = chunkEnd + (length & 1);
    }
    check(cursor === end || cursor === end + 1, 'Invalid trailing AIFF chunk bytes');
    check(common && sound, 'AIFF is missing COMM or SSND');
    const { channels, frames, bits, sampleRate } = common, width = bits / 8;
    check(channels * frames * width <= sound.end - sound.start, 'Truncated AIFF PCM samples');
    const samples = Array.from({ length: channels }, () => new Float32Array(frames)), scale = 2 ** (bits - 1);
    let at = sound.start;
    for (let frame = 0; frame < frames; frame++)
        for (let channel = 0; channel < channels; channel++) {
            let value = 0;
            for (let byte = 0; byte < width; byte++)
                value = value * 256 + bytes[at++];
            if (value >= scale)
                value -= scale * 2;
            samples[channel][frame] = value / scale;
        }
    return { sampleRate, channels: samples, channelCount: channels, frames, bits, duration: frames / sampleRate, encodingRepairPasses: 0 };
}
const CP1252 = ['€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u008d', 'Ž', '\u008f', '\u0090', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u009d', 'ž', 'Ÿ'];
const CP1252_CODES = new Map(CP1252.map((value, index) => [value, index + 128]));
function reverseTextEncoding(bytes: Uint8Array) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), output: number[] = [];
    for (const character of text) {
        const extra = CP1252_CODES.get(character), code = character.codePointAt(0)!;
        if (extra !== undefined)
            output.push(extra);
        else if (code < 128 || code >= 160 && code <= 255)
            output.push(code);
        else
            throw new AudioFormatError('AIFF text-transcoding is not reversible');
    }
    return Uint8Array.from(output);
}
/** Nine admitted cache sounds were UTF-8/Windows-1252 transcoded twice. Undo at
 * most two strictly reversible passes, and accept only a fully valid AIFF file.
 * Original cache bytes are never changed. Ordinary malformed files still fail. */
export function decodeAIFF(input: BinaryData, { repairTextEncoding = true } = {}): DecodedAudio {
    let bytes = bytesOf(input), originalError;
    try {
        return decodePCM(bytes);
    }
    catch (error: any) {
        originalError = error;
    }
    if (repairTextEncoding && bytes.length <= MAX_BYTES) {
        for (let pass = 1; pass <= 2; pass++) {
            try {
                bytes = reverseTextEncoding(bytes);
            }
            catch {
                break;
            }
            try {
                return { ...decodePCM(bytes), encodingRepairPasses: pass };
            }
            catch { }
        }
    }
    throw originalError;
}
const FIXED_NOTICE_SOUNDS: Readonly<Record<number, readonly number[]>> = Object.freeze({
    87: [144], 95: [144], 1036: [153], 1153: [115], 1606: [122], 2403: [34], 2407: [34],
    2567: [198], 2563: [85], 2676: [14, 197], 2680: [197], 2684: [197], 2925: [14, 16], 2926: [16],
    3203: [78], 3207: [74], 3302: [14, 183], 3603: [107], 3607: [106], 4003: [16], 4007: [14, 16],
    4011: [14, 16], 4015: [16, 14], 4022: [16], 4026: [16], 4030: [16], 5303: [14, 16], 5307: [14],
    9907: [14, 16], 20505: [14, 197], 20603: [78], 20606: [74], 21003: [198], 21303: [198],
});
const FIXED_REPLY_SOUNDS: Readonly<Record<number, readonly number[]>> = Object.freeze({
    97: [145], 1035: [153], 1139: [115], 1580: [145], 1605: [122],
    3201: [78], 3205: [74], 3601: [107], 3605: [106], 20602: [78], 20605: [74],
    2675: [14, 197], 2678: [197], 2682: [197], 2806: [28, 16, 11], 2810: [28, 16, 14],
    2924: [14, 16], 4005: [14, 16], 4009: [14, 16], 4013: [16, 14], 5302: [14, 16], 5306: [14],
});
const getFields = (object: WorldObject | null | undefined): WireFields => object?.fields ?? object ?? {};
/** Recover data-only sound cues from the same native notices/forms as the client.
 * Source mappings: 00050069/6a (entry/exit), 000507d3/d4,e4/e6/e7 and
 * 000505ee/f0 (Ghost), 00050c8c/8f,00050e1c/1f,0005507b/7e (wear),
 * 00050a2f/32/35 (vending), and 000511ca/cd (randomizer). */
export function nativeSoundTriggers(state: WorldState, event: WorldEvent | null | undefined): number[] {
    if (!event || event.type === 'request' || event.type === 'decode-error' || Number(event.noid) === 10)
        return [];
    const id = Number(event.id ?? event.messageId), fields = event.fields ?? event.values ?? {}, objects = state.objects ?? [];
    if (id === 145)
        return [];
    if (fields.success !== undefined && Number(fields.success) !== 0) {
        return id === 1596 && Number(fields.success) === 11 ? [] : [83];
    }
    const issued = event.requestFields ?? [...(state.history ?? [])].reverse().find((previous) => previous.type === 'request' && Number(previous.id ?? previous.messageId) === Number(event.requestId) && Number(previous.noid) === Number(event.requestNoid ?? event.noid) && Number(previous.seq) < Number(event.seq))?.fields ?? {};
    const target = objects.find((object) => Number(object.noid) === Number(event.noid)), f = getFields(target);
    const ghost = getFields(objects.find((object) => Number(object.noid) === 15 && Number(object.classNumber ?? object.fields?.classNumber) === 22));
    const sounds: number[] = [];
    for (const key of ['entrySound', 'exitSound'])
        if (fields[key] !== undefined)
            sounds.push(Number(fields[key]));
    if ([1588, 1589].includes(id))
        sounds.push(Number(ghost.ghostSound));
    if ([2006, 2007].includes(id))
        sounds.push(Number(ghost.deghostSound));
    if (Number(event.requestId) === 2003)
        sounds.push(Number(ghost.statusSound));
    if (id === 301)
        sounds.push(Number(f[Number(fields.state) & 8 ? 'closeSound' : 'openSound']));
    if (id === 304)
        sounds.push(Number(f[Number(fields.state) & 8 ? 'closeSound' : 'openSound']));
    if ([4502, 4503, 21305].includes(id))
        sounds.push(Number(f.roll_sound));
    if ([4506, 4507].includes(id))
        sounds.push(Number(f.show_sound));
    if ([3212, 3213, 4152, 4153].includes(id)) {
        const action = fields.action ?? issued.action ?? f.action;
        if (action !== undefined)
            sounds.push(Number(f[Number(action) === 0 ? 'stop_sound' : 'run_sound']));
    }
    if (Number(event.requestId) === 300 && Number(fields.success) === 0)
        sounds.push(Number(f[Number(f.common_flags) & 8 ? 'closeSound' : 'openSound']));
    if ([1608, 1611].includes(Number(event.requestId)) && Number(fields.success) === 0) {
        const container = getFields(objects.find((object) => Number(object.noid) === Number(issued.item)));
        sounds.push(Number(container[Number(event.requestId) === 1611 ? 'closeSound' : 'openSound']));
    }
    if ([91, 95, 1574, 1716].includes(id)) {
        const item = [1574, 1716].includes(id) ? objects.find((object) => Number(object.noid) === Number(fields.item)) : target;
        const klass = Number(item?.classNumber ?? item?.fields?.classNumber);
        sounds.push(klass === 26 ? 115 : [91, 95].includes(id) ? 144 : 145);
    }
    else
        sounds.push(...(FIXED_NOTICE_SOUNDS[id] ?? []));
    if (event.requestId && fields.success !== undefined && Number(fields.success) === 0) {
        if ([85, 89, 93].includes(Number(event.requestId)))
            sounds.push(Number(target?.classNumber ?? f.classNumber) === 26 || [1152, 1156].includes(id) ? 115 : 144);
        else
            sounds.push(...(FIXED_REPLY_SOUNDS[Number(event.requestId)] ?? []));
    }
    return [...new Set(sounds.filter((sound) => Number.isInteger(sound) && sound > 0 && sound < 65535))];
}
/** Owns the audio context, per-world decode promises, and active sources.
 * Repeated snapshots advance an event cursor instead of replaying old cues. */
export class WorldAudio {
    declare onError: WorldAudioOptions['onError'];
    declare fetchResource: (sound: number) => Promise<BinaryData>;
    declare Context: typeof AudioContext | undefined;
    declare now: () => number;
    declare enabled: boolean;
    declare unlocked: boolean;
    declare context: AudioContext | null;
    declare buffers: Map<number, Promise<AudioBuffer | null>>;
    declare active: Set<AudioBufferSourceNode>;
    declare lastSequence: number;
    declare worldName: string | null;
    declare previousObjects: WorldObject[];
    declare destroyed: boolean;
    constructor({ onError, fetchResource, AudioContext: Context, now = () => Date.now() }: WorldAudioOptions = {}) {
        this.onError = onError;
        this.fetchResource = fetchResource ?? (async (sound) => {
            const response = await fetch(`/api/resource?id=${0x30000 + sound}`, { credentials: 'same-origin' });
            if (!response.ok)
                throw new Error(`World sound ${sound} is unavailable (HTTP ${response.status})`);
            return response.arrayBuffer();
        });
        this.Context = Context ?? globalThis.AudioContext ?? (globalThis as typeof globalThis & {
            webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        this.now = now;
        this.enabled = false;
        this.unlocked = false;
        this.context = null;
        this.buffers = new Map();
        this.active = new Set();
        this.lastSequence = 0;
        this.worldName = null;
        this.previousObjects = [];
        this.destroyed = false;
    }
    setEnabled(value: boolean) { this.enabled = Boolean(value); if (!this.enabled)
        for (const source of this.active) {
            try {
                source.stop();
            }
            catch { }
        } return this.enabled; }
    // Call from a user interaction: merely enabling sound cannot resume an
    // AudioContext suspended by the browser's autoplay policy.
    async unlock() {
        if (this.destroyed || !this.Context)
            return false;
        try {
            this.context ??= new this.Context();
            if (this.context.state === 'suspended')
                await this.context.resume();
            this.unlocked = this.context.state === 'running';
            return this.unlocked;
        }
        catch (error: any) {
            this.onError?.(error);
            return false;
        }
    }
    // Cache the in-flight promise too, so simultaneous cues for one sound
    // share a fetch and decode rather than allocating duplicate PCM buffers.
    async load(sound: number): Promise<AudioBuffer | null | undefined> {
        if (this.buffers.has(sound))
            return this.buffers.get(sound);
        const promise = (async () => {
            const pcm = decodeAIFF(await this.fetchResource(sound));
            if (this.destroyed || !this.context)
                return null;
            const buffer = this.context.createBuffer(pcm.channelCount, pcm.frames, pcm.sampleRate);
            pcm.channels.forEach((channel, index) => buffer.copyToChannel ? buffer.copyToChannel(channel, index) : buffer.getChannelData(index).set(channel));
            return buffer;
        })();
        this.buffers.set(sound, promise);
        return promise;
    }
    async play(sound: number, delay = 0) {
        if (!this.enabled || !this.unlocked || !this.context || this.destroyed)
            return;
        try {
            const buffer = await this.load(sound);
            if (!buffer || !this.enabled || this.destroyed)
                return;
            const source = this.context.createBufferSource(), gain = this.context.createGain();
            source.buffer = buffer;
            gain.gain.value = .35;
            source.connect(gain);
            gain.connect(this.context.destination);
            source.onended = () => { this.active.delete(source); source.disconnect(); gain.disconnect(); };
            this.active.add(source);
            source.start(this.context.currentTime + delay);
        }
        catch (error: any) {
            error.soundId = sound;
            this.onError?.(error);
        }
    }
    ingestState(state: WorldState) {
        if (this.destroyed)
            return;
        if (state.status === 'disconnected' && !(state.history?.length))
            this.lastSequence = 0;
        if (state.worldName !== undefined && this.worldName !== state.worldName) {
            this.worldName = state.worldName;
            this.buffers.clear();
            this.previousObjects = [];
            this.lastSequence = 0;
        }
        // Exit/removal notices may reference an object absent from this snapshot.
        // Retain its previous fields long enough to resolve that notice's sound.
        const audioObjects = new Map(this.previousObjects.map((object) => [Number(object.noid), object]));
        for (const object of state.objects ?? [])
            audioObjects.set(Number(object.noid), object);
        const audioState = { ...state, objects: [...audioObjects.values()] };
        this.previousObjects = state.objects ?? [];
        for (const event of state.history ?? []) {
            const sequence = Number(event.seq);
            if (!Number.isFinite(sequence) || sequence <= this.lastSequence)
                continue;
            this.lastSequence = sequence;
            const time = Number(event.time ?? event.at ?? this.now());
            // Reconnection can deliver retained history; stale events should not
            // produce a burst of sounds when the stream catches up.
            if (this.now() - time > 3000)
                continue;
            const sounds = nativeSoundTriggers(audioState, event);
            sounds.forEach((sound, index) => { void this.play(sound, index * .12); });
        }
    }
    destroy() { this.destroyed = true; this.enabled = false; for (const source of this.active) {
        try {
            source.stop();
        }
        catch { }
    } this.active.clear(); this.buffers.clear(); this.context?.close?.().catch?.(() => { }); this.context = null; }
}
