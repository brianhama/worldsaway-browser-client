import type { NativeImage } from './renderer.js';
import type { WorldState, WorldObject, RuntimeEvent, ActionRequest, StateProvider } from './types.js';
/** Native seating preparation from 00050961/00050962. The IMG spot masks,
 * avatar sit chore's end state and clothing's seated state are wire values;
 * container capacity and named state zero are not substitutes for them. */
export class SeatingError extends Error {
    declare name: string;
    constructor(message: string) { super(message); this.name = 'SeatingError'; }
}
const fields = (object: WorldObject | null | undefined) => object?.fields ?? object ?? {};
const noid = (object: WorldObject | null | undefined) => Number(object?.noid ?? fields(object).noid);
const klass = (object: WorldObject | null | undefined) => Number(object?.classNumber ?? fields(object).classNumber);
const objectAt = (state: WorldState, id: unknown) => (state.objects ?? []).find((object: WorldObject) => noid(object) === Number(id));
const wornClothing = (state: WorldState, actor: WorldObject | null | undefined) => (state.objects ?? []).find((object: WorldObject) => Number(fields(object).container_noid) === noid(actor) && Number(fields(object).position?.[0]) === 3);
const imageKey = (object: WorldObject | null | undefined) => JSON.stringify([fields(object).imageURL ?? '', Number(fields(object).imageVersion) || 0, Number(fields(object).imageDefault) || 0]);
const contextKey = (state: WorldState) => { const region = state.region ?? objectAt(state, 0), f = fields(region), entered = Math.max(0, ...(state.history ?? []).filter((event: RuntimeEvent) => Number(event.id ?? event.messageId) === 101 && Number(event.noid) === 0).map((event: RuntimeEvent) => Number(event.seq) || 0)); return JSON.stringify([state.status, state.worldName, state.avatar, state.actorNoid, f.name, f.imageURL, f.areaCode, entered]); };
const cancelled = (message: string) => Object.assign(new SeatingError(message), { silent: true });
/** Advertised actor-seat bits identify usable spots; occupied child slots exclude them. */
export function availableSeatSpots(seat: WorldObject | null | undefined, state: WorldState, image: NativeImage | null | undefined) {
    const occupied = new Set((state.objects ?? []).filter((object: WorldObject) => Number(fields(object).container_noid) === noid(seat)).map((object: WorldObject) => Number(fields(object).position?.[0])));
    if (Array.isArray(fields(seat).contents))
        fields(seat).contents.forEach((occupant: unknown, index: number) => { if (occupant !== null && occupant !== undefined && Number(occupant) !== 65535)
            occupied.add(index); });
    // A menu can be constructed before its image arrives. Dispatch always loads
    // the image and repeats this check against its actual advertised spot masks.
    const candidates = image?.spotFlags ? image.spotFlags.flatMap((flags: number, index: number) => Number(flags) & 0x40000 ? [index] : []) : Array.from({ length: Math.max(0, Math.min(16, Number(fields(seat).reducedCapacity ?? 1))) }, (_: any, index: number) => index);
    return candidates.filter((index: number) => !occupied.has(index));
}
function chore(image: NativeImage, name: string, current: number) {
    const context = image.namedStates?.[current] ?? image.namedStates?.[0];
    const entry = context?.entries?.find((entry: NativeImage['namedStates'][number]['entries'][number]) => entry.name === name) ?? context?.entries?.find((entry: NativeImage['namedStates'][number]['entries'][number]) => image.chores?.[entry.chore]?.name === name);
    const index = entry?.chore ?? image.chores?.findIndex((chore: NativeImage['chores'][number]) => chore.name === name);
    return { index, entry: image.chores?.[index], context };
}
/** Resolve image-dependent wire fields, then recheck world, appearances, and occupancy.
 * The caller remains responsible for sending the returned Sit request. */
export async function prepareSeatRequest(item: ActionRequest, state: WorldState, { getImage, getState = () => state }: {
    getImage?: (noid: number) => Promise<NativeImage>;
    getState?: StateProvider;
} = {}) {
    if (Number(item.id ?? item.messageId) !== 2401)
        return item;
    if (typeof getImage !== 'function')
        throw new SeatingError('The seat image is not available yet.');
    const seat = objectAt(state, item.noid), actor = objectAt(state, state.actorNoid);
    if (klass(seat) !== 53)
        throw new SeatingError('That seat is no longer available.');
    if (klass(actor) !== 21)
        throw new SeatingError('Become an avatar before sitting down.');
    if (Number(fields(seat).orientation) === 2)
        throw new SeatingError('This seat is facing away and cannot be used.');
    // Image fetches can span a region change or an appearance update. Capture
    // identity/version keys before awaiting and reject stale derived seat fields.
    const initialContext = contextKey(state), actorNoid = noid(actor), seatNoid = noid(seat), actorImageKey = imageKey(actor), seatImageKey = imageKey(seat);
    const currentContext = () => {
        const current = getState() ?? { status: 'disconnected', objects: [] }, actor = objectAt(current, actorNoid), seat = objectAt(current, seatNoid);
        if (contextKey(current) !== initialContext || klass(actor) !== 21 || klass(seat) !== 53)
            throw cancelled('The world or avatar changed before sitting down.');
        if (imageKey(actor) !== actorImageKey || imageKey(seat) !== seatImageKey)
            throw cancelled('The avatar or seat appearance changed before sitting down.');
        return { state: current, actor, seat };
    };
    let seatImage, actorImage;
    try {
        [seatImage, actorImage] = await Promise.all([getImage(seatNoid), getImage(actorNoid)]);
    }
    catch (error: any) {
        currentContext();
        throw error;
    }
    let latest = currentContext(), clothing = wornClothing(latest.state, latest.actor), clothingChore = 0;
    const clothingKey = clothing ? `${noid(clothing)}:${imageKey(clothing)}` : '';
    if (clothing) {
        // The recovered client catches unavailable clothing images/states and
        // retains zero, allowing the avatar itself to sit normally.
        try {
            clothingChore = Math.max(0, (await getImage(noid(clothing))).namedStates.findIndex((state: WorldState) => state.name === 'seated'));
        }
        catch { }
    }
    latest = currentContext();
    const currentClothing = wornClothing(latest.state, latest.actor);
    if ((currentClothing ? `${noid(currentClothing)}:${imageKey(currentClothing)}` : '') !== clothingKey)
        throw cancelled('Your clothing changed before sitting down.');
    if (Number(fields(latest.seat).orientation) === 2)
        throw new SeatingError('This seat is facing away and cannot be used.');
    const spots = availableSeatSpots(latest.seat, latest.state, seatImage);
    if (!spots.length)
        throw new SeatingError('There are no empty places on this seat.');
    const current = Number(fields(latest.actor).choreState) || 0, stool = chore(actorImage, 'sit_on_stool', current);
    const selected = Number(fields(latest.seat).seat_type) === 1 && stool.index > 0 && stool.entry ? stool : chore(actorImage, 'sit', current);
    if (!selected.entry)
        throw new SeatingError('This avatar has no sitting animation.');
    // Send the animation's resolved end-state index, not its chore index.
    const endState = selected.entry.next || selected.context?.name || 'default';
    const choreState = actorImage.namedStates.findIndex((state: WorldState) => state.name === endState);
    if (choreState < 0)
        throw new SeatingError('The sitting animation has no valid final state.');
    return { ...item, fields: { ...(item.fields ?? item.values ?? {}), spot: spots[0], choreState, clothingChore } };
}
