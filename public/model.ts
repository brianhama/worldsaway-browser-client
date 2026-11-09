/** Display projections of bridge snapshots; these helpers do not send world actions. */
import type { WireFields, WorldState, WorldObject, RuntimeEvent } from './types.js';
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (ch: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch]));
export function objectName(object: WorldObject | null | undefined) { return object?.fields?.name || object?.name || (object ? `Object ${object.noid}` : 'World'); }
export function objectClass(object: WorldObject | null | undefined) { return Number(object?.classNumber ?? object?.fields?.classNumber ?? 0); }
export function isActor(object: WorldObject | null | undefined) { return [21, 22, 40, 200].includes(objectClass(object)); }
export function objectParent(object: WorldObject | null | undefined) { return Number(object?.fields?.container_noid ?? object?.container_noid ?? 0); }
/** Follow containment transitively, independent of object ordering in a snapshot. */
export function inventoryObjects(state: WorldState) {
    if (state.actorNoid === null || state.actorNoid === undefined || !Number.isInteger(Number(state.actorNoid)) || Number(state.actorNoid) <= 0)
        return [];
    const owned = new Set([Number(state.actorNoid)]), result: WorldObject[] = [];
    // A bounded fixed-point walk also terminates for malformed containment graphs.
    for (let pass = 0; pass <= (state.objects?.length ?? 0); pass++) {
        let changed = false;
        for (const object of state.objects ?? [])
            if (Number(object.noid) !== Number(state.actorNoid) && !owned.has(Number(object.noid)) && owned.has(objectParent(object))) {
                owned.add(Number(object.noid));
                result.push(object);
                changed = true;
            }
        if (!changed)
            break;
    }
    return result.sort((a, b) => Number(a.fields?.position?.[0] ?? 0) - Number(b.fields?.position?.[0] ?? 0));
}
/** Permit ordinary web links only, without embedded credentials or active schemes. */
export function safeUrl(value: unknown) {
    try {
        const url = new URL(value as string);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    }
    catch {
        return null;
    }
}
/** Map known native replies/notices to transcript entries; unknown messages stay inspectable as data. */
export function noticeText(event: RuntimeEvent, objects: WorldObject[] = []) {
    const fields = event.fields ?? event.values ?? {}, id = Number(event.id ?? event.messageId);
    // Lifecycle/bootstrap fields reuse the name "success" for flags and must not
    // be interpreted as gameplay transaction results (avatar-list flag 1 is valid).
    if (Number(event.noid) === 10 || id === 145 || event.type === 'request' || event.type === 'decode-error')
        return null;
    const speaker = objects.find((object: WorldObject) => Number(object.noid) === Number(fields.speaker ?? event.noid));
    const author = fields.from || fields.realname || event.speakerName || objectName(speaker);
    if (fields.success !== undefined && Number(fields.success) !== 0) {
        const text = fields.fail_msg || (id === 111 ? `ESP to ${fields.to || 'that avatar'} was not delivered (code ${fields.success}).` : fields.text || fields.message) || `The server declined this action (code ${fields.success}).`;
        return { kind: 'error', author: 'World', text: String(text), id };
    }
    if ([73, 74].includes(id)) {
        const status = Number(event.requestId) === 1916 || Number(event.requestId) === 2003;
        const kind = status ? 'system' : Number(fields.type) === 1 ? 'think' : 'say';
        const speakerNoid = Number(fields.speaker ?? event.noid);
        // Both speech replies and peer notices carry the native balloon type.
        // Retain the speaker identity so the conversation pane can follow the
        // avatar even when names are duplicated or changed.
        return { kind, author, text: String(fields.text ?? ''), id,
            ...(!status && Number.isInteger(speakerNoid) && speakerNoid > 0 && speakerNoid <= 65535 ? { speakerNoid } : {}) };
    }
    if (id === 110)
        return { kind: 'esp', author: fields.from || author, text: String(fields.text ?? ''), id };
    if (id === 111)
        return { kind: 'esp', author: fields.to ? `You → ${fields.to}` : 'You', text: String(fields.text ?? ''), id };
    if (id === 243)
        return { kind: 'system', author: 'ESP', text: `${fields.to || 'The recipient'} is unavailable. You can send an ESP letter from Mail.`, id };
    if (id === 162 && safeUrl(fields.URL))
        return { kind: 'system', author: objectName(speaker), text: fields.URL, url: safeUrl(fields.URL), id };
    if ([104, 105, 106, 1203, 1204].includes(id)) {
        const text = fields.entryMsg || fields.exitMsg || '', url = safeUrl(fields.entryURL || fields.exitURL);
        return text || url ? { kind: 'system', author: 'World', text: text || url, url, id } : null;
    }
    if (id === 242)
        return { kind: 'system', author: 'Avatar lookup', text: fields.realname ? `Found ${fields.realname}.` : String(fields.fail_msg || 'No avatar found.'), id };
    if (id === 246)
        return { kind: 'mail', author: 'Mailbox', text: String(fields.text || fields.mail || fields.mailtext || 'No unread ESP mail.'), id };
    if (id === 248)
        return { kind: 'system', author: 'Mailbox', text: fields.who ? `New ESP mail from ${fields.who}.` : 'You have new ESP mail.', id };
    if (id === 4458)
        return { kind: 'mail', author: fields.sender || 'Postbox', text: String(fields.contents || `Received ${fields.numItems ?? 0} parcel items.`), id };
    if (id === 2802)
        return { kind: 'system', author: 'Bank', text: `Bank balance: ${Number(fields.balance).toLocaleString()} tokens.`, id };
    if (id === 2807)
        return { kind: 'system', author: 'Bank', text: `Deposited ${Number(fields.amount).toLocaleString()} tokens.`, id };
    if (id === 2812)
        return { kind: 'system', author: 'Bank', text: `Withdrew ${Number(fields.amount).toLocaleString()} tokens. Bank balance: ${Number(fields.balance).toLocaleString()} tokens.`, id };
    if (id === 2672)
        return { kind: 'system', author: objectName(speaker), text: `Vendroid stock: slot ${fields.next_slot}, ${fields.available} available.`, id };
    if (id === 1712)
        return { kind: 'system', author: 'Pockets', text: String(fields.contentsData || 'Your pockets are empty.'), id };
    if (id === 2736)
        return { kind: 'document', author: objectName(speaker), text: String(fields.contents || 'The binder is empty.'), id };
    if (id === 4002)
        return { kind: 'system', author: 'Rental plan', text: String(fields.plan_info || 'No rental information returned.'), id };
    if (id === 4017)
        return { kind: 'system', author: 'Rent quote', text: `Rent: ${fields.rent} tokens. Due: ${fields.rent_due}. Maximum advance: ${fields.max_rent}.`, id };
    if (id === 70 && Number(event.requestId) === 244)
        return { kind: 'system', author: 'Mailbox', text: 'The world accepted your ESP letter.', id };
    if ([77, 118, 2780].includes(id))
        return { kind: id === 2780 ? 'document' : 'system', author: objectName(speaker), text: String(fields.text ?? fields.TMAtext ?? fields.description ?? fields.contents ?? fields.message ?? ''), id };
    if (fields.fail_msg)
        return { kind: 'system', author: 'World', text: String(fields.fail_msg), id };
    return null;
}
export function displayFields(fields: WireFields) {
    return Object.entries(fields ?? {}).filter(([key]) => !/^(contentsVector|data|patchData|blob|resourceData|dummyfield[a-z]*|unused)$/.test(key)).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
}
export const slotName = (n: unknown) => (({ 0: 'Hand', 1: 'Head', 2: 'Tokens', 3: 'Clothing' } as Record<number, string>)[Number(n)] ?? `Pocket ${Number(n) - 3}`);
/** Native clients apply successful sender acknowledgements locally even when the
 * server broadcasts the matching notice only to other clients. Keep that view
 * stable across later snapshots without inventing a successful operation. */
export function projectAcknowledgedFacing(state: WorldState, tracker: {
    orientations?: Map<number, number>;
    sequence?: number;
}) {
    tracker.orientations ??= new Map();
    tracker.sequence ??= 0;
    if (state.status === 'disconnected' && !(state.objects?.length)) {
        tracker.orientations.clear();
        tracker.sequence = 0;
        return state;
    }
    for (const event of state.history ?? []) {
        if (event.seq <= tracker.sequence)
            continue;
        tracker.sequence = event.seq;
        if (event.type !== 'message')
            continue;
        const id = Number(event.id ?? event.messageId), f = event.fields ?? {};
        if (id === 101) {
            tracker.orientations.clear();
            continue;
        }
        if (f.success !== undefined && Number(f.success) !== 0)
            continue;
        if (id === 70 && Number(event.requestId) === 1688) {
            const request = [...(state.history ?? [])].reverse().find((r) => r.type === 'request' && r.id === 1688 && r.noid === Number(event.requestNoid ?? event.noid) && r.seq < event.seq);
            if (request && Number.isInteger(request.fields?.facing))
                tracker.orientations.set(Number(request.noid), Number(request.fields!.facing));
        }
        if ([1689, 1595, 1596].includes(id) && Number.isInteger(f.facing) && f.facing !== 65535)
            tracker.orientations.set(Number(event.noid), Number(f.facing));
        if ([191, 192].includes(id) && Number.isInteger(f.orientation))
            tracker.orientations.set(Number(f.item), Number(f.orientation));
    }
    return { ...state, objects: (state.objects ?? []).map((object: WorldObject) => tracker.orientations!.has(Number(object.noid)) ? { ...object, fields: { ...object.fields, orientation: tracker.orientations!.get(Number(object.noid)) } } : object) };
}
