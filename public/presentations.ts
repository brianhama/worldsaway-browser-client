export interface BannerAd {
    imageURL: string;
    choreState: number;
    colorMap: number[];
    presentationLabel: string;
    URLlabel: string;
    link: string;
}
export interface PresentationCommand {
    at: number;
    op: string;
    patch: WireFields;
}
/** Parsed literal commands use cumulative millisecond offsets, not executable source. */
export interface PresentationProgram {
    commands: PresentationCommand[];
    unsupported: string[];
    duration: number;
}
interface PresentationState extends WireFields {
    patch: WireFields;
    ads?: BannerAd[];
    program?: PresentationProgram | null;
}
export interface BannerOptions {
    api?: ApiRequest;
    getState?: StateProvider;
    onChange?: () => void;
    onMessage?: (message: string) => void;
    runTcl?: (noid: number, which: number, context: WireFields) => Promise<{
        taskId: string;
    }>;
    now?: () => number;
    effectTimeout?: number;
}
import type { WireFields, WorldState, WorldObject, RuntimeEvent, ActionRequest, ApiRequest, StateProvider, PendingReply } from './types.js';
/** Literal browser equivalents of Banner library000c0071's presentation helpers.
 * This parser accepts data and a small named visual-command vocabulary. It does
 * not evaluate Tcl, substitutions, expressions, JavaScript or server source.
 */
export function parseBannerAds(text: unknown) {
    if (typeof text !== 'string' || text.length > 262144)
        throw new Error('Invalid banner advertisement data');
    if (!text)
        return [];
    const fields = text.split('|');
    if (fields.at(-1) === '' && (fields.length - 1) % 6 === 0)
        fields.pop();
    if (fields.length % 6)
        throw new Error('Banner advertisements need six fields per entry');
    if (fields.length > 6000)
        throw new Error('Too many banner advertisements');
    const ads: BannerAd[] = [];
    for (let i = 0; i < fields.length; i += 6) {
        const state = Number(fields[i + 1]), colors = fields[i + 2].replace(/[{}]/g, '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
        if (!Number.isInteger(state) || state < 0 || state > 65535 || colors.length !== 16 || colors.some((c) => !Number.isInteger(c) || c < 0 || c > 255))
            throw new Error('Invalid banner image state or color map');
        const name = fields[i];
        if (name.length > 63 || /[\\/:\0]/.test(name))
            throw new Error('Invalid banner image filename');
        ads.push({ imageURL: name, choreState: state, colorMap: colors, presentationLabel: fields[i + 3], URLlabel: fields[i + 4], link: fields[i + 5] });
    }
    return ads;
}
/** Split the supported literal word grammar without performing Tcl substitutions. */
export function literalWords(line: string) {
    const words: string[] = [];
    let i = 0;
    while (i < line.length) {
        while (/\s/.test(line[i] ?? '') && i < line.length)
            i++;
        if (i >= line.length)
            break;
        let value = '', brace = 0, quoted = false;
        if (line[i] === '{') {
            brace = 1;
            i++;
            while (i < line.length && brace) {
                const c = line[i++];
                if (c === '{') {
                    brace++;
                    if (brace > 1)
                        value += c;
                }
                else if (c === '}') {
                    brace--;
                    if (brace)
                        value += c;
                }
                else
                    value += c;
            }
            if (brace)
                throw new Error('Unbalanced literal braces');
        }
        else if (line[i] === '"') {
            quoted = true;
            i++;
            while (i < line.length && line[i] !== '"')
                value += line[i++];
            if (i === line.length)
                throw new Error('Unbalanced literal quote');
            i++;
        }
        else {
            while (i < line.length && !/\s/.test(line[i]))
                value += line[i++];
        }
        if (i < line.length && !/\s/.test(line[i]))
            throw new Error('Unsupported compound Tcl word');
        // Substitution is never executed, including inside quoted/braced strings.
        words.push(value);
        if (words.length > 16)
            throw new Error('Too many presentation parameters');
    }
    return words;
}
const number = (text: unknown, min: number = -32768, max: number = 32767) => { const value = Number(text); if (!Number.isInteger(value) || value < min || value > max)
    throw new Error('Invalid presentation number'); return value; };
export function parsePresentation(text: unknown) {
    if (typeof text !== 'string' || text.length > 262144)
        throw new Error('Invalid presentation text');
    const lines = text.split(/\r?\n/);
    if (lines.length > 1000)
        throw new Error('Too many presentation lines');
    let at = 0;
    const commands: PresentationCommand[] = [], unsupported: string[] = [];
    for (const line of lines) {
        if (!line.trim())
            continue;
        const match = /^\s*(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
        if (!match) {
            unsupported.push(line);
            continue;
        }
        const delay = Number(match[1]);
        if (delay > 3600)
            throw new Error('Presentation delay exceeds one hour');
        at += delay * 1000;
        if (at > 24 * 3600000)
            throw new Error('Presentation duration exceeds one day');
        try {
            const [op, ...args] = literalWords(match[2]);
            let patch: WireFields;
            if (op === 'psay' && args.length === 1)
                patch = { speech: args[0] };
            else if (op === 'pimage' && args.length >= 1 && args.length <= 2) {
                if (/^\d+$/.test(args[0]))
                    patch = { choreState: number(args[0], 0, 65535) };
                else {
                    if (args[0].length > 63 || /[\\/:\0]/.test(args[0]))
                        throw new Error('Invalid image filename');
                    patch = { imageURL: args[0], choreState: number(args[1] ?? 0, 0, 65535) };
                }
            }
            else if (op === 'panim' && args.length === 1)
                patch = { gesture: args[0] };
            else if (op === 'pturn' && args.length === 1)
                patch = { orientation: number(args[0], 0, 3) };
            else if (op === 'pmove' && (args.length === 1 || args.length >= 2 && args.length <= 3)) {
                const coords = args.length === 1 ? args[0].split(/\s+/) : args;
                if (coords.length < 2 || coords.length > 3)
                    throw new Error('Invalid presentation position');
                patch = { position: [number(coords[0]), number(coords[1]), number(coords[2] ?? 0)] };
            }
            else if (['pmoveAvatar', 'pmoveAdjacent'].includes(op) && ((op === 'pmoveAdjacent' && args.length === 0) || args.length >= 1 && args.length <= 3)) {
                const coords = args.length === 0 ? ['0', '0', '0'] : args.length === 1 ? args[0].trim().split(/\s+/) : args;
                if (coords.length < 2 || coords.length > 3)
                    throw new Error('Invalid avatar presentation position');
                patch = { effect: { kind: op === 'pmoveAdjacent' ? 'moveAdjacent' : 'moveActor', coords: [number(coords[0]), number(coords[1]), number(coords[2] ?? 0)] } };
            }
            else if (op === 'pturnAvatar' && args.length === 1)
                patch = { effect: { kind: 'turnActor', direction: number(args[0], 0, 3) } };
            else if (op === 'preward' && args.length <= 1) {
                const slot = args.length ? number(args[0], -1, 65535) : -1;
                if (slot === 0)
                    throw new Error('Reward slots start at one');
                patch = { effect: { kind: 'reward', slot } };
            }
            else if (op === 'pURL' && args.length === 1)
                patch = { link: args[0] };
            else {
                unsupported.push(match[2]);
                continue;
            }
            commands.push({ at, op, patch });
        }
        catch {
            unsupported.push(match[2]);
        }
    }
    return { commands, unsupported, duration: at };
}
const lastSeq = (state: WorldState) => Math.max(0, ...(state?.history ?? []).map((event: RuntimeEvent) => Number(event.seq) || 0));
const cloneFields = (fields: WireFields) => Object.fromEntries(['imageURL', 'imageVersion', 'choreState', 'position', 'orientation', 'mood', 'colorMap'].filter((key: string) => fields?.[key] !== undefined).map((key: string) => [key, Array.isArray(fields[key]) ? [...fields[key]] : fields[key]]));
/** Coordinate advertisement rotation with either real Tcl or the limited literal player.
 * Display patches are projections; movement and rewards still require world replies. */
export class BannerPresentations {
    api!: ApiRequest | undefined;
    getState!: StateProvider;
    onChange!: (() => void) | undefined;
    onMessage!: ((message: string) => void) | undefined;
    runTcl!: BannerOptions['runTcl'];
    now!: () => number;
    effectTimeout!: number;
    items!: Map<number, PresentationState>;
    requests!: Map<number, WireFields>;
    requestQueues!: Map<number, WireFields[]>;
    waiters!: PendingReply[];
    seq!: number;
    worldKey!: string;
    destroyed!: boolean;
    timer!: ReturnType<typeof setInterval>;
    state!: WorldState | undefined;
    constructor({ api, getState, onChange, onMessage, runTcl, now = () => Date.now(), effectTimeout = 15000 }: BannerOptions = {}) {
        this.api = api;
        this.getState = getState ?? (() => this.state ?? {});
        this.onChange = onChange;
        this.onMessage = onMessage;
        this.runTcl = runTcl;
        this.now = now;
        this.effectTimeout = effectTimeout;
        this.items = new Map();
        this.requests = new Map();
        this.requestQueues = new Map();
        this.waiters = [];
        this.seq = 0;
        this.worldKey = '';
        this.destroyed = false;
        this.timer = setInterval(() => this.tick(), 250);
    }
    cancelWaiters(reason: string = 'Presentation ended') { for (const waiter of this.waiters) {
        clearTimeout(waiter.timer!);
        waiter.reject(new Error(reason));
    } this.waiters = []; }
    ingestState(state: WorldState) {
        this.state = state;
        const key = `${state.status === 'connected' ? state.worldName : ''}:${state.avatar ?? ''}:${state.region?.fields?.name ?? ''}`;
        if (key !== this.worldKey) {
            this.cancelWaiters();
            this.items.clear();
            this.requests.clear();
            this.requestQueues.clear();
            if (lastSeq(state) < this.seq)
                this.seq = 0;
            this.worldKey = key;
        }
        const banners = (state.objects ?? []).filter((object: WorldObject) => object.classNumber === 61), valid = new Set(banners.map((object: WorldObject) => Number(object.noid)));
        for (const id of this.items.keys())
            if (!valid.has(id))
                this.items.delete(id);
        for (const event of state.history ?? []) {
            if (Number(event.seq) <= this.seq)
                continue;
            this.seq = Number(event.seq);
            const fields = event.fields ?? {};
            if (event.type === 'request' && Number(event.id) === 5605) {
                const id = Number(event.noid);
                this.requests.set(id, fields);
                const queue = this.requestQueues.get(id) ?? [];
                queue.push(fields);
                if (queue.length > 64)
                    queue.shift();
                this.requestQueues.set(id, queue);
            }
            if (event.type === 'message') {
                const waiter = this.waiters.find((waiter) => waiter.replyId === Number(event.id) && Number(event.seq) > waiter.after && (Number(event.noid) === waiter.noid || Number(event.noid) === 0 && Number(event.id) === 70) && (event.requestId === undefined || Number(event.requestId) === waiter.id));
                if (waiter) {
                    this.waiters.splice(this.waiters.indexOf(waiter), 1);
                    clearTimeout(waiter.timer!);
                    Number(fields.success ?? 0) === 0 ? waiter.resolve(fields) : waiter.reject(new Error(fields.fail_msg || `Presentation operation declined (${fields.success})`));
                }
            }
            if (event.type === 'message' && Number(event.id) === 5606) {
                const id = Number(event.noid), request = this.requestQueues.get(id)?.shift() ?? this.requests.get(id), object = banners.find((object: WorldObject) => Number(object.noid) === id), item = this.items.get(id);
                if (!object)
                    continue;
                if (Number(fields.success) !== 0) {
                    if (item) {
                        item.programLoading = false;
                        item.loading = false;
                    }
                    this.onMessage?.(fields.fail_msg || 'The world declined the presentation request.');
                    continue;
                }
                try {
                    if (Number(request?.format ?? 0) === 0) {
                        const ads = parseBannerAds(fields.text);
                        if (!ads.length)
                            continue;
                        this.items.set(id, { ...item, loading: false, ads, index: Math.max(0, Math.min(ads.length - 1, Number(fields.currentAd) || 0)), rotation: (item?.rotation ?? -1) + 1, next: this.now() + (Number(fields.timeLeft) || Number(object.fields.interval) || 30) * 1000, interval: Math.max(1, Number(object.fields.interval) || 30) * 1000, patch: item?.program ? item.patch : {} });
                    }
                    else if (Number(request?.format) === 2) {
                        const program = parsePresentation(fields.text), base = item ?? { patch: {}, index: 0, rotation: 0 };
                        const ad = base.ads?.[base.index] ?? {}, savedFields = cloneFields({ ...object.fields, ...ad });
                        this.items.set(id, { ...base, program, programLoading: false, which: Number(request!.which) || base.index + 1, started: this.now(), shift: 0, step: 0, patch: {}, savedFields, baseAd: { ...ad }, restorePatch: null, pendingEffect: null, token: {} });
                        if (program.unsupported.length)
                            this.onMessage?.(`${program.unsupported.length} presentation commands are unsupported. Literal visual, avatar movement, turning and reward commands will play; other Tcl remains inert.`);
                    }
                }
                catch (error: any) {
                    if (item)
                        item.programLoading = false;
                    this.onMessage?.(error.message);
                }
            }
        }
        if (state.status === 'connected')
            for (const object of banners)
                if ((Number(object.fields.banner_flags) & 1) && Number(object.fields.interval) > 0 && !this.items.has(Number(object.noid))) {
                    const id = Number(object.noid);
                    this.items.set(id, { loading: true, patch: {}, rotation: 0 });
                    this.requests.set(id, { which: 0, format: 0 });
                    Promise.resolve(this.api!('/api/action', { noid: id, id: 5605, fields: { which: 0, format: 0 } })).catch((error: any) => { this.items.set(id, { error: error.message, patch: {} }); this.onMessage?.(error.message); });
                }
        this.tick();
    }
    action(noid: number, id: number, fields: WireFields, replyId: number) {
        const after = lastSeq(this.getState());
        return new Promise<WireFields>((resolve, reject) => {
            const waiter: PendingReply = { noid: Number(noid), id, replyId, after, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter((item: ActionRequest) => item !== waiter); reject(new Error('Presentation operation did not receive a world acknowledgement')); }, this.effectTimeout);
            (waiter.timer as {
                unref?: () => void;
            }).unref?.();
            this.waiters.push(waiter);
            Promise.resolve(this.api!('/api/action', { noid: Number(noid), id, fields })).catch((error: any) => { clearTimeout(waiter.timer!); this.waiters = this.waiters.filter((item: ActionRequest) => item !== waiter); reject(error); });
        });
    }
    async performEffect(noid: number, item: PresentationState, effect: WireFields) {
        const state = this.getState(), actor = state.objects?.find((object: WorldObject) => Number(object.noid) === Number(state.actorNoid));
        if (effect.kind === 'reward') {
            const which = effect.slot === -1 ? item.which : effect.slot;
            if (!Number.isInteger(which) || which < 1 || which > 65535)
                throw new Error('Presentation reward slot must start at one');
            const held = state.objects?.find((object: WorldObject) => Number(object.fields.container_noid) === Number(state.actorNoid) && Number(object.fields.position?.[0]) === 0);
            if (held)
                throw new Error('Free your hand before receiving a presentation reward.');
            await this.action(noid, 5675, { slot: which - 1 }, 80);
            return;
        }
        if (!actor || state.status !== 'connected')
            throw new Error('An active avatar is required for this presentation command');
        const seat = state.objects?.find((object: WorldObject) => Number(object.noid) === Number(actor.fields.container_noid) && object.classNumber === 53);
        if (effect.kind === 'turnActor') {
            if (seat)
                throw new Error('Stand before changing your orientation.');
            const difference = ({ 1: -1, 2: 1, 3: 2 } as Record<number, number>)[effect.direction] ?? 0, facing = ((Number(actor.fields.orientation) || 0) + difference + 4) % 4;
            await this.action(actor.noid, 1688, { facing }, 70);
            return;
        }
        if (seat)
            await this.action(seat.noid, 2405, { unused: 0 }, 2406);
        let coords = [...effect.coords];
        if (effect.kind === 'moveAdjacent') {
            const banner = this.displayState(this.getState()).objects?.find((object: WorldObject) => Number(object.noid) === Number(noid));
            coords = coords.map((value: any, index: any) => value + Number(banner?.fields.position?.[index] ?? 0));
            if (coords.some((value: any) => !Number.isInteger(value) || value < -32768 || value > 32767))
                throw new Error('Presentation destination exceeds native coordinate limits');
        }
        await this.action(actor.noid, 1570, { coords }, 1571);
    }
    maybeAutostart(noid: number, item: PresentationState) {
        if (!item.ads || item.program || item.programLoading || item.nativeTask || item.autoRequestedFor === item.rotation)
            return;
        const object = this.getState().objects?.find((object: WorldObject) => Number(object.noid) === Number(noid));
        if (!object || (Number(object.fields.banner_flags) & 1) === 0)
            return;
        const mask = Number(object.fields.presentationAutostart) || 0;
        if (item.index >= 16 || (mask & (1 << item.index)) === 0)
            return;
        item.autoRequestedFor = item.rotation;
        this.start(noid, item.index + 1).catch((error: any) => this.onMessage?.(error.message));
    }
    tick() {
        if (this.destroyed)
            return;
        let changed = false;
        const now = this.now();
        for (const [id, item] of this.items) {
            if (item.nativeTask) {
                const task = this.getState().tcl?.tasks?.find((task: any) => task.id === item.nativeTask);
                if (task && task.status !== 'running') {
                    item.nativeTask = null;
                    item.next = now + item.interval;
                }
                else
                    continue;
            }
            if (item.programLoading && now - item.loadStarted > this.effectTimeout) {
                item.programLoading = false;
                this.onMessage?.('The banner presentation did not load.');
            }
            if (item.program) {
                while (!item.pendingEffect && item.step < item.program.commands.length && now - item.started - item.shift >= item.program.commands[item.step].at) {
                    const command = item.program.commands[item.step++], { effect, ...patch } = command.patch;
                    Object.assign(item.patch, patch);
                    if (patch.gesture)
                        item.patch.gestureSeq = now;
                    if (patch.speech)
                        item.patch.presentationSpeech = { text: patch.speech, until: now + 5000 };
                    changed = true;
                    if (effect) {
                        // Stop advancing this timeline during an acknowledged world
                        // effect, then shift subsequent commands by the actual wait.
                        const began = this.now(), token = item.token;
                        item.pendingEffect = this.performEffect(id, item, effect).catch((error: any) => { if (!this.destroyed && this.items.get(id) === item && item.token === token)
                            this.onMessage?.(error.message); }).finally(() => { if (this.items.get(id) === item && item.token === token) {
                            item.shift += Math.max(0, this.now() - began);
                            item.pendingEffect = null;
                            this.onChange?.();
                        } });
                    }
                }
                if (!item.pendingEffect && item.step >= item.program.commands.length && now - item.started - item.shift > item.program.duration + 1100) {
                    item.program = null;
                    item.patch = {};
                    item.restorePatch = { ...item.savedFields };
                    item.next = now + item.interval;
                    changed = true;
                }
            }
            else if (!item.programLoading && item.ads && now >= item.next) {
                const steps = Math.floor((now - item.next) / item.interval) + 1;
                item.index = (item.index + steps) % item.ads.length;
                item.rotation = (item.rotation ?? 0) + steps;
                item.next += steps * item.interval;
                item.restorePatch = null;
                changed = true;
            }
            this.maybeAutostart(id, item);
        }
        if (changed)
            this.onChange?.();
    }
    async start(noid: number, which?: unknown) {
        noid = Number(noid);
        const current = this.items.get(noid), number = Number(which ?? ((current?.index ?? 0) + 1));
        if (!Number.isInteger(number) || number < 1 || number > 65535)
            throw new Error('Invalid presentation number');
        if (current?.programLoading)
            return;
        const item = current ?? { patch: {}, index: number - 1, rotation: 0, interval: Math.max(1, Number(this.getState().objects?.find((object: WorldObject) => Number(object.noid) === noid)?.fields?.interval) || 30) * 1000 };
        item.programLoading = true;
        item.autoRequestedFor = item.rotation;
        item.loadStarted = this.now();
        this.items.set(noid, item);
        this.requests.set(noid, { which: number, format: 2 });
        // Prefer the real interpreter when available; the literal player is a
        // compatibility fallback rather than a general Tcl implementation.
        if (this.runTcl && this.getState().tcl?.enabled) {
            try {
                const result = await this.runTcl(noid, number, this.current(noid));
                item.nativeTask = result.taskId;
                item.programLoading = false;
                return result;
            }
            catch (error: any) {
                item.programLoading = false;
                throw error;
            }
        }
        try {
            return await this.api!('/api/action', { noid, id: 5605, fields: { which: number, format: 2 } });
        }
        catch (error: any) {
            item.programLoading = false;
            throw error;
        }
    }
    /** Overlay visual presentation fields without mutating authoritative objects. */
    displayState(state: WorldState) { const objects = (state.objects ?? []).map((object: WorldObject) => { const item = this.items.get(Number(object.noid)); if (!item)
        return object; const ad = item.program ? item.baseAd : item.ads?.[item.index] ?? {}, patch = { ...ad, ...(item.program ? item.savedFields : item.restorePatch), ...item.patch }; return { ...object, fields: { ...object.fields, ...patch } }; }); return { ...state, objects, region: objects.find((object: WorldObject) => object.noid === 0) ?? state.region }; }
    current(noid: number) { const item = this.items.get(Number(noid)); return { ...(item?.program ? item.baseAd : item?.ads?.[item?.index]), ...item?.patch }; }
    destroy() { this.destroyed = true; clearInterval(this.timer); this.cancelWaiters(); this.items.clear(); }
}
