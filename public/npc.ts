import type { WireFields, WorldState, WorldObject, RuntimeEvent, ActionRequest, ApiRequest, StateProvider, ControllerOptions, PendingReply } from './types.js';
/** Native NPC speech preparation, without executing downloaded Tcl.
 * 00054e29.tcl (command 20009) walks a standing, nonadjacent avatar to
 * doorWalkToCoords(position, orientation, orientation % 2), then faces the
 * NPC before request 20010. 000c000e.tcl supplies the four 50-unit offsets.
 * The native clampWalkCoords call discards its return value: these request
 * coordinates intentionally are not transformed by the scene projection.
 */
import { ApproachError, ApproachCancelledError, nativeAdjacent } from './approach.js';
const fields = (object: WorldObject | null | undefined) => object?.fields ?? object ?? {};
const noid = (object: WorldObject | null | undefined) => Number(object?.noid ?? fields(object).noid);
const classNumber = (object: WorldObject | null | undefined) => Number(object?.classNumber ?? fields(object).classNumber);
const lookup = (state: WorldState, id: unknown) => (state.objects ?? []).find((object: WorldObject) => noid(object) === Number(id));
const sequence = (state: WorldState) => Math.max(0, ...(state.history ?? []).map((event: RuntimeEvent) => Number(event.seq) || 0));
const room = (state: WorldState) => { const f = fields(state.region ?? lookup(state, 0)); return `${state.worldName ?? ''}|${state.avatar ?? ''}|${f.name ?? ''}|${f.imageURL ?? ''}|${f.areaCode ?? ''}`; };
const validCoords = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every((item: unknown) => Number.isSafeInteger(Number(item)) && Number(item) >= -32768 && Number(item) <= 32767);
function orientation(object: WorldObject | null | undefined) { const value = Number(fields(object).orientation); if (!Number.isInteger(value) || value < 0 || value > 3)
    throw new ApproachError('This NPC has no valid native facing direction.'); return value; }
/** Approach the NPC from its native facing-specific offset, within signed wire bounds. */
export function nativeNPCWalkCoordinates(object: WorldObject | null | undefined) {
    const position = fields(object).position;
    if (!validCoords(position))
        throw new ApproachError('This NPC has no valid native walking position.');
    const facing = orientation(object), offsets = [[0, -50], [50, 0], [0, 50], [-50, 0]], offset = offsets[facing];
    const coords = [Number(position[0]) + offset[0], Number(position[1]) + offset[1], 0];
    if (!validCoords(coords))
        throw new ApproachError('The NPC walking position exceeds the native coordinate range.');
    return coords;
}
/** Only sends the preparatory walk/facing requests. Await perform(item), then
 * send its returned 20010 item through the caller's normal action API. Other
 * requests, missing/remote NPCs, seated avatars and Ghosts pass through intact.
 */
export class NPCController {
    api!: ApiRequest;
    getState!: StateProvider;
    onError!: ((error: any) => void) | undefined;
    timeout!: number;
    generation!: number;
    operation!: {
        generation: number;
        actor: number;
        target: number;
        room: string;
    } | null;
    pending!: PendingReply | null;
    destroyed!: boolean;
    constructor({ api, getState, stateProvider, onError, timeout = 15000 }: ControllerOptions = {}) {
        if (typeof api !== 'function')
            throw new TypeError('An action API is required');
        this.api = api;
        this.getState = getState ?? stateProvider ?? (() => ({}));
        this.onError = onError;
        this.timeout = timeout;
        this.generation = 0;
        this.operation = null;
        this.pending = null;
        this.destroyed = false;
    }
    /** A generation token prevents an old walk from resuming a replaced conversation. */
    cancel(reason: string = 'The pending NPC conversation was cancelled.') {
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
            this.cancel('The connection changed before the NPC conversation completed.');
            return;
        }
        if (room(state) !== this.operation.room || Number(state.actorNoid) !== this.operation.actor || classNumber(lookup(state, this.operation.actor)) !== 21) {
            this.cancel('You changed region or avatar before the NPC conversation completed.');
            return;
        }
        if (classNumber(lookup(state, this.operation.target)) !== 200) {
            this.cancel('The NPC left the region before the conversation completed.');
            return;
        }
        const pending = this.pending;
        if (!pending)
            return;
        for (const event of state.history ?? []) {
            if (event.type !== 'message' || Number(event.seq) <= pending.after || Number(event.id ?? event.messageId) !== pending.reply)
                continue;
            const direct = Number(event.noid) === pending.noid;
            // Standard replies may be routed through Region 0; correlation still
            // has to identify the actor and original request being awaited.
            const standard = pending.reply === 70 && Number(event.noid) === 0 && Number(event.requestNoid) === pending.noid && Number(event.requestId) === pending.id;
            if (!direct && !standard)
                continue;
            if (event.requestId !== undefined && Number(event.requestId) !== pending.id)
                continue;
            clearTimeout(pending.timer!);
            this.pending = null;
            const reply = event.fields ?? event.values ?? {};
            if (Number(reply.success) !== 0)
                pending.reject(new ApproachError(reply.fail_msg || `The world declined NPC movement${reply.success === undefined ? '' : ` (code ${reply.success})`}.`));
            else
                pending.resolve(reply);
            break;
        }
    }
    waitFor(id: number, fields: WireFields, reply: number, generation: number) {
        if (generation !== this.generation)
            return Promise.reject(new ApproachCancelledError());
        const state = this.getState(), actor = this.operation!.actor;
        return new Promise<WireFields>((resolve, reject) => {
            const pending: PendingReply = { id, noid: actor, reply, after: sequence(state), resolve, reject, timer: null };
            pending.timer = setTimeout(() => { if (this.pending === pending)
                this.pending = null; reject(new ApproachError('The world did not acknowledge NPC movement in time.')); }, this.timeout);
            // Arm the waiter before dispatch because a snapshot may arrive first.
            this.pending = pending;
            Promise.resolve().then(() => { if (generation !== this.generation || this.pending !== pending)
                throw new ApproachCancelledError(); return this.api('/api/action', { noid: actor, id, fields }); }).then((result: any) => this.ingestState(result?.state ?? this.getState())).catch((error: any) => { if (this.pending === pending) {
                clearTimeout(pending.timer!);
                this.pending = null;
                reject(error);
            } });
        });
    }
    async perform(item: ActionRequest) {
        if (this.destroyed)
            throw new ApproachCancelledError('The NPC conversation controller is closed.');
        this.cancel();
        const generation = this.generation;
        if (Number(item?.id ?? item?.messageId) !== 20010)
            return item;
        const state = this.getState(), actor = lookup(state, state.actorNoid), target = lookup(state, item.noid);
        // Advanced direct requests retain server authority. Native primary Talk is
        // separately gated by npc_flags & 4; do not invent Ghost or remote movement.
        if (!actor || classNumber(actor) !== 21 || Number(state.actorNoid) === 15 || classNumber(target) !== 200)
            return item;
        if (state.status !== 'connected')
            throw new ApproachCancelledError('Enter the world before talking to this NPC.');
        if (classNumber(lookup(state, fields(actor).container_noid ?? 0)) === 53 || nativeAdjacent(actor, target, state))
            return item;
        this.operation = { generation, actor: Number(state.actorNoid), target: noid(target), room: room(state) };
        try {
            const coords = nativeNPCWalkCoordinates(target), reply = await this.waitFor(1570, { coords }, 1571, generation);
            if (generation !== this.generation)
                throw new ApproachCancelledError();
            if (!validCoords(reply.coords))
                throw new ApproachError('The world returned no valid NPC walking destination.');
            const latest = this.getState(), current = lookup(latest, noid(target));
            if (room(latest) !== this.operation.room || classNumber(current) !== 200)
                throw new ApproachCancelledError('The NPC left the region before the conversation completed.');
            // Native code reads facing again after the walk and does not recheck
            // adjacency against its intentionally offset destination.
            await this.waitFor(1688, { facing: (orientation(current) + 2) % 4 }, 70, generation);
            if (generation !== this.generation)
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
    destroy() { this.cancel('The NPC conversation controller was closed.'); this.destroyed = true; }
}
export const createNPCController = (options: ControllerOptions) => new NPCController(options);
