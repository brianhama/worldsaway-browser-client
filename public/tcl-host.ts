import type { WorldObject, WorldState, WireFields } from './types.js';
import type { NativeImage, NativeChoreCommand } from './renderer.js';
import type { TclContext, TclCallback, TclControl, TclDialog, TclDialogUpdate, TclChore, TclChoreJob, TclTimer, TclCancellation, TclVisualHostOptions, NativeGraphicReference } from './tcl-types.js';
/** Browser bindings for a real Tcl interpreter. This module never parses or
 * evaluates a Tcl program. dispatch() receives already evaluated argument words.
 * Sources: 00050001.tcl (chore/balloon wrappers), 000c0003 (chore editing),
 * 00050cee (body dialog), 000c000b (mail dialog), native command usage strings.
 */
import { decodeImage, celRGBA, AssetRequestQueue } from './renderer.js';
import { MASTER_PALETTE } from './palette.js';
import { parseTclList } from './documents.js';
import { getClass } from './actions.js';
export class TclHostError extends Error {
    constructor(message: string) { super(message); this.name = 'TclHostError'; }
}
export class TclHostCancelledError extends TclHostError {
    declare silent: boolean;
    constructor(message: any = 'The Tcl visual context ended.') { super(message); this.name = 'TclHostCancelledError'; this.silent = true; }
}
const fields = (object: WorldObject | null | undefined): WireFields => object?.fields ?? object ?? {};
const noid = (object: WorldObject | null | undefined) => Number(object?.noid ?? fields(object).noid);
const copy = <T>(value: T): T => value === undefined ? value : structuredClone(value);
const integer = (value: unknown, min: number, max: number, label: string): number => { if (value === undefined || value === null || value === '')
    throw new TclHostError(`Missing ${label}`); const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new TclHostError(`Invalid ${label}`); return n; };
const text = (value: unknown, max = 262144): string => { const s = String(value ?? ''); if (s.length > max || s.includes('\0'))
    throw new TclHostError('Invalid native text'); return s; };
const list = (value: any) => Array.isArray(value) ? value : parseTclList(text(value));
const point = (value: any) => { const a = list(value); if (a.length !== 3)
    throw new TclHostError('A native position needs three coordinates'); return a.map((v) => integer(v, -32768, 32767, 'position')); };
const objectKey = (state: WorldState) => `${state?.status === 'connected' ? state.worldName ?? 'connected' : 'disconnected'}|${state?.avatar ?? ''}|${state?.actorNoid ?? ''}|${fields(state?.region).name ?? ''}|${fields(state?.region).areaCode ?? ''}`;
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
/** Original cel/frame raster, without DOM dependencies. A native ctrlGraphic
 * consumes a typed CEL handle (0044aa40), not an object number or filename.
 * Explicit frame descriptors are useful for browser callers and use the same
 * cel placement/flips as the world renderer; attachment markers contain no art.
 */
export function composeNativeGraphic(image: NativeImage, reference: NativeGraphicReference = {}) {
    const palette = reference.masterPalette ?? MASTER_PALETTE, map = reference.colorMap;
    if (reference.celIndex !== undefined)
        return celRGBA(image, integer(reference.celIndex, 0, image.cels.length - 1, 'cel index'), map, palette);
    const frame = reference.frameIndex !== undefined ? image.frames[integer(reference.frameIndex, 0, image.frames.length - 1, 'frame index')] : image.frameFor(Number(reference.graphicState) || 0, Number(reference.orientation) || 0, Number(reference.mood) || 0);
    if (!frame || !frame.width || !frame.height || frame.width * frame.height > 16777216)
        throw new TclHostError('Invalid native graphic frame');
    const data = new Uint8ClampedArray(frame.width * frame.height * 4);
    for (const part of frame.parts) {
        if (part.flags & 0xff00)
            continue;
        const cel = celRGBA(image, integer(part.cel, 0, image.cels.length - 1, 'frame cel'), map, palette), left = part.x, top = frame.height - part.y - cel.height;
        for (let y = 0; y < cel.height; y++)
            for (let x = 0; x < cel.width; x++) {
                const dx = left + x, dy = top + y;
                if (dx < 0 || dy < 0 || dx >= frame.width || dy >= frame.height)
                    continue;
                const sx = part.flags & 16 ? cel.width - x - 1 : x, sy = part.flags & 32 ? cel.height - y - 1 : y, source = (sy * cel.width + sx) * 4;
                if (cel.data[source + 3])
                    data.set(cel.data.subarray(source, source + 4), (dy * frame.width + dx) * 4);
            }
    }
    return { width: frame.width, height: frame.height, data };
}
/** A world-scoped presentation environment. The generation counter invalidates
 * asynchronous work whenever its objects, queues, and dialogs are reset. */
export class TclVisualHost {
    declare getState: () => WorldState;
    declare renderer: TclVisualHostOptions['renderer'];
    declare audio: TclVisualHostOptions['audio'];
    declare imageProvider: TclVisualHostOptions['getImage'];
    declare fetchResource: NonNullable<TclVisualHostOptions['fetchResource']>;
    declare onChange: TclVisualHostOptions['onChange'];
    declare onBalloon: TclVisualHostOptions['onBalloon'];
    declare onDialog: TclVisualHostOptions['onDialog'];
    declare onCallback: TclVisualHostOptions['onCallback'];
    declare onError: TclVisualHostOptions['onError'];
    declare now: NonNullable<TclVisualHostOptions['now']>;
    declare frameTime: NonNullable<TclVisualHostOptions['frameTime']>;
    declare setTimer: NonNullable<TclVisualHostOptions['setTimer']>;
    declare clearTimer: NonNullable<TclVisualHostOptions['clearTimer']>;
    declare state: WorldState | null;
    declare worldKey: string | null;
    declare overlays: Map<number, WireFields>;
    declare hidden: Set<number>;
    declare choreHandles: Map<string, TclChore>;
    declare queues: Map<number, TclChoreJob>;
    declare choreJobs: Set<TclChoreJob>;
    declare cancelledTasks: Set<string>;
    declare dialogs: Map<string, TclDialog>;
    declare graphics: Map<string, NativeGraphicReference>;
    declare timers: Set<TclTimer>;
    declare images: Map<string, Promise<NativeImage>>;
    declare requests: AssetRequestQueue;
    declare generation: number;
    declare serial: number;
    declare balloonNoid: number | null;
    declare destroyed: boolean;
    constructor({ getState, renderer, audio, getImage, fetchResource, onChange, onBalloon, onDialog, onCallback, onError, now = () => Date.now(), frameTime = 175, setTimer = setTimeout, clearTimer = clearTimeout }: TclVisualHostOptions = {}) {
        this.getState = getState ?? (() => this.state ?? { objects: [] });
        this.renderer = renderer;
        this.audio = audio;
        this.imageProvider = getImage;
        this.fetchResource = fetchResource ?? (async (url: any, signal: any) => { const response = await fetch(url, { signal, priority: 'low', credentials: 'same-origin' }); if (!response.ok)
            throw new TclHostError(`Native image request failed (${response.status})`); return response.arrayBuffer(); });
        this.onChange = onChange;
        this.onBalloon = onBalloon;
        this.onDialog = onDialog;
        this.onCallback = onCallback;
        this.onError = onError;
        this.now = now;
        this.frameTime = frameTime;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.state = null;
        this.worldKey = null;
        this.overlays = new Map();
        this.hidden = new Set();
        this.choreHandles = new Map();
        this.queues = new Map();
        this.choreJobs = new Set();
        this.cancelledTasks = new Set();
        this.dialogs = new Map();
        this.graphics = new Map();
        this.timers = new Set();
        this.images = new Map();
        this.requests = new AssetRequestQueue(3);
        this.generation = 0;
        this.serial = 0;
        this.balloonNoid = null;
        this.destroyed = false;
    }
    emit() { this.onChange?.(); }
    ingestState(state: WorldState) {
        const key = objectKey(state);
        if (this.worldKey !== null && key !== this.worldKey)
            this.reset();
        this.worldKey = key;
        const objects = new Map((state?.objects ?? []).map((object) => [noid(object), object]));
        for (const [id, patch] of this.overlays) {
            const current = objects.get(id), previous = (this.state?.objects ?? []).find((object) => noid(object) === id);
            if (!current) {
                this.overlays.delete(id);
                this.hidden.delete(id);
                continue;
            }
            // A new authoritative field supersedes an older local script field. Routine
            // snapshots with unchanged source fields preserve the visual overlay.
            for (const key of Object.keys(patch))
                if (previous && !same(fields(previous)[key], fields(current)[key]) && !same(patch[key], fields(current)[key])) {
                    delete patch[key];
                    if (key === 'graphicState')
                        delete patch.tclGraphicState;
                }
        }
        this.state = state;
    }
    base() { return this.getState() ?? this.state ?? { objects: [] }; }
    object(id: any) { id = integer(id, 0, 65535, 'object number'); const source = (this.base().objects ?? []).find((object) => noid(object) === id); if (!source)
        throw new TclHostError(`Object ${id} is unavailable`); return { ...source, fields: { ...fields(source), ...this.overlays.get(id) } }; }
    getObject(id: any, path: any) {
        const object = this.object(id), f = fields(object);
        if (path === undefined)
            return copy(f);
        const match = /^([A-Za-z_][\w]*)(?:\((\d+)\))?$/.exec(String(path));
        if (!match)
            throw new TclHostError('Invalid native object field');
        const [, key, index] = match;
        let value;
        if (key === 'noid')
            value = noid(object);
        else if (key === 'classNumber')
            value = Number(object.classNumber ?? f.classNumber);
        else if (key === 'contents') {
            const capacity = Number(f.reducedCapacity ?? getClass(Number(object.classNumber))?.capacity ?? 0);
            value = Array.from({ length: Math.max(0, Math.min(256, capacity)) }, () => 65535);
            for (const child of this.displayState(this.base(), { includeHidden: true }).objects ?? [])
                if (Number(fields(child).container_noid) === noid(object)) {
                    const slot = Number(fields(child).position?.[0]);
                    if (Number.isInteger(slot) && slot >= 0 && slot < value.length)
                        value[slot] = noid(child);
                }
            if (Array.isArray(f.contents))
                value = f.contents;
        }
        else
            value = Object.hasOwn(f, key) ? f[key] : undefined;
        if (index !== undefined)
            value = Array.isArray(value) ? value[Number(index)] : undefined;
        if (value === undefined)
            throw new TclHostError(`Native field ${path} is unavailable on object ${id}`);
        return copy(value);
    }
    setObject(id: any, path: any, value: any) {
        const object = this.object(id), match = /^([A-Za-z_][\w]*)(?:\((\d+)\))?$/.exec(String(path));
        if (!match)
            throw new TclHostError('Invalid native object field');
        const [, key, index] = match;
        if (['noid', 'classNumber', '__proto__', 'prototype', 'constructor'].includes(key))
            throw new TclHostError('Native object identity or prototype cannot be changed by a visual binding');
        let normalized = copy(value);
        if (index !== undefined) {
            const old = this.getObject(id, key);
            if (!Array.isArray(old))
                throw new TclHostError('Native field is not an array');
            const at = integer(index, 0, old.length - 1, 'field index');
            old[at] = typeof old[at] === 'number' ? integer(value, key === 'colorMap' || key === 'contents' ? 0 : key === 'position' ? -32768 : -0x80000000, key === 'colorMap' ? 255 : key === 'contents' ? 65535 : key === 'position' ? 32767 : 0xffffffff, 'array field value') : copy(value);
            normalized = old;
        }
        else if (key === 'position')
            normalized = point(value);
        else if (key === 'colorMap') {
            normalized = list(value).map((v) => integer(v, 0, 255, 'palette entry'));
            if (normalized.length !== 16)
                throw new TclHostError('A native color map needs sixteen entries');
        }
        else if (typeof fields(object)[key] === 'number' || ['graphicState', 'choreState', 'orientation', 'mood', 'container_noid', 'common_flags'].includes(key))
            normalized = integer(value, -0x80000000, 0xffffffff, 'native field value');
        else if (Array.isArray(fields(object)[key]) && !Array.isArray(value))
            normalized = list(value);
        const patch = this.overlays.get(noid(object)) ?? {};
        patch[key] = normalized;
        if (key === 'graphicState')
            patch.tclGraphicState = normalized;
        this.overlays.set(noid(object), patch);
        this.emit();
        return copy(normalized);
    }
    // Clone patches at this boundary so script-visible values cannot alias the
    // authoritative snapshot or a caller's mutable input.
    patch(id: number, patch: WireFields) { this.object(id); const current = this.overlays.get(Number(id)) ?? {}; Object.assign(current, copy(patch)); this.overlays.set(Number(id), current); this.emit(); }
    displayState(state: WorldState = this.base(), { includeHidden = false } = {}): WorldState { const objects = (state.objects ?? []).filter((object) => includeHidden || !this.hidden.has(noid(object))).map((object) => this.overlays.has(noid(object)) ? { ...object, fields: { ...fields(object), ...copy(this.overlays.get(noid(object))) } } : object); return { ...state, objects, region: objects.find((object) => noid(object) === 0) ?? state.region }; }
    visualUpdates() { return [...this.overlays].map(([noid, fields]) => ({ noid, fields: copy(fields) })); }
    /** Resolve the object's advertised image version, using the native default
     * resource only as a fallback when the named asset is unavailable. */
    async image(id: any): Promise<NativeImage> {
        const object = this.object(id);
        if (this.imageProvider)
            return this.imageProvider(object);
        const f = fields(object), resource = f.imageDefault ? 0x20000 + Number(f.imageDefault) : 0, name = text(f.imageURL ?? '', 63), version = Number(f.imageVersion) || 0, key = `${name}@${version}#${resource}`;
        const cached = this.renderer?.assets?.get(key);
        if (cached && !('error' in cached))
            return cached;
        if (!name && !resource)
            throw new TclHostError('The object has no native image');
        if (!this.images.has(key))
            this.images.set(key, this.requests.run(async (signal: any) => {
                let data;
                try {
                    data = await this.fetchResource(name ? `/api/asset?name=${encodeURIComponent(name)}&version=${version}` : `/api/resource?id=${resource}`, signal);
                }
                catch (error: any) {
                    if (!name || !resource || signal.aborted)
                        throw error;
                    data = await this.fetchResource(`/api/resource?id=${resource}`, signal);
                }
                return decodeImage(data);
            }));
        return this.images.get(key)!;
    }
    registerGraphic(reference: NativeGraphicReference, handle?: string) {
        if (!reference || typeof reference !== 'object' || this.graphics.size >= 8192)
            throw new TclHostError('Invalid or excessive native graphic handles');
        const key = handle === undefined ? `CEL:browser:${++this.serial}` : text(handle, 128);
        if (!/^CEL[:(]/.test(key))
            throw new TclHostError('A native graphic needs a CEL handle');
        if (reference.celIndex === undefined && reference.frameIndex === undefined && reference.graphicState === undefined)
            throw new TclHostError('A native graphic handle needs an explicit cel or frame');
        this.graphics.set(key, { ...reference, colorMap: copy(reference.colorMap) });
        return key;
    }
    async drawGraphic(canvas: HTMLCanvasElement, control: TclControl) {
        const reference = control?.graphic ?? this.graphics.get(String(control?.value ?? control?.text));
        if (!reference)
            throw new TclHostError('The native CEL handle has no admitted graphic resource');
        const generation = this.generation;
        let image = reference.image;
        if (!image) {
            if (reference.objectNoid !== undefined)
                image = await this.image(reference.objectNoid);
            else {
                const name = text(reference.imageURL ?? '', 63), version = integer(reference.imageVersion ?? 0, 0, 0xffffffff, 'image version'), resource = reference.resourceId ?? (reference.imageDefault ? 0x20000 + Number(reference.imageDefault) : 0), key = `graphic:${name}@${version}#${resource}`;
                if (!name && !resource)
                    throw new TclHostError('The native graphic has no admitted image reference');
                if (!this.images.has(key))
                    this.images.set(key, this.requests.run(async (signal: any) => { let data; try {
                        data = await this.fetchResource(name ? `/api/asset?name=${encodeURIComponent(name)}&version=${version}` : `/api/resource?id=${integer(resource, 0, 0xffffffff, 'image resource')}`, signal);
                    }
                    catch (error: any) {
                        if (!name || !resource || signal.aborted)
                            throw error;
                        data = await this.fetchResource(`/api/resource?id=${integer(resource, 0, 0xffffffff, 'image resource')}`, signal);
                    } return decodeImage(data); }));
                image = await this.images.get(key);
            }
        }
        if (this.destroyed || generation !== this.generation)
            throw new TclHostCancelledError();
        const rgba = composeNativeGraphic(image!, reference), width = integer(control.width ?? rgba.width, 1, 4096, 'graphic width'), height = integer(control.height ?? rgba.height, 1, 4096, 'graphic height');
        if (width * height > 16777216)
            throw new TclHostError('Native graphic control is too large');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context)
            throw new TclHostError('A canvas context is required for the native graphic');
        // Native GraphicControl's WM_PAINT (00426880 -> 0041c000) fills the
        // full control rectangle from the cel pixel buffer. Preserve hard edges.
        const output = context.createImageData(width, height);
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const source = (Math.floor(y * rgba.height / height) * rgba.width + Math.floor(x * rgba.width / width)) * 4;
                output.data.set(rgba.data.subarray(source, source + 4), (y * width + x) * 4);
            }
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, width, height);
        context.putImageData(output, 0, 0);
        return { width, height, sourceWidth: rgba.width, sourceHeight: rgba.height };
    }
    sleep(ms: any, generation: any = this.generation, owner: any = {}) { ms = integer(ms, 0, 3600000, 'delay'); if (generation !== this.generation || this.destroyed || owner.token?.cancelled)
        return Promise.reject(new TclHostCancelledError()); return new Promise((resolve: any, reject: any) => { const item = { timer: null, reject, ...owner }; item.timer = this.setTimer(() => { this.timers.delete(item); generation === this.generation && !this.destroyed && !owner.token?.cancelled ? resolve('') : reject(new TclHostCancelledError()); }, ms); this.timers.add(item); }); }
    handle(value: any) { const item = this.choreHandles.get(String(value)); if (!item)
        throw new TclHostError('Unknown or freed native chore'); return item; }
    storeChore(item: TclChore) { if (this.choreHandles.size >= 8192)
        throw new TclHostError('Too many native chore handles'); const key = `chore:${++this.serial}`; this.choreHandles.set(key, copy(item)); return key; }
    stateIndex(image: NativeImage, value: unknown, fallback = 0) { if (value === undefined || value === '')
        return fallback; const numeric = Number(value); const index = Number.isInteger(numeric) && String(value).trim() !== '' ? numeric : image.namedStates.findIndex((item: any) => item.name === String(value)); if (index < 0 || index >= image.namedStates.length)
        throw new TclHostError(`Unknown native named state ${value}`); return index; }
    /** A completed default chore returns frame timing to the renderer. Explicit
     * frame writes and a requested non-default end chore retain their pin. */
    settleChoreState(id: number, state: number, sequence: number[], pin = false) {
        this.object(id);
        const patch = this.overlays.get(Number(id)) ?? {};
        Object.assign(patch, { choreState: state, gesture: '' });
        if (sequence.length) {
            patch.graphicState = sequence[0];
            if (pin)
                patch.tclGraphicState = sequence[0];
        }
        if (!pin) {
            // Null also masks a pin echoed by the bridge. Append this field
            // after graphicState because the bridge derives a pin from a
            // graphicState write while applying a visual reply in key order.
            delete patch.tclGraphicState;
            patch.tclGraphicState = null;
        }
        this.overlays.set(Number(id), patch);
        this.emit();
    }
    async loadChore(spec: any, id: any, state?: any): Promise<TclChore> {
        const image = await this.image(id), current = this.stateIndex(image, state, Number(fields(this.object(id)).choreState) || 0), context = image.namedStates[current];
        const entry = context?.entries.find((item) => item.name === String(spec)) ?? context?.entries.find((item) => image.chores[item.chore]?.name === String(spec));
        const numeric = Number(spec), index = entry?.chore ?? (Number.isInteger(numeric) && String(spec).trim() !== '' ? numeric : image.chores.findIndex((item: any) => item.name === String(spec))), chore = image.chores[index];
        if (!chore)
            throw new TclHostError(`Unknown native chore ${spec}`);
        return { name: chore.name, noid: Number(id), index, endState: chore.next || context?.name || 'default', endChore: 'default', commands: copy(chore.commands), imageState: current };
    }
    async runChore(id: number, chore: TclChore, generation: number, token: TclCancellation) {
        const check = () => { if (generation !== this.generation || token.cancelled)
            throw new TclHostCancelledError(); };
        check();
        let frozenFrame: number | undefined;
        for (const command of chore.commands) {
            check();
            if (Number(command.type) !== 1)
                throw new TclHostError(`Native chore opcode ${command.type} is unsupported`);
            const position = this.getObject(id, 'position');
            const coords = point(position.map((value: any, i: any) => Number(value) + Number([command.dx, command.dy, command.dz][i] ?? 0)));
            // Animation preferences affect presentation only: Tcl still sees
            // each frame state and position delta, and every delay still runs.
            // Capture the current pose once on disabling, then resume at the
            // current command when animation is enabled again.
            if (this.renderer?.preferences?.animation === false) {
                if (frozenFrame === undefined) {
                    const current = fields(this.object(id)), fallback = Number(current.graphicState ?? 0);
                    frozenFrame = Number.isInteger(current.tclGraphicState) ? current.tclGraphicState : Number.isInteger(fallback) ? fallback : 0;
                }
            }
            else
                frozenFrame = undefined;
            this.patch(id, { gesture: '', graphicState: command.state, tclGraphicState: frozenFrame ?? command.state, position: coords });
            await this.sleep(this.frameTime, generation, { taskId: token.taskId, token });
        }
        const image = await this.image(id);
        check();
        const state = this.stateIndex(image, chore.endState, Number(fields(this.object(id)).choreState) || 0), endChore = chore.endChore || 'default', defaults = image.choreography([endChore], state);
        this.settleChoreState(id, state, defaults, endChore !== 'default');
    }
    /** Serialize chores per object while allowing different objects to animate
     * concurrently. Snapshot the chore so later edits cannot rewrite queued work. */
    queueChore(id: number, chore: TclChore, context: TclContext = {}) {
        if (context.taskId !== undefined && this.cancelledTasks.has(String(context.taskId)))
            throw new TclHostCancelledError();
        id = integer(id, 0, 65535, 'object number');
        this.object(id);
        const generation = this.generation, old = this.queues.get(id), token = { taskId: context.taskId ?? null, cancelled: false }, snapshot = copy(chore), job: TclChoreJob = { noid: id, token, tail: null, rejectCancel: null, active: false };
        const cancelled = new Promise((_: any, reject: any) => { job.rejectCancel = reject; });
        const work = (old?.tail ?? Promise.resolve()).catch(() => { }).then(() => { if (generation !== this.generation || token.cancelled)
            throw new TclHostCancelledError(); job.active = true; return this.runChore(id, snapshot, generation, token); });
        job.tail = Promise.race([work, cancelled]);
        this.choreJobs.add(job);
        this.queues.set(id, job);
        job.tail.catch((error: any) => { if (!(error instanceof TclHostCancelledError))
            this.onError?.(error); }).finally(() => { job.active = false; this.choreJobs.delete(job); });
        return '';
    }
    cancelChore(job: TclChoreJob) { job.token.cancelled = true; const error = new TclHostCancelledError(); for (const item of this.timers)
        if (item.token === job.token) {
            this.clearTimer(item.timer ?? undefined);
            this.timers.delete(item);
            item.reject(error);
        } job.rejectCancel?.(error); if (job.active) {
        const patch = this.overlays.get(job.noid);
        if (patch) {
            delete patch.tclGraphicState;
            delete patch.gesture;
        }
    } }
    clearChores(id: any) { id = integer(id, 0, 65535, 'object number'); for (const job of this.choreJobs)
        if (job.noid === id)
            this.cancelChore(job); this.queues.delete(id); const patch = this.overlays.get(id); if (patch) {
        delete patch.tclGraphicState;
        delete patch.gesture;
    } this.emit(); return ''; }
    // A task owns its chores, timers, and dialogs. Cancellation is narrower
    // than a world reset and leaves unrelated script tasks running.
    cancelTask(taskId: any) {
        if (taskId === undefined || taskId === null || taskId === '')
            return 0;
        const owner = String(taskId);
        this.cancelledTasks.add(owner);
        let count = 0;
        for (const job of this.choreJobs)
            if (String(job.token.taskId) === owner) {
                this.cancelChore(job);
                count++;
            }
        for (const item of this.timers)
            if (String(item.taskId) === owner) {
                this.clearTimer(item.timer ?? undefined);
                this.timers.delete(item);
                item.reject(new TclHostCancelledError());
                count++;
            }
        for (const [id, dialog] of this.dialogs)
            if (String(dialog.context?.taskId) === owner) {
                this.dialogs.delete(id);
                this.onDialog?.({ id, closed: true });
                count++;
            }
        this.emit();
        return count;
    }
    async waitBits(id: any, bits: any, timeout: any) {
        id = integer(id, 0, 65535, 'object number');
        bits = integer(bits, 0, 0xffff, 'wait bits');
        if (bits & ~2)
            throw new TclHostError(`Unsupported native wait bits ${bits}`);
        const job = this.queues.get(id);
        if (!job || !(bits & 2))
            return '';
        if (timeout === undefined) {
            await job.tail;
            return '';
        }
        const duration = integer(timeout, 0, 3600000, 'wait timeout');
        if (duration === 0) {
            await job.tail;
            return '';
        }
        let timer;
        try {
            await Promise.race([job.tail, new Promise((_: any, reject: any) => { timer = this.setTimer(() => reject(new TclHostError('Native chore wait timed out')), duration); })]);
            return '';
        }
        finally {
            if (timer !== undefined)
                this.clearTimer(timer);
        }
    }
    balloon(id: any, message: any, type: any = 0) {
        id = integer(id, 0, 65535, 'speaker');
        type = integer(type, 0, 4, 'balloon type');
        message = text(message, 4096);
        this.eraseQuip();
        const until = this.now() + 10000;
        if ((this.base().objects ?? []).some((object) => noid(object) === id)) {
            this.patch(id, { presentationSpeech: { text: message, until, type } });
            this.balloonNoid = id;
        }
        this.onBalloon?.({ noid: id, text: message, type, until });
        return '';
    }
    eraseQuip() { if (this.balloonNoid !== null) {
        const patch = this.overlays.get(this.balloonNoid);
        if (patch)
            delete patch.presentationSpeech;
        this.balloonNoid = null;
        this.emit();
    } return ''; }
    dialog(id: any): TclDialog { const item = this.dialogs.get(String(id)); if (!item)
        throw new TclHostError('The native dialog is closed or unavailable'); return item; }
    control(dialog: any, id: any): TclControl { const item = this.dialog(dialog).controls.find((control) => control.id === String(id)); if (!item)
        throw new TclHostError('The native dialog control is unavailable'); return item; }
    emitDialog(id: any) { const item = this.dialog(id); this.onDialog?.(copy(item)); }
    createDialog(width: any, height: any, title: any, style: any = 'standard', context: any = {}) { if (this.dialogs.size >= 64)
        throw new TclHostError('Too many native dialogs'); const id = `dialog:${++this.serial}`; this.dialogs.set(id, { id, width: integer(width, 1, 4096, 'dialog width'), height: integer(height, 1, 4096, 'dialog height'), title: text(title, 255), style: text(style, 32), context: copy(context), visible: false, made: false, controls: [] }); this.emitDialog(id); return id; }
    callback(args: any[]): TclCallback | null { if (args.length === 0)
        return null; if (args.length === 1)
        return { script: text(args[0]) }; if (args.length !== 3)
        throw new TclHostError('Invalid native dialog callback'); const pairs = list(args[2]); if (pairs.length % 2)
        throw new TclHostError('Native callback values need name/value pairs'); return { command: { noid: integer(args[0], 0, 65535, 'callback object'), id: integer(args[1], 0, 65535, 'callback message'), fields: Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_: any, i: any) => [String(pairs[i * 2]), copy(pairs[i * 2 + 1])])) } }; }
    createControl(type: string, args: any[], context: TclContext = {}) {
        if (args.length < 7)
            throw new TclHostError('Invalid native dialog control arguments');
        const [dialog, id, x, y, width, height, value, ...callback] = args, item = this.dialog(dialog);
        if (item.controls.length >= 2048 || item.controls.some((control) => control.id === String(id)))
            throw new TclHostError('Duplicate or excessive native dialog controls');
        const control: TclControl = { id: text(id, 128), type, x: integer(x, -4096, 4096, 'control x'), y: integer(y, -4096, 4096, 'control y'), width: integer(width, 0, 4096, 'control width'), height: integer(height, 0, 4096, 'control height'), text: text(value), value: ['checkbox', 'radio'].includes(type) ? 0 : text(value), callback: this.callback(callback), context: copy(context), enabled: true, visible: true, default: type === 'defaultButton', escape: type === 'escapeButton', group: type === 'radio' ? [...item.controls].reverse().find((control) => control.type === 'group')?.id ?? 'root' : null, items: [], selected: -1, maxLength: 262144 };
        item.controls.push(control);
        this.emitDialog(dialog);
        return String(id);
    }
    /** Capture the complete control-value set before forwarding a callback.
     * Callback source remains Tcl data and is executed only by the interpreter. */
    async activateControl(dialogId: any, controlId: any, { value, selected }: any = {}) {
        const dialog = this.dialog(dialogId), control = this.control(dialogId, controlId);
        if (!dialog.visible || !control.visible || !control.enabled)
            throw new TclHostError('The native control is not active');
        if (value !== undefined)
            control.value = ['checkbox', 'radio'].includes(control.type) ? integer(value, 0, 1, 'checkbox value') : text(value, control.maxLength);
        if (control.type === 'radio' && Number(control.value) === 1)
            for (const peer of dialog.controls)
                if (peer.type === 'radio' && peer.group === control.group && peer.id !== control.id)
                    peer.value = 0;
        if (control.type === 'editcombo' && value !== undefined)
            control.selected = control.items.findIndex((item: any) => item.text === String(value));
        if (selected !== undefined)
            control.selected = integer(selected, -1, control.items.length - 1, 'list selection');
        const selectedItem = control.selected >= 0 ? control.items[control.selected] : null, listControl = ['list', 'combo', 'editcombo'].includes(control.type);
        if (listControl && selectedItem && !selectedItem.enabled)
            throw new TclHostError('The native list item is disabled');
        if (['combo', 'editcombo'].includes(control.type) && selectedItem && value === undefined)
            control.value = selectedItem.text;
        const callback = listControl ? (selectedItem?.callback ?? control.callback) : control.callback;
        this.emitDialog(dialogId);
        const event = { dialogId: String(dialogId), controlId: String(controlId), context: { ...copy(dialog.context), ...copy(control.context) }, values: Object.fromEntries(dialog.controls.map((item) => [item.id, copy(item.value)])), selected: control.selected, ...copy(callback ?? {}) };
        if (callback)
            await this.onCallback?.(event);
        return event;
    }
    /** Dispatch only reconstructed bindings with already evaluated arguments.
     * Unknown operations fail explicitly so scripts can handle unsupported APIs. */
    async dispatch(command: string, args: any[] = [], context: TclContext = {}): Promise<any> {
        if (this.destroyed || context.taskId !== undefined && this.cancelledTasks.has(String(context.taskId)))
            throw new TclHostCancelledError();
        if (!Array.isArray(args))
            throw new TclHostError('Native host arguments must be an evaluated argument array');
        const name = String(command), [a, b, c, d] = args;
        if (name === '@obj' || name === 'objectGet' || name === 'objectSet')
            return args.length >= 3 || name === 'objectSet' ? this.setObject(a, b, c) : this.getObject(a, b);
        if (name === '@class') {
            const object = this.object(a), definition = getClass(Number(object.classNumber));
            if (!definition)
                throw new TclHostError('Native class metadata is unavailable');
            return b === 'avatarSlot' ? Number(object.classNumber) === 26 ? 2 : 0 : copy((definition as unknown as WireFields)[b] ?? '');
        }
        if (name === 'redraw') {
            this.object(a);
            this.hidden.delete(Number(a));
            this.emit();
            return '';
        }
        if (name === 'remove') {
            this.object(a);
            this.hidden.add(Number(a));
            this.emit();
            return '';
        }
        if (name === 'reload') {
            await this.image(a);
            this.emit();
            return '';
        }
        if (name === 'balloon')
            return this.balloon(a, b, c);
        if (['speak_balloon', 'think_balloon', 'esp_balloon', 'info_balloon', 'system_balloon'].includes(name))
            return this.balloon(a, b, ['speak_balloon', 'think_balloon', 'esp_balloon', 'info_balloon', 'system_balloon'].indexOf(name));
        if (name === 'eraseQuip')
            return this.eraseQuip();
        if (name === 'moveQuip') {
            this.object(a);
            return '';
        }
        if (name === 'playSound') {
            const sound = integer(b ?? a, 0, 65535, 'sound');
            if (sound > 0 && sound < 65535)
                Promise.resolve(this.audio?.play(sound)).catch((error: any) => this.onError?.(error));
            return '';
        }
        if (name === 'delay')
            return this.sleep(a, this.generation, { taskId: context.taskId ?? null });
        if (name === 'waitBits' || name === 'waitFor')
            return this.waitBits(a, b, c);
        if (name === 'chore-load')
            return this.storeChore(await this.loadChore(a, b, c));
        if (name === 'chore-copy')
            return this.storeChore(this.handle(a));
        if (name === 'chore-free') {
            this.handle(a);
            this.choreHandles.delete(String(a));
            return '';
        }
        if (name === 'chore-cat') {
            if (!args.length)
                throw new TclHostError('At least one chore is required');
            const all = args.map((value) => this.handle(value)), last = all.at(-1)!;
            return this.storeChore({ ...last, commands: all.flatMap((item) => copy(item.commands)) });
        }
        if (name === 'chore-queue') {
            const chore = this.choreHandles.has(String(a)) ? this.handle(a) : await this.loadChore(a, b, c);
            return this.queueChore(b, chore, context);
        }
        if (name === 'chore-clear')
            return this.clearChores(a);
        if (['chore-name', 'chore-endstate', 'chore-endchore'].includes(name)) {
            const chore = this.handle(a), key = ({ 'chore-name': 'name', 'chore-endstate': 'endState', 'chore-endchore': 'endChore' } as const)[name as 'chore-name' | 'chore-endstate' | 'chore-endchore'];
            if (args.length > 1)
                chore[key] = text(b, 64);
            return chore[key];
        }
        if (name === 'chore-step') {
            const chore = this.handle(a), step = chore.commands[integer(b, 0, chore.commands.length - 1, 'chore step')];
            return [step.type, step.state, step.dx, step.dy, step.dz];
        }
        if (name === 'chore-set') {
            const chore = this.handle(a), index = integer(b, 0, chore.commands.length - 1, 'chore step'), step = list(c);
            if (step.length !== 5)
                throw new TclHostError('A native chore step needs five integers');
            const values = step.map((v, i) => integer(v, i < 2 ? 0 : -32768, i < 2 ? 65535 : 32767, 'chore step value'));
            chore.commands[index] = Object.fromEntries(['type', 'state', 'dx', 'dy', 'dz'].map((key, i) => [key, values[i]])) as unknown as NativeChoreCommand;
            return '';
        }
        if (name === 'chore-state-index') {
            const image = await this.image(b);
            return this.stateIndex(image, a);
        }
        if (name === 'chore-state') {
            const image = await this.image(a);
            if (context.taskId !== undefined && this.cancelledTasks.has(String(context.taskId)))
                throw new TclHostCancelledError();
            if (args.length > 1) {
                const index = this.stateIndex(image, b);
                const defaults = image.choreography(['default'], index);
                this.settleChoreState(a, index, defaults);
            }
            return image.namedStates[Number(this.getObject(a, 'choreState')) || 0]?.name ?? 'default';
        }
        if (name === 'chore-info' || name === 'chore-index') {
            const chore = await this.loadChore(a, b, c);
            return name === 'chore-index' ? chore.index : [chore.name, chore.endState, chore.commands.length];
        }
        if (name === 'dialogCreate')
            return this.createDialog(a, b, c, d ?? 'standard', context);
        if (name === 'dialogMake' || name === 'dialogShow') {
            const item = this.dialog(a);
            item[name === 'dialogMake' ? 'made' : 'visible'] = true;
            this.emitDialog(a);
            return '';
        }
        if (name === 'dialogKill') {
            this.dialog(a);
            this.dialogs.delete(String(a));
            this.onDialog?.({ id: String(a), closed: true });
            return '';
        }
        if (name === 'dialogGetValue') {
            const control = this.control(a, b);
            return control.type === 'list' ? control.selected : copy(control.value);
        }
        if (name === 'dialogSetValue') {
            const control = this.control(a, b);
            control.value = ['checkbox', 'radio'].includes(control.type) ? integer(c, 0, 1, 'checkbox') : text(c, control.maxLength);
            if (control.type === 'radio' && Number(control.value) === 1)
                for (const peer of this.dialog(a).controls)
                    if (peer.type === 'radio' && peer.group === control.group && peer.id !== control.id)
                        peer.value = 0;
            if (['combo', 'editcombo'].includes(control.type))
                control.selected = control.items.findIndex((item: any) => item.text === String(control.value));
            if (['button', 'defaultButton', 'escapeButton', 'static', 'group'].includes(control.type))
                control.text = String(control.value);
            this.emitDialog(a);
            return '';
        }
        const types: Record<string, string> = { ctrlButton: 'button', ctrlDefButton: 'defaultButton', ctrlEscButton: 'escapeButton', ctrlCheckBox: 'checkbox', ctrlRadioButton: 'radio', ctrlGroupBox: 'group', ctrlLineEdit: 'input', ctrlTextEdit: 'textarea', ctrlStaticText: 'static', ctrlListBox: 'list', ctrlComboBox: 'combo', ctrlEditCombo: 'editcombo', ctrlGraphic: 'graphic' };
        if (types[name])
            return this.createControl(types[name], args, context);
        if (['ctrlEnable', 'ctrlDisable', 'ctrlShow', 'ctrlHide'].includes(name)) {
            const control = this.control(a, b);
            control[name === 'ctrlEnable' || name === 'ctrlDisable' ? 'enabled' : 'visible'] = name === 'ctrlEnable' || name === 'ctrlShow';
            this.emitDialog(a);
            return '';
        }
        if (name === 'ctrlSetMaxTextLength') {
            const control = this.control(a, b);
            control.maxLength = integer(c, 0, 262144, 'control text limit');
            control.value = String(control.value).slice(0, control.maxLength);
            this.emitDialog(a);
            return '';
        }
        if (name === 'ctrlAddListItem') {
            const control = this.control(a, b);
            if (!['list', 'combo', 'editcombo'].includes(control.type) || control.items.length >= 4096)
                throw new TclHostError('Invalid or excessive native list items');
            const item = { id: integer(c, 0, 65535, 'native list item number'), text: text(d), enabled: true, callback: this.callback(args.slice(4)) };
            control.items.push(item);
            this.emitDialog(a);
            return control.items.length - 1;
        }
        if (name === 'ctrlDelListItem') {
            const control = this.control(a, b), index = integer(c, 0, control.items.length - 1, 'list item');
            control.items.splice(index, 1);
            if (control.selected >= control.items.length)
                control.selected = control.items.length - 1;
            if (['combo', 'editcombo'].includes(control.type))
                control.value = control.items[control.selected]?.text ?? '';
            this.emitDialog(a);
            return '';
        }
        if (name === 'ctrlGetListCount')
            return this.control(a, b).items.length;
        if (name === 'ctrlGetListItemName') {
            const control = this.control(a, b);
            return control.items[integer(c, 0, control.items.length - 1, 'list item')].text;
        }
        if (name === 'ctrlSelectListItem') {
            const control = this.control(a, b);
            control.selected = integer(c, -1, control.items.length - 1, 'list selection');
            if (['combo', 'editcombo'].includes(control.type))
                control.value = control.items[control.selected]?.text ?? '';
            this.emitDialog(a);
            return '';
        }
        if (name === 'ctrlGetSelectedListItem')
            return this.control(a, b).selected;
        if (name === 'ctrlSetListColumns') {
            const control = this.control(a, b);
            control.columns = (args.length === 3 ? list(c) : args.slice(2)).map((value) => integer(value, 0, 4096, 'list column'));
            this.emitDialog(a);
            return '';
        }
        if (name === 'ctrlSetPasswordEdit') {
            this.control(a, b).password = true;
            this.emitDialog(a);
            return '';
        }
        if (['ctrlEnableListItem', 'ctrlDisableListItem', 'ctrlIsListItemEnabled'].includes(name)) {
            const control = this.control(a, b), item = control.items[integer(c, 0, control.items.length - 1, 'list item')];
            if (name === 'ctrlIsListItemEnabled')
                return Number(item.enabled);
            item.enabled = name === 'ctrlEnableListItem';
            this.emitDialog(a);
            return '';
        }
        throw new TclHostError(`Unsupported native browser binding: ${name}`);
    }
    // Advance generation before rejecting pending work; its continuations must
    // observe the reset even if cancellation settles their promises immediately.
    reset() { this.generation++; for (const job of this.choreJobs)
        this.cancelChore(job); this.choreJobs.clear(); this.cancelledTasks.clear(); for (const item of this.timers) {
        this.clearTimer(item.timer ?? undefined);
        item.reject(new TclHostCancelledError());
    } this.timers.clear(); this.overlays.clear(); this.hidden.clear(); this.choreHandles.clear(); this.queues.clear(); this.images.clear(); this.graphics.clear(); this.requests.destroy(); this.requests = new AssetRequestQueue(3); for (const id of this.dialogs.keys())
        this.onDialog?.({ id, closed: true }); this.dialogs.clear(); this.balloonNoid = null; this.emit(); }
    destroy() { if (this.destroyed)
        return; this.reset(); this.requests.destroy(); this.destroyed = true; }
}
export const createTclVisualHost = (options: TclVisualHostOptions) => new TclVisualHost(options);
