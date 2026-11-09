import type { WireFields, WorldState, WorldObject, RuntimeEvent, ActionRequest, ApiRequest, StateProvider, ControllerOptions, PendingReply } from './types.js';
/** Data-only equivalent of native walkAdjacentToObject/getWalkCoords/adjacent.
 * Source: 000c0003.tcl:52-135, 00050037.tcl (command60), and
 * 00050001.tcl getOuterContainer/objectIsInContainer. Absolute-Y conversion:
 * wa32 FUN_00446b60: (yprime << 9) / horizon, signed division toward zero. */
export class ApproachError extends Error {
    declare name: string;
    constructor(message: string) { super(message); this.name = 'ApproachError'; }
}
export class ApproachCancelledError extends ApproachError {
    declare name: string;
    silent!: boolean;
    constructor(message = 'The pending object action was cancelled.') { super(message); this.name = 'ApproachCancelledError'; this.silent = true; }
}
const f = (object: WorldObject | null | undefined) => object?.fields ?? object ?? {};
const oid = (object: WorldObject | null | undefined) => Number(object?.noid ?? f(object).noid);
const klass = (object: WorldObject | null | undefined) => Number(object?.classNumber ?? f(object).classNumber);
const parent = (object: WorldObject | null | undefined) => Number(f(object).container_noid ?? 0);
const lookup = (state: WorldState, noid: unknown) => (state.objects ?? []).find((object: WorldObject) => oid(object) === Number(noid));
const actorOf = (state: WorldState) => state.actorNoid === null || state.actorNoid === undefined ? null : lookup(state, state.actorNoid);
const lastSequence = (state: WorldState) => Math.max(0, ...(state.history ?? []).map((event: RuntimeEvent) => Number(event.seq) || 0));
const regionKey = (state: WorldState) => { const region = state.region ?? lookup(state, 0), fields = f(region); return `${state.worldName ?? ''}|${state.avatar ?? ''}|${fields.name ?? ''}|${fields.imageURL ?? ''}|${fields.areaCode ?? ''}`; };
function position(object: WorldObject | null | undefined) { const point = f(object).position; if (!Array.isArray(point) || point.length !== 3 || point.some((value: any) => !Number.isSafeInteger(Number(value))))
    throw new ApproachError('This object has no valid native walking position.'); return point.map(Number); }
function acknowledgedPosition(point: unknown) { if (!Array.isArray(point) || point.length !== 3 || point.some((value: any) => !Number.isSafeInteger(Number(value)) || Number(value) < -32768 || Number(value) > 32767))
    throw new ApproachError('The world returned no valid walking destination.'); return point.map(Number); }
/** Convert native absolute-Y depth with signed truncation, not screen rounding. */
export function nativeDepth(horizon: unknown, yprime: unknown) {
    const divisor = Number(horizon) || 70, value = Number(yprime);
    if (!Number.isSafeInteger(divisor) || divisor <= 0 || !Number.isSafeInteger(value))
        throw new ApproachError('Invalid native scene projection.');
    return Math.trunc(value * 512 / divisor);
}
export function isInNativeContainer(object: WorldObject | null | undefined, container: WorldObject | null | undefined, state: WorldState) {
    if (!object || !container || oid(object) === 0)
        return false;
    const target = oid(container), seen = new Set();
    let current: WorldObject | null | undefined = object;
    while (parent(current) !== 0) {
        const next = parent(current);
        if (next === target)
            return true;
        if (seen.has(next))
            throw new ApproachError('The object containment chain contains a cycle.');
        seen.add(next);
        current = lookup(state, next);
        if (!current)
            return false;
    }
    return false;
}
/** Resolve the scene-level owner whose coordinates apply to a nested object.
 * Missing ancestors and cycles must not produce a guessed walking destination. */
export function nativeOuterContainer(object: WorldObject | null | undefined, state: WorldState) {
    if (!object)
        return null;
    const seen = new Set();
    let current: WorldObject | null | undefined = object;
    while (parent(current) !== 0) {
        const next = parent(current);
        if (seen.has(next))
            throw new ApproachError('The object containment chain contains a cycle.');
        seen.add(next);
        current = lookup(state, next);
        if (!current)
            throw new ApproachError('The object is not fully available in this region.');
    }
    return current;
}
export function nativeWalkCoordinates(object: WorldObject | null | undefined, state: WorldState) {
    const outer = nativeOuterContainer(object, state);
    if (!outer)
        throw new ApproachError('The object is not visible in this region.');
    const coordinates = position(outer);
    if (Number(f(outer).common_flags ?? 0) & 4) {
        const region = state.region ?? lookup(state, 0);
        coordinates[1] = nativeDepth(f(region).horizon, coordinates[1]);
        coordinates[2] = 0;
    }
    if (coordinates.some((value) => value < -32768 || value > 32767))
        throw new ApproachError('The object walking position exceeds the native coordinate range.');
    return coordinates;
}
function walkingActor(state: WorldState) {
    const actor = actorOf(state);
    if (state.status !== 'connected')
        throw new ApproachError('Enter the world before walking.');
    if (!actor || klass(actor) !== 21 || oid(actor) === 15)
        throw new ApproachError('Materialize from the Avatar tab to walk.');
    if (Number(state.tcl?.blockCount) > 0)
        throw new ApproachError('The world is finishing another action.');
    if (state.permissions?.flags !== undefined && !(Number(state.permissions.flags) & 524288))
        throw new ApproachError('Your avatar cannot walk to this object.');
    return actor;
}
/** A scene click supplies native floor coordinates independently of the object
 * under the pointer. Preserve that destination when its menu is activated. */
export function nativeGroundWalkRequest(coords: readonly number[], state: WorldState) {
    const actor = walkingActor(state);
    if (!Array.isArray(coords) || coords.length !== 3 || [...coords].some(value => !Number.isSafeInteger(value) || value < -32768 || value > 32767) || coords[2] !== 0)
        throw new ApproachError('Choose a valid ground walking destination.');
    return { id: 1570, noid: oid(actor), fields: { coords: [...coords] } };
}
/** An explicit object walk uses the same destination as native object approach,
 * without issuing any of the object's verbs. Call with the latest scene state. */
export function nativeObjectWalkRequest(object: WorldObject | null | undefined, state: WorldState) {
    const actor = walkingActor(state);
    // Ghost depth 255 is a rendering sentinel, including for anything carried
    // by a Ghost. It cannot supply a physical walking destination.
    if (klass(nativeOuterContainer(object, state)) === 22)
        throw new ApproachError('This object has no physical walking position.');
    return { id: 1570, noid: oid(actor), fields: { coords: nativeWalkCoordinates(object, state) } };
}
export function nativeAdjacent(actor: WorldObject | null | undefined, object: WorldObject | null | undefined, state: WorldState, { actorPosition, standing = false }: {
    actorPosition?: number[];
    standing?: boolean;
} = {}) {
    if (!actor || !object)
        return false;
    if (oid(actor) === oid(object) || isInNativeContainer(object, actor, state))
        return true;
    if (!standing && klass(lookup(state, parent(actor))) === 53)
        return false;
    const a = actorPosition ?? position(actor), b = nativeWalkCoordinates(object, state);
    return Math.abs(b[0] - a[0]) <= 5 && Math.abs(b[1] - a[1]) <= 10 && Math.abs(b[2] - a[2]) <= 10;
}
// These are numeric requests whose recovered class wrappers explicitly call
// walkAdjacentToObject. Deliberately exclude generic staff/property requests,
// chat/ESP, gestures, inventory-local operations, and machine settings that only
// share a Tcl file with a nearby stock/unload operation.
const SELF_TARGET_IDS = [93, 1591, 300, 337, 2401, 2561, 2565, 2671, 2675, 2678, 2682, 2720, 2737, 2740, 2747, 2791,
    2801, 2806, 2810, 2920, 2924, 3211, 3301, 3304, 3313, 4001, 4005, 4009, 4013, 4016, 4020,
    4151, 4303, 4311, 4353, 4357, 4361, 4403, 4453, 4457, 4501, 4505, 5101, 5302, 5678, 5682,
    9908, 20105, 20502, 20504, 20907, 21004, 21010, 21012, 21304, 21310, 21312];
export const NATIVE_APPROACH_REQUESTS = Object.freeze([...SELF_TARGET_IDS, 85, 1575, 1608, 1611, 2743, 2796, 5306, 5333].sort((a, b) => a - b));
const required = new Set(NATIVE_APPROACH_REQUESTS);
export function nativeApproachTargets(item: ActionRequest, state: WorldState) {
    if (!item)
        return [];
    if (item.command === 'document')
        return [Number(item.noid)];
    const id = Number(item.id ?? item.messageId), values = item.fields ?? item.values ?? {};
    if (!required.has(id))
        return [];
    if (id === 1575 || id === 1608 || id === 1611)
        return [Number(values.item)];
    if (id === 85)
        return Number(values.in_pocket) ? [] : [Number(values.container)];
    if (id === 2743)
        return [Number(values.src)];
    if (id === 2796)
        return [Number(values.src), Number(values.dest)];
    if (id === 5306 || id === 5333)
        return [Number(values.target)];
    return [Number(item.noid)];
}
/** Prepares an operation and RETURNS its item after approach succeeds. It only
 * sends stand/walk requests; the caller sends the final object operation after
 * awaiting perform(). This prevents a failed walk from spending or operating. */
export class ObjectApproach {
    api!: ApiRequest;
    getState!: StateProvider;
    onError!: ((error: any) => void) | undefined;
    timeout!: number;
    generation!: number;
    pending!: PendingReply | null;
    operation!: {
        generation: number;
        actor: number;
        region: string;
    } | null;
    destroyed!: boolean;
    constructor({ api, getState, stateProvider, onError, timeout = 15000 }: ControllerOptions = {}) {
        if (typeof api !== 'function')
            throw new TypeError('An action API is required');
        this.api = api;
        this.getState = getState ?? stateProvider ?? (() => ({}));
        this.onError = onError;
        this.timeout = timeout;
        this.generation = 0;
        this.pending = null;
        this.operation = null;
        this.destroyed = false;
    }
    /** Invalidate pending continuations as well as the currently awaited reply. */
    cancel(reason: string = 'The pending object action was cancelled.') {
        this.generation++;
        const pending = this.pending;
        this.pending = null;
        this.operation = null;
        if (pending) {
            clearTimeout(pending.timer!);
            pending.reject(new ApproachCancelledError(reason));
        }
    }
    ingestState(state: WorldState) {
        if (!this.operation)
            return;
        if (state.status !== 'connected') {
            this.cancel('The connection changed before the object action completed.');
            return;
        }
        if (regionKey(state) !== this.operation.region || Number(state.actorNoid) !== this.operation.actor) {
            this.cancel('You changed region or avatar before the object action completed.');
            return;
        }
        const pending = this.pending;
        if (!pending)
            return;
        for (const event of state.history ?? []) {
            if (event.type !== 'message' || Number(event.seq) <= pending.after || Number(event.noid) !== pending.noid)
                continue;
            if (Number(event.id ?? event.messageId) !== pending.replyId)
                continue;
            if (event.requestId !== undefined && Number(event.requestId) !== pending.id)
                continue;
            // An older outstanding walk may finish after a newer approach starts. Wait
            // for the HTTP result's issuing sequence before accepting a tagged reply.
            if (event.requestSeq !== undefined && (pending.requestSeq === null || pending.requestSeq !== undefined && Number(event.requestSeq) !== pending.requestSeq))
                continue;
            const fields = event.fields ?? event.values ?? {};
            clearTimeout(pending.timer!);
            this.pending = null;
            if (fields.success !== undefined && Number(fields.success) !== 0)
                pending.reject(new ApproachError(fields.fail_msg || `The world declined movement (code ${fields.success}).`));
            else
                pending.resolve(fields);
            break;
        }
    }
    async waitFor(id: number, noid: unknown, fields: WireFields, replyId: number, generation: number) {
        if (generation !== this.generation)
            throw new ApproachCancelledError();
        const after = lastSequence(this.getState());
        // Install the waiter before sending: SSE may deliver the acknowledgement
        // before the HTTP submission returns its issuing sequence.
        return new Promise<WireFields>((resolve, reject) => {
            const pending: PendingReply = { id, noid: Number(noid), replyId, after, requestSeq: null, resolve, reject, timer: null };
            pending.timer = setTimeout(() => { if (this.pending === pending)
                this.pending = null; reject(new ApproachError('The world did not acknowledge movement in time.')); }, this.timeout);
            this.pending = pending;
            Promise.resolve().then(() => { if (generation !== this.generation || this.pending !== pending)
                throw new ApproachCancelledError(); return this.api('/api/action', { noid: Number(noid), id, fields }); }).then((result: any) => { pending.requestSeq = Number.isSafeInteger(result?.seq) ? result.seq : undefined; this.ingestState(result?.state ?? this.getState()); }).catch((error: any) => { if (this.pending === pending) {
                clearTimeout(pending.timer!);
                this.pending = null;
                reject(error);
            } });
        });
    }
    async perform(item: ActionRequest) {
        if (this.destroyed)
            throw new ApproachCancelledError('The object approach controller is closed.');
        this.cancel();
        const generation = this.generation, state = this.getState(), actor = actorOf(state), refs = nativeApproachTargets(item, state), movement = [1570, 103].includes(Number(item.id ?? item.messageId));
        if (!refs.length && !movement || !actor || klass(actor) === 22 || Number(state.actorNoid) === 15)
            return item;
        if (state.status !== 'connected')
            throw new ApproachCancelledError('Enter the world before using this object.');
        // The native ground-walk (00050038) and exit (00050065) wrappers call
        // actorStand before their final request. The caller still owns that request;
        // this branch only waits for a seated actor's acknowledged 2405/2406 stand.
        if (movement) {
            const seat = lookup(state, parent(actor));
            if (klass(seat) !== 53)
                return item;
            this.operation = { generation, actor: Number(state.actorNoid), region: regionKey(state) };
            try {
                const result = await this.waitFor(2405, oid(seat), { unused: 0 }, 2406, generation);
                acknowledgedPosition(result.coords);
                const latest = this.getState();
                if (generation !== this.generation || latest.status !== 'connected' || Number(latest.actorNoid) !== this.operation?.actor || regionKey(latest) !== this.operation?.region)
                    throw new ApproachCancelledError();
                return item;
            }
            catch (error: any) {
                if (!(error instanceof ApproachCancelledError))
                    this.onError?.(error);
                throw error;
            }
            finally {
                if (this.operation?.generation === generation)
                    this.operation = null;
            }
        }
        const candidates = refs.map((id: number) => lookup(state, id)).filter((object): object is WorldObject => Boolean(object && oid(object) > 0));
        // Missing/remote objects cannot acquire guessed coordinates. Their original
        // operation is left to the caller/backend; visible world objects alone walk.
        const target = candidates.find((object: WorldObject) => !nativeAdjacent(actor, object, state));
        if (!target)
            return item;
        if (state.permissions?.flags !== undefined && !(Number(state.permissions.flags) & 524288))
            throw new ApproachError('Your avatar cannot walk to this object.');
        this.operation = { generation, actor: Number(state.actorNoid), region: regionKey(state) };
        try {
            let actorPosition = position(actor), standing = false, walkAcknowledged = false;
            const seat = lookup(state, parent(actor));
            if (klass(seat) === 53) {
                const result = await this.waitFor(2405, oid(seat), { unused: 0 }, 2406, generation);
                if (result.coords !== undefined)
                    actorPosition = acknowledgedPosition(result.coords);
                standing = true;
            }
            if (generation !== this.generation)
                throw new ApproachCancelledError();
            const latest = this.getState(), current = lookup(latest, oid(target));
            if (!current)
                throw new ApproachCancelledError('The object left the region before you reached it.');
            const coordinates = nativeWalkCoordinates(current, latest);
            if (!nativeAdjacent(actor, current, latest, { actorPosition, standing })) {
                const result = await this.waitFor(1570, this.operation.actor, { coords: coordinates }, 1571, generation);
                if (generation !== this.generation)
                    throw new ApproachCancelledError();
                actorPosition = acknowledgedPosition(result.coords);
                walkAcknowledged = true;
            }
            const finalState = this.getState(), finalTarget = lookup(finalState, oid(target));
            // Native walkAdjacentToObject checks adjacency before command60, then
            // continues after a successful 1571. AltAway can clamp y/z, including
            // for elevated devices. Its acknowledged destination completes the walk;
            // the final object operation remains responsible for its own validation.
            if (!finalTarget || !walkAcknowledged && !nativeAdjacent(actor, finalTarget, finalState, { actorPosition, standing: true }))
                throw new ApproachError('The world could not move you close enough to use this object.');
            if (generation !== this.generation || regionKey(finalState) !== this.operation.region)
                throw new ApproachCancelledError();
            return item;
        }
        catch (error: any) {
            if (!(error instanceof ApproachCancelledError))
                this.onError?.(error);
            throw error;
        }
        finally {
            if (this.operation?.generation === generation)
                this.operation = null;
        }
    }
    destroy() { this.cancel('The object approach controller was closed.'); this.destroyed = true; }
}
export const ApproachController = ObjectApproach;
export const createObjectApproach = (options: ControllerOptions) => new ObjectApproach(options);
