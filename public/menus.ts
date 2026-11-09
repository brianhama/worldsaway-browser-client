/** A leaf describes an action or UI command; a branch holds inert submenu data. */
export interface MenuItem extends ActionRequest {
    label: string;
    items?: MenuItem[];
    disabled?: boolean;
    form?: boolean;
}
import type { WireFields, WorldState, WorldObject, RuntimeEvent, ActionRequest, ActionDescriptor } from './types.js';
/** Native context-menu equivalents, built from object state rather than executing
 * Tcl. Primary sources: 000505dd (Avatar), 000507d1 (Ghost), 0005077e
 * (Status), 00050001 BuildMenus, and the class menu methods in the WA cache. */
import { getActions, getAction, fieldDefaults } from './actions.js';
import { objectName, objectClass, objectParent } from './model.js';
import { availableSeatSpots } from './seating.js';
import { nativeGroundWalkRequest, nativeObjectWalkRequest } from './approach.js';
/** Literal getActMenuEntry table from recovered library 000c0072. */
export const ACTION_MENU_ENTRIES = Object.freeze([["Use", "Turn On", "Turn Off"], ["Activate", "Activate", "Deactivate"], ["Toggle", "Engage", "Disengage"], ["Light", "Light", "Put out"], ["Play", "Play", "Stop"], ["Push", "Push", "Push"], ["Press", "Open", "Close"], ["Touch", "Extend", "Retract"], ["Poke", "Wake up", "Sleep"], ["Adjust", "Expand", "Shrink"], ["Lift", "Lift up", "Lower down"], ["Tug", "Raise", "Lower"], ["Fiddle", "Adjust up", "Adjust down"], ["Flip", "Push", "Pull"], ["Throw", "Start", "Stop"], ["Launch", "Launch", "Land"], ["Fly", "Set Free", "Put in cage"], ["Eat", "Crumble", "Rebuild"], ["Drink", "Swallow", "Spit out"], ["Fill", "Fill", "Empty"], ["Ring", "Start ringing", "Stop ringing"], ["Bounce", "Bounce", "Stop bouncing"], ["Flash", "Start flashing", "Stop flashing"], ["Wind", "Wind", "Unwind"], ["Squeeze", "Squeeze", "Release"], ["Vibrate", "Vibrate", "Stop vibrating"], ["Shower", "Start shower", "Stop shower"], ["Blow", "Blow", "Stop blowing"], ["Scan", "Start scanning", "Stop scanning"], ["Energize", "Dematerialize", "Materialize"], ["Alert", "Red alert", "Condition green"], ["Disintigrate", "Disintigrate", "Reintigrate"], ["Tickle", "Tickle", "Stop tickling"], ["Fire", "Start firing", "Stop firing"], ["Detonate", "Raise shields", "Shields down"], ["Ignite", "Warp speed", "Sublight"], ["Destroy", "Destroy", "Build"], ["Break", "Break", "Repair"], ["Clean", "Clean", "Dirty"], ["Sweep", "", ""], ["Mop", "", ""], ["Dust", "", ""], ["Scrub", "", ""], ["Squirt", "", ""], ["Wave", "", ""], ["Pluck", "", ""], ["Shuffle", "", ""], ["Cook", "", ""], ["Bake", "", ""]].map(row => Object.freeze(row)));
const fields = (object: WorldObject | null | undefined) => object?.fields ?? object ?? {};
const noid = (object: WorldObject | null | undefined) => Number(object?.noid ?? fields(object).noid);
const slot = (object: WorldObject | null | undefined) => Number(fields(object).position?.[0] ?? 0);
const children = (object: WorldObject | null | undefined, state: WorldState) => (state.objects ?? []).filter((item: WorldObject) => noid(item) !== noid(object) && objectParent(item) === noid(object)).sort((a, b) => slot(a) - slot(b));
const child = (object: WorldObject | null | undefined, index: number, state: WorldState) => children(object, state).find((item: WorldObject) => slot(item) === index);
const group = (label: string, items: MenuItem[]): MenuItem => ({ label, items });
const item = (label: string, id: number, target: unknown, values: WireFields = {}, options: Partial<MenuItem> = {}): MenuItem => ({ label, id, noid: Number(target), fields: { ...fieldDefaults(id), ...values }, ...options });
const helper = (label: string, command: string, target: unknown, values: WireFields = {}): MenuItem => ({ label, command, noid: Number(target), fields: values });
const portable = (object: WorldObject | null | undefined) => !(Number(fields(object).common_flags ?? 0) & (2 | 256 | 512));
const physical = (object: WorldObject | null | undefined) => objectClass(object) === 21;
const preferenceChanges = new Map<number, [
    number,
    boolean
]>([[60, [32, true]], [61, [32, false]], [90, [64, false]], [91, [64, true]], [93, [128, true]], [94, [128, false]], [251, [512, true]], [252, [512, false]], [500, [0x8000, false]], [501, [0x8000, true]], [503, [0x1000, true]], [504, [0x1000, false]]]);
// Some preference replies update only the sender. Replay successful changes
// after the latest region entry so toggle labels follow acknowledged choices.
function playerFlags(state: WorldState) {
    const history = state.history ?? [], entry = [...history].reverse().find((event: RuntimeEvent) => Number(event.id ?? event.messageId) === 101 && event.fields?.actor_flags !== undefined);
    let value = Number(state.playerFlags ?? state.avatarFlags ?? entry?.fields?.actor_flags ?? 0) >>> 0;
    for (const event of history) {
        if (Number(event.seq ?? 0) < Number(entry?.seq ?? 0) || Number(event.requestId) !== 1916 || Number(event.fields?.success) !== 0)
            continue;
        const change = preferenceChanges.get(Number(event.fields!.type));
        if (change)
            value = change[1] ? value | change[0] : value & ~change[0];
    }
    return value >>> 0;
}
// These checks shape the interface; the backend still authorizes each request.
const can = (state: WorldState, bit: number) => state.permissions?.flags === undefined ? true : (Number(state.permissions.flags) & bit) !== 0;
const staffLevel = (state: WorldState) => Math.max(Number(state.permissions?.level ?? 0), state.role === 'admin' ? 2000 : state.role === 'moderator' ? 1000 : 0);
const oracle = (state: WorldState) => staffLevel(state) >= 2000;
const fiddleAllowed = (state: WorldState) => Boolean(Number(state.permissions?.flags ?? 0) & 1) || state.role === 'builder' || state.role === 'admin';
function actorOf(state: WorldState) { return state.actorNoid === null || state.actorNoid === undefined ? null : (state.objects ?? []).find((object: WorldObject) => noid(object) === Number(state.actorNoid)) ?? null; }
function isSeated(actor: WorldObject | null | undefined, state: WorldState) { return objectClass((state.objects ?? []).find((object: WorldObject) => noid(object) === objectParent(actor))) === 53; }
function integerCoordinate(value: unknown) { const number = Number(value); return Number.isFinite(number) ? Math.max(-32768, Math.min(32767, Math.round(number))) : 0; }
/** Native Help-menu paging uses the configured helper and the region ESP route. */
export function nativePageHelper(state: WorldState = {}) {
    const entry = [...(state.history ?? [])].reverse().find((event: RuntimeEvent) => Number(event.noid) === 0 && Number(event.id ?? event.messageId) === 101 && event.fields?.helper_name !== undefined);
    const name = String(state.helperName ?? entry?.fields?.helper_name ?? '').trim();
    return item(name ? `Page ${name}` : 'Page Helper', 109, 0, { type: 0, to: name, text: name ? `${name} paged from the Help menu.` : '' }, { disabled: state.status !== 'connected' || !name || Number(state.tcl?.blockCount) > 0 });
}
export function nativeStatusMenu(actor: WorldObject | null | undefined, state: WorldState) {
    const target = noid(actor), flags = playerFlags(state), entries = [
        item("Who's in here?", 1916, target, { type: 55 }), item('Where is everyone?', 1916, target, { type: 192 }),
        item('Where am I?', 1916, target, { type: 56 }), item('Helpers on duty?', 1916, target, { type: 502 }),
    ];
    if (can(state, 16))
        entries.push(item('How healthy am I?', 1916, target, { type: 57 }));
    entries.push(item('What time is it?', 1916, target, { type: 58 }), item('Total online time?', 1916, target, { type: 14 }), item('Reset online time', 1916, target, { type: 15 }));
    if (can(state, 16))
        entries.push(item('Tokens in hand and pocket?', 1916, target, { type: 59 }));
    if (can(state, 128))
        entries.push(item(flags & 32 ? 'Turn ESP on' : 'Turn ESP off', 1916, target, { type: flags & 32 ? 61 : 60 }));
    if (can(state, 8388608))
        entries.push(item(flags & 512 ? 'Turn ESP mail on' : 'Turn ESP mail off', 1916, target, { type: flags & 512 ? 252 : 251 }));
    if (can(state, 32768))
        entries.push(item(flags & 64 ? 'Allow following' : 'Disallow new followers', 1916, target, { type: flags & 64 ? 90 : 91 }));
    if (Number(state.permissions?.level ?? 0) >= 1000)
        entries.push(item(flags & 128 ? 'Go Off Duty' : 'Go On Duty', 1916, target, { type: flags & 128 ? 94 : 93 }));
    if (can(state, 0x20000000))
        entries.push(item(flags & 0x8000 ? 'Announce my logins' : 'Do not announce my logins', 1916, target, { type: flags & 0x8000 ? 500 : 501 }));
    if (can(state, 0x40000000))
        entries.push(item(flags & 0x1000 ? 'Enable Gestures' : 'Disable Gestures (Korean Mode)', 1916, target, { type: flags & 0x1000 ? 504 : 503 }));
    return group('Status', entries);
}
function appendObjectTail(entries: MenuItem[], object: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState, { editSelf = false }: {
    editSelf?: boolean;
} = {}) {
    const target = noid(object), f = fields(object);
    if ((editSelf && can(state, 2097152)) || oracle(state)) {
        entries.push(item('Edit URL...', 165, 0, { target, newURLlabel: f.URLlabel ?? '', newURL: f.URL ?? f.url ?? '' }, { form: true }));
        entries.push(item('Edit TMA...', 194, 0, { target, newTMA: f.description ?? f.TMAtext ?? '' }, { form: true }));
    }
    if (f.URLlabel)
        entries.push(item(String(f.URLlabel), 161, 0, { target, which: 0 }));
    entries.push(item('Tell me about', 76, target));
}
function avatarMenu(object: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    const target = noid(object), own = target === noid(actor), entries: MenuItem[] = [], held = child(actor, 0, state), head = child(actor, 1, state), seated = isSeated(actor, state), f = fields(object);
    if (own && physical(actor)) {
        entries.push(group('Mood', ['Normal', 'Happy', 'Sad', 'Mad'].map((label, mood) => item(label, 1616, target, { mood }))));
        const gestures = [['Wave', '0xF00B'], ...(!seated ? [['Bow', '0xF00C'], ['Shrug', '0xF00D'], ['Present', '0xF00F'], ['Jump', 'jump_up'], ['React', 'stomp_internal_leg']] : [])];
        entries.push(group('Gesture', gestures.map(([label, gesture]: any) => item(label, 1594, target, { gesture }))));
        if (!seated) {
            const facing = Number(f.orientation ?? 0);
            entries.push(group('Turn', [['Left', 1], ['Right', -1], ['Around', 2]].map(([label, delta]: any) => item(label, 1688, target, { facing: (facing + delta + 4) % 4 }))));
        }
        else
            entries.push(item('Stand up', 2405, objectParent(actor)));
        if (held) {
            if (can(state, 1024)) {
                const into = [item('Pocket', 89, noid(held))];
                for (const pocket of children(actor, state).filter((item: WorldObject) => slot(item) >= 4 && objectClass(item) === 36 && !(Number(fields(item).common_flags) & 16)))
                    into.push(item(objectName(pocket), 85, noid(held), { container: noid(pocket), in_pocket: 1 }));
                entries.push(group('Put into', into));
            }
            if (objectClass(held) === 24 && can(state, 2048))
                entries.push(item('Wear Head', 3601, noid(held)));
        }
        else {
            if (can(state, 512)) {
                const pockets = children(actor, state).filter((object: WorldObject) => slot(object) >= 4 && portable(object)).map((object: WorldObject) => item(objectName(object), 97, noid(object)));
                pockets.push(item('Show more...', 1711, target));
                entries.push(group('Get from pocket', pockets));
            }
            if (head && can(state, 4096))
                entries.push(item('Remove Head', 3605, noid(head)));
        }
        entries.push(nativeStatusMenu(actor, state));
        if (can(state, 32))
            entries.push(item('Become a Ghost', 1587, target));
        if (Number(f.following ?? 65535) !== 65535 && can(state, 65536))
            entries.push(item('Stop following', 1603, target));
        if (Number(f.webfollowing ?? 0) !== 0 && can(state, 262144))
            entries.push(item('Stop Web Touring', 179, 0, { target: 0 }));
        if (playerFlags(state) & 1024)
            entries.push(item('Read ESP mail', 247, 0));
        appendHeldVerbs(entries, object, actor, state);
        appendObjectTail(entries, object, actor, state, { editSelf: true });
    }
    else if (own && objectClass(actor) === 22) {
        if (can(state, 16)) {
            // 000507d1's context menu explicitly supplies {0 0 0}; Ghost position depth
            // 255 is a rendering sentinel and must never become materialization depth.
            const requested = Array.isArray(state.contextCoords) ? state.contextCoords : [0, 0, 0];
            entries.push(item('Become an Avatar', 2005, target, { coords: [integerCoordinate(requested[0]), integerCoordinate(requested[1]), 0] }));
        }
        entries.push(nativeStatusMenu(actor, state));
        if (can(state, 8388608))
            entries.push(helper('Send ESP Mail', 'mail', 0, { to: '' }));
        if (playerFlags(state) & 1024)
            entries.push(item('Read ESP mail', 247, 0));
        entries.push(item('How many ghosts?', 2003, target));
        appendObjectTail(entries, object, actor, state);
    }
    else {
        if (can(state, 128))
            entries.push(helper('ESP...', 'esp', target, { to: objectName(object) }));
        if (physical(actor)) {
            entries.push(item('Touch', 1591, target));
            if (can(state, 65536))
                entries.push(Number(fields(actor).following ?? 65535) === target ? item('Stop following', 1603, noid(actor)) : item('Follow', 1600, target));
            if (held && can(state, 1024))
                entries.push(item('Give to', 1605, target, {}, { disabled: Boolean(child(object, 0, state)) }));
        }
        if (can(state, 262144) && Number(f.webfollow_textid ?? 0) !== 0)
            entries.push(item("Join this avatar's Web Tour", 179, 0, { target }));
        entries.push(helper('Ignore this avatar', 'ignore', target, { name: objectName(object) }));
        appendHeldVerbs(entries, object, actor, state);
        appendObjectTail(entries, object, actor, state);
    }
    return entries;
}
function appendCarry(entries: MenuItem[], object: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    if (!physical(actor))
        return;
    const target = noid(object), held = child(actor, 0, state), parent = objectParent(object), holding = held && noid(held) === target;
    if (holding) {
        if (can(state, 1024)) {
            entries.push(item('Put in pocket', 89, target), item('Put down', 1580, noid(actor)));
        }
    }
    else if (parent === noid(actor) && slot(object) >= 4 && can(state, 512)) {
        entries.push(item('Get from pocket', 97, target, {}, { disabled: Boolean(held) }));
    }
    else if (parent === 0 && portable(object) && can(state, 512))
        entries.push(item('Get', 1575, noid(actor), { item: target, action: 0 }, { disabled: Boolean(held) }));
}
function classMenu(entries: MenuItem[], object: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    const target = noid(object), klass = objectClass(object), f = fields(object), own = noid(actor), held = child(actor, 0, state), holding = held && noid(held) === target, isPhysical = physical(actor);
    const normal = (label: string, id: number, values: WireFields = {}, options: Partial<MenuItem> = {}) => entries.push(item(label, id, target, values, options));
    switch (klass) {
        case 24:
            if (holding)
                normal('Wear Head', 3601);
            else if (objectParent(object) === own && slot(object) === 1 && !held)
                normal('Remove Head', 3605);
            break;
        case 26:
            if (holding)
                normal('Split...', 1139, {}, { form: true });
            break;
        case 30:
            if (holding && can(state, 2048) && child(actor, 1, state) && [0, 1, 2].includes(Number(f.slot ?? 0)))
                normal(`Wear ${objectName(object)}`, 3201);
            else if (!held && objectParent(object) === noid(child(actor, 1, state)) && can(state, 4096))
                normal(`Remove ${objectName(object)}`, 3205);
            appendUseOperation(entries, object, state);
            break;
        case 31:
            appendUseOperation(entries, object, state);
            break;
        case 33:
            normal('Request balance', 2801);
            if (isPhysical && objectClass(held) === 26)
                normal('Deposit...', 2806, {}, { form: true });
            if (isPhysical && (!held || objectClass(held) === 26))
                entries.push(group('Withdraw tokens...', [10, 50, 100, 500, 0].map((amount) => item(amount ? ` ${amount} T` : 'All', 2810, target, { amount }))));
            break;
        case 34:
            normal('Change body...', 3301, {}, { form: true });
            break;
        case 35:
            normal('Which way is north?', 3424, { actor: own });
            normal('Which way am I facing?', 3427, { actor: own });
            break;
        case 36:
        case 59:
        case 201: {
            const locked = Boolean(Number(f.common_flags) & 16), open = !(Number(f.common_flags) & 8), latch = Number(f.latchType ?? 0);
            if (open && !locked) {
                const contents = children(object, state).filter(portable).map((child) => item(objectName(child), 93, noid(child)));
                if (contents.length)
                    entries.push(group('Get from...', contents));
                if (held && noid(held) !== target)
                    entries.push(item('Put into', 85, noid(held), { container: target, in_pocket: 0 }));
            }
            if (isPhysical && latch !== 0 && !locked)
                entries.push(item(open ? 'Close' : 'Open', open ? 1611 : 1608, own, { item: target }));
            if (isPhysical && latch === 2 && (objectClass(held) === 44 || oracle(state)))
                normal(locked ? 'Unlock' : 'Lock', 300, { indirect: objectClass(held) === 44 ? noid(held) : 65535, state: locked ? 0 : 16, keycode: 0xffffffff });
            if (isPhysical && latch === 3)
                normal(locked ? 'Unlock...' : 'Lock...', 300, { indirect: 65535, state: locked ? 0 : 16, keycode: 0 }, { form: true });
            if (latch === 3 && locked)
                normal('Reset combination', 337, { mode: 2 }, { form: true });
            if (klass === 201) {
                normal('Owner?', 20103);
                normal('Adopt...', 20105, { target: own }, { form: true });
            }
            break;
        }
        case 37:
            entries.push(helper('Read...', 'document', target));
            if (!(Number(f.documentFlags) & 1) && Number(f.blank_page_count) > 0 && (!holding || Number(f.blank_page_count) > 1 || Number(f.textid) > 0))
                normal('New document from blank pages', 2791, { pages: 1, inhand: holding ? 1 : 0 }, { form: true });
            if (holding && (Number(f.documentFlags) & 8))
                normal('Publish this document', 2751, { actor: own });
            break;
        case 38: {
            const labels: Record<number, string> = { 1: 'Climb up', 2: 'Climb down', 3: 'Climb over', 4: 'Go up', 5: 'Go down', 6: 'Squeeze through', 7: 'Sneak through', 8: 'Burst through', 9: 'Jump over' }, locked = Boolean(Number(f.common_flags) & 16), latch = Number(f.latchType ?? 0), key = objectClass(held) === 44, restricted = Boolean(Number(f.common_flags) & 32);
            if (can(state, 1048576) && (!locked || key && latch === 2 || oracle(state)))
                normal(locked && oracle(state) ? 'Slip through' : labels[Number(f.mood)] ?? 'Pass through', 2351);
            if (isPhysical && latch === 2 && (key || oracle(state)) && (!restricted || oracle(state)))
                normal(locked ? 'Unlock' : 'Lock', 300, { indirect: key ? noid(held) : 65535, state: locked ? 0 : 16, keycode: 0xffffffff });
            if (isPhysical && latch === 3) {
                if (locked)
                    normal('Unlock...', 300, { indirect: 65535, state: 0, keycode: 0 }, { form: true });
                else if (!restricted)
                    normal('Lock...', 300, { indirect: 65535, state: 16, keycode: 0 }, { form: true });
                if (!restricted)
                    normal('Reset combination', 337, { mode: 2 }, { form: true });
            }
            break;
        }
        case 39:
            normal('Go to...', 4102, {}, { form: true });
            break;
        case 43:
            normal('Print copies...', 4361, {}, { form: true });
            if (held && objectClass(held) === 37)
                normal('Set printing master', 4353, { master: noid(held) });
            break;
        case 45:
            normal('Activate', 2131, { state: 1 });
            break;
        case 46:
            normal('Rental plans...', 4001, {}, { form: true });
            normal('Rent a turf...', 4005, {}, { form: true });
            normal('Pay rent...', 4009, {}, { form: true });
            break;
        case 47:
            normal('Buy this paper', 4403, { actor: own });
            break;
        case 49:
            normal('Appraise', 2561);
            if (held)
                normal('Pawn', 2565);
            break;
        case 50:
            normal('Get mail', 4457);
            normal('Send mail...', 4453, {}, { form: true });
            break;
        case 51:
            normal('Recycle', 4303, { target: held ? noid(held) : 65535 });
            normal('Make blank pages...', 4311, {}, { form: true });
            break;
        case 52:
            normal('List names', 2920);
            normal('Register name...', 2924, {}, { form: true });
            break;
        case 53:
            if (isSeated(actor, state) && objectParent(actor) === target)
                normal('Stand up', 2405);
            else if (isPhysical && Number(f.orientation) !== 2) {
                const spots = availableSeatSpots(object, state, state.seatImages?.get?.(target));
                normal('Sit down', 2401, { spot: spots[0] ?? 65535, choreState: 0, clothingChore: 0 }, { disabled: !spots.length });
            }
            break;
        case 54: break;
        case 55: break; // The native Spray submenu belongs to the held can + target context.
        case 56:
            normal('Teleport...', 1202, {}, { form: true });
            break;
        case 57: {
            const price = Number(f.price ?? child(object, 0, state)?.fields?.salePrice ?? 0);
            normal('View next item', 2671, { forward: 1 });
            normal('View previous item', 2671, { forward: 0 });
            normal(`Buy this item (${price} T)`, 2675, { slot: 0 }, { disabled: !isPhysical || Boolean(held) });
            if ((Number(f.vendo_flags) & 2) || oracle(state)) {
                if (held)
                    normal('Stock...', 2678, {}, { form: true });
                else
                    normal('Unload', 2682);
            }
            break;
        }
        case 58:
            normal('Roll', 4501, { hidden: 0 });
            normal('Show result', 4505, { to_who: 0 });
            break;
        case 41:
            if (holding && fiddleAllowed(state))
                appendFiddleMenu(entries, object, held, actor, state);
            break;
        case 32:
            if (holding)
                appendAmuletMenu(entries, object, held, actor, state);
            break;
        case 60:
            if (holding)
                appendBuilderMenu(entries, object, held, actor, state);
            break;
        case 61:
            entries.push(helper(f.presentationLabel || 'Start presentation', 'presentation', target));
            normal('Get prize', 5675, { slot: 0 });
            break;
        case 98:
            normal('Engrave...', 9908, { target: held ? noid(held) : 65535 }, { form: true });
            break;
        case 200:
            if (Number(f.npc_flags) & 4)
                normal('Talk to...', 20010, {}, { form: true });
            break;
        case 203:
            normal('Drink', 20302);
            break;
        case 205:
            normal('Bill', 20502);
            if (held)
                normal('Pay', 20504);
            break;
        case 206:
            if (holding)
                normal(`Wear ${objectName(object)}`, 20602, { clothingChore: 0 });
            else if (objectParent(object) === own && slot(object) === 3 && !held)
                normal(`Remove ${objectName(object)}`, 20605);
            break;
        case 209:
            normal(f.menuEntry || 'Use Portkey', 20907);
            break;
        case 210:
            normal(f.menuEntry || 'Play', 21004);
            break;
        case 213:
            normal(f.menuEntry || 'Play', 21304);
            break;
        case 215:
            normal('Show hidden decorations', 21505);
            normal('Hide / show object...', 21503, {}, { form: true });
            break;
    }
}
/** pointAt case4 (00050001:167-175) merges the held object's menu after
 * the directly selected object's verbs. The Document menu explicitly adds its
 * held-item Read/blank-page/publish verbs when self != direct (00050a8d).
 * Other held classes keep their direct/indirect target guards; they are not
 * indiscriminately copied into an Avatar menu. */
function appendHeldVerbs(entries: MenuItem[], direct: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    const held = child(actor, 0, state);
    if (!held || noid(held) === noid(direct))
        return;
    if (objectClass(held) === 41) {
        appendFiddleMenu(entries, direct, held, actor, state);
        return;
    }
    if (objectClass(held) === 32) {
        appendAmuletMenu(entries, direct, held, actor, state);
        return;
    }
    if (objectClass(held) === 60) {
        appendBuilderMenu(entries, direct, held, actor, state);
        return;
    }
    if (objectClass(held) === 55) {
        appendSprayMenu(entries, direct, held, actor, state);
        return;
    }
    if (objectClass(held) !== 37)
        return;
    const f = fields(held), target = noid(held), capacity = Number(fields(actor).reducedCapacity ?? 0), occupied = new Set(children(actor, state).map(slot));
    const room = capacity < 4 || Array.from({ length: Math.min(65535, Math.max(0, capacity - 4)) }, (_, i) => i + 4).some((slot) => !occupied.has(slot));
    entries.push(helper('Read...', 'document', target));
    if (room && !(Number(f.documentFlags) & 1) && (Number(f.blank_page_count) > 1 || Number(f.textid) > 0 && Number(f.blank_page_count) > 0))
        entries.push(item('New document from blank pages', 2791, target, { pages: 1, inhand: 1 }, { form: true }));
    if (Number(f.documentFlags) & 8)
        entries.push(item('Publish this document', 2751, target, { actor: noid(actor) }));
}
// A toggle can change through a broadcast notice or a sender-only reply. Ignore
// history from earlier scenes when deriving the next on/off menu operation.
function operationIsActive(object: WorldObject | null | undefined, state: WorldState, requestId: number, noticeId: number, replyId: number) {
    let active = Number(fields(object).choreState ?? 0) !== 0;
    const history = state.history ?? [], scene = [...history].reverse().find((event: RuntimeEvent) => Number(event.id ?? event.messageId) === 101), after = Number(scene?.seq ?? 0);
    for (const event of history) {
        if (Number(event.seq ?? 0) <= after || Number(event.noid) !== noid(object) || event.type !== 'message')
            continue;
        if (Number(event.id) === noticeId && event.fields?.action !== undefined) {
            active = Number(event.fields.action) !== 0;
            continue;
        }
        if (Number(event.id) !== replyId || Number(event.fields?.success) !== 0)
            continue;
        const request = [...history].reverse().find((previous) => previous.type === 'request' && Number(previous.id) === requestId && Number(previous.noid) === noid(object) && Number(previous.seq) < Number(event.seq));
        const action = event.requestFields?.action ?? request?.fields?.action;
        if (action !== undefined)
            active = Number(action) !== 0;
    }
    return active;
}
/** Accessory uses action_type 2 for toggle; Use uses action_type 1. */
function appendUseOperation(entries: MenuItem[], object: WorldObject | null | undefined, state: WorldState) {
    const f = fields(object), accessory = objectClass(object) === 30, type = Number(f.action_type ?? 0), entry = ACTION_MENU_ENTRIES[Number(f.action_menu ?? 0)];
    if (!entry || accessory && type === 0)
        return;
    const id = accessory ? 3211 : 4151, toggle = accessory ? type === 2 : type === 1;
    const active = toggle && operationIsActive(object, state, id, accessory ? 3213 : 4153, accessory ? 3212 : 4152), action = toggle ? active ? 0 : 1 : 2, label = entry[toggle ? active ? 2 : 1 : 0];
    if (label)
        entries.push(item(label, id, noid(object), { action }));
}
function outerObject(object: WorldObject | null | undefined, state: WorldState) {
    let current: WorldObject | null | undefined = object;
    const seen = new Set();
    while (objectParent(current) !== 0) {
        const next = objectParent(current);
        if (seen.has(next))
            return null;
        seen.add(next);
        current = (state.objects ?? []).find((object: WorldObject) => noid(object) === next);
        if (!current)
            return null;
    }
    return current;
}
/** 000503e9's held-can menus, with the target's current 16-color map as sent by
 * request method 000503ea. The backend selects the actual replacement colors. */
function appendSprayMenu(entries: MenuItem[], direct: WorldObject | null | undefined, canObject: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    const canFields = fields(canObject);
    if (!physical(actor) || !can(state, 8192) || !Number(canFields.canCharges))
        return;
    const type = Number(canFields.canType), parts: MenuItem[] = [], own = outerObject(direct, state), head = child(actor, 1, state);
    const spray = (label: string, what: number, target: WorldObject | null | undefined) => { const colors = Array.isArray(fields(target).colorMap) && fields(target).colorMap.length === 16 ? [...fields(target).colorMap] : Array(16).fill(0); return item(label, 1035, noid(canObject), { what, target_noid: noid(target), colors }); };
    if (own && noid(own) === noid(actor)) {
        if (type === 1 && head)
            parts.push(spray('Eyes', 49, head), spray('Hair', 48, head), spray('Face', 50, head));
        if (type === 0)
            parts.push(spray('Skin', 51, actor), spray('Lower', 81, actor), spray('Upper', 82, actor));
    }
    if (type === 2 && [25, 38].includes(objectClass(direct)) && (playerFlags(state) & 16) || oracle(state))
        parts.push(spray('Paint this', 188, direct));
    if (parts.length)
        entries.push(group('Spray', parts));
}
/** Fiddle menu labels/operations: 00050bb8 plus 000c006b. Creation and
 * authoring requests target Region 0 even while the Fiddle tool is held. */
function appendFiddleMenu(entries: MenuItem[], direct: WorldObject | null | undefined, tool: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    if (!fiddleAllowed(state) || !physical(actor))
        return;
    const target = noid(direct), point = fields(actor).position ?? [0, 0, 0], create = { classno: objectClass(direct) === 21 ? 27 : objectClass(direct), xloc: point[0], yloc: point[1] };
    const form = (label: string, id: number, values: WireFields = {}) => item(label, id, 0, values, { form: true });
    const actions = [form('Create Object', 200, create), group('Modify Object', [form('List fields', 206, { target }), form('Read field...', 203, { target }), form('Write field...', 205, { target })]),
        group('Modify Properties', [form('Read property...', 208, { target }), form('Write property...', 210, { target })]),
        group('Modify Actions', [form('Read action binding', 30001, { target }), form('Write action binding...', 30003, { target }), form('Read stored action...', 30004), form('Store action...', 30006)])];
    if (objectClass(direct) !== 21)
        actions.push(form('Duplicate Object', 201, { target, count: 1 }), form('Destroy Object', 202, { target }));
    actions.push(group('Region', [form('Create', 220), form('Duplicate', 221), form('Modify', 225), item('Details', 223, 0), form('Destroy', 222), form('List regions...', 226)]));
    actions.push(group('Region Group', [form('Create', 230), form('Duplicate', 231), form('Modify', 235), item('Details', 233, 0), form('Add Region', 236), form('Remove Region', 237), form('Destroy', 232), form('List groups...', 238)]));
    entries.push(group('Fiddle', actions));
}
/** Amulet privileges and commands are defined in 00050c1c. Unknown role names
 * never grant moderation; explicit native levels or recognized staff roles do. */
function appendAmuletMenu(entries: MenuItem[], direct: WorldObject | null | undefined, tool: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    if (staffLevel(state) < 1000 || !physical(actor))
        return;
    const target = noid(direct), toolNoid = noid(tool), self = target === noid(actor) || target === toolNoid, actions: MenuItem[] = [];
    const form = (label: string, id: number, receiver: number, values: WireFields = {}) => item(label, id, receiver, values, { form: true });
    if (self) {
        actions.push(form('Teleport to Avatar', 3117, toolNoid), form('Freeze...', 1703, noid(actor), { avatar_name: '', howlong: 600 }), form('Mute...', 1701, noid(actor), { avatar_name: '', howlong: 600 }));
        if (oracle(state))
            actions.push(form('Summon', 3101, toolNoid), form('Teleport Avatar', 3107, toolNoid));
    }
    else if (objectClass(direct) === 21) {
        if (oracle(state))
            actions.push(form('Teleport', 124, 0, { avatar_name: objectName(direct), get_real: 0 }));
        actions.push(item('Force Ghosting', 1587, target), form('Freeze', 1703, target, { avatar_name: objectName(direct), howlong: 600 }), form('Mute', 1701, target, { avatar_name: objectName(direct), howlong: 600 }));
        if (oracle(state)) {
            if (getAction(1686))
                actions.push(item('Force Log Out', 1686, target));
            if (getAction(1699))
                actions.push(item('Disclose Owner', 1699, target));
            if (getAction(1681))
                actions.push(form('Change permission level...', 1681, target, { target, perm_level: 0 }));
        }
    }
    if (actions.length)
        entries.push(group('Amulet Powers', actions));
}
/** Exact Builder target/location/function masks from 000514b5 and
 * builderFunctionEnabled in 000c0070. Possessing a tool alone grants nothing. */
function appendBuilderMenu(entries: MenuItem[], direct: WorldObject | null | undefined, tool: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    if (!physical(actor))
        return;
    const flags = fields(tool), targetFlags = Number(fields(direct).common_flags ?? 0), mask = Number(flags.targetEnable ?? 0), location = Boolean(Number(flags.locationEnable) & 1) || Boolean(playerFlags(state) & 16);
    if (!location)
        return;
    let enabled = [30, 31, 36, 24, 48, 53, 55, 57].includes(objectClass(direct));
    if (mask & 2)
        enabled = ![21, 60, 32, 41].includes(objectClass(direct));
    if (mask & 32 && objectClass(direct) === 21)
        enabled = true;
    if (!(mask & 1) && !(targetFlags & 2048))
        enabled = false;
    if (!(mask & 4) && (targetFlags & 512))
        enabled = false;
    if (!(mask & 8) && (targetFlags & 2))
        enabled = false;
    if (mask & 16 && !(targetFlags & 514))
        enabled = false;
    const available = Number(flags.functionEnable1 ?? 0), target = noid(direct), receiver = noid(tool), actions: MenuItem[] = [];
    const add = (bit: number, label: string, id: number, values: WireFields = {}) => { if ((bit === 4 || enabled) && (available & bit))
        actions.push(item(label, id, receiver, values, { form: true })); };
    add(1, 'Engrave item...', 5302, { target });
    add(2, "Edit 'Tell Me About' Info...", 5306, { target });
    add(4, 'Create Object', 5310, { classno: 27 });
    add(16, 'Modify Object', 5322, { item: target });
    add(8, 'Duplicate Object', 5314, { target, count: 1 });
    add(32, 'Destroy Object', 5318, { target });
    add(64, 'Modify Colors', 5333, { target });
    if (actions.length)
        entries.push(group('Builder', actions));
}
function menuIds(items: MenuItem[], output = new Set<number>()) {
    for (const entry of items) {
        if (entry.items)
            menuIds(entry.items, output);
        else if (entry.id !== undefined)
            output.add(Number(entry.id));
    }
    return output;
}
// Keep generated forms out of the primary native menu and avoid duplicate leaves.
function appendAdvancedActions(entries: MenuItem[], object: WorldObject | null | undefined, actor: WorldObject | null | undefined, state: WorldState) {
    if (!state.advanced)
        return;
    const used = menuIds(entries), groups = new Map<string, MenuItem[]>();
    for (const action of getActions(objectClass(object))) {
        if (used.has(action.id))
            continue;
        const target = action.receiver === 'region' ? 0 : action.receiver === 'actor' ? Number(state.actorNoid) : noid(object);
        const values = fieldDefaults(action, { actorNoid: state.actorNoid, targetNoid: noid(object), containerNoid: state.actorNoid, position: fields(actor).position ?? [0, 0, 0], classNumber: objectClass(object) });
        const leaf = item(action.label, action.id, target, values, { form: true });
        if (!groups.has(action.category))
            groups.set(action.category, []);
        groups.get(action.category)!.push(leaf);
    }
    const items = [...groups].map(([label, items]) => group(label, items));
    if (items.length)
        entries.push(group('Other actions...', items));
}
/** Returns inert menu data. Consumers render nested submenus and dispatch a leaf
 * through the existing action codec; the authoritative server checks permission. */
export function getObjectMenu(object: WorldObject | null | undefined, state: WorldState = {}, walkDestination?: readonly number[]) {
    if (!object)
        return { label: '', items: [] };
    const actor = actorOf(state), walk = helper('Walk to', 'walk-to', noid(object));
    try {
        // A scene menu retains the ground point that opened it. Object verbs
        // still approach their native target; an explicit Walk to follows the click.
        if (walkDestination !== undefined)
            walk.fields = nativeGroundWalkRequest(walkDestination, state).fields;
        else
            nativeObjectWalkRequest(object, state);
        walk.disabled = false;
    }
    catch {
        walk.disabled = true;
    }
    const entries: MenuItem[] = [walk];
    if ([21, 22].includes(objectClass(object)) && actor) {
        const items = [...entries, ...avatarMenu(object, actor, state)];
        appendAdvancedActions(items, object, actor, state);
        return { label: objectName(object), items };
    }
    if (actor) {
        appendCarry(entries, object, actor, state);
        classMenu(entries, object, actor, state);
        appendHeldVerbs(entries, object, actor, state);
    }
    appendObjectTail(entries, object, actor, state);
    appendAdvancedActions(entries, object, actor, state);
    return { label: objectName(object), items: entries };
}
/** Fallback remains explicit, so original menu labels stay unchanged. */
export function getAdvancedObjectActions(object: WorldObject | null | undefined) { return getActions(objectClass(object)).filter((action: ActionDescriptor) => getAction(action.id)); }
