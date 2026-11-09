/** A resolved device price or a descriptor for one of the supported server quote flows. */
interface PaymentQuote {
    id: number;
    noid: number;
    cost: number | null | undefined;
    source: string | undefined;
    clearHand: string;
    requiresQuote?: boolean;
    quoteKind?: string;
    quoteKey?: string;
    nameChanges?: number;
    address?: string;
    quoted?: boolean;
    details?: Record<string, unknown>;
}
import type { WireFields, WorldState, WorldObject, RuntimeEvent, ActionRequest, ApiRequest, StateProvider, ControllerOptions, PendingReply } from './types.js';
/** Native getTokensFromPocket / command1138 equivalents, without Tcl execution.
 * Sources: 000c0003.tcl:18-35,196-268; 00050043,00050450,00050459,
 * 0005045f. This prepares inventory only. The caller sends the final purchase.
 */
import { parseTclList } from './documents.js';
export class PaymentError extends Error {
    declare name: string;
    constructor(message: string) { super(message); this.name = 'PaymentError'; }
}
export class PaymentCancelledError extends PaymentError {
    declare name: string;
    silent!: boolean;
    constructor(message = 'The pending payment preparation was cancelled.') { super(message); this.name = 'PaymentCancelledError'; this.silent = true; }
}
const f = (object: WorldObject | null | undefined) => object?.fields ?? object ?? {};
const oid = (object: WorldObject | null | undefined) => Number(object?.noid ?? f(object).noid);
const klass = (object: WorldObject | null | undefined) => Number(object?.classNumber ?? f(object).classNumber);
const lookup = (state: WorldState, noid: unknown) => (state.objects ?? []).find((object: WorldObject) => oid(object) === Number(noid));
const child = (state: WorldState, parent: unknown, slot: unknown) => (state.objects ?? []).find((object: WorldObject) => Number(f(object).container_noid) === Number(parent) && Number(f(object).position?.[0]) === Number(slot));
const sequence = (state: WorldState) => Math.max(0, ...(state.history ?? []).map((event: RuntimeEvent) => Number(event.seq) || 0));
const regionKey = (state: WorldState) => { const region = f(state.region ?? lookup(state, 0)); return `${state.worldName ?? ''}|${state.avatar ?? ''}|${region.name ?? ''}|${region.imageURL ?? ''}|${region.areaCode ?? ''}`; };
const money = (value: unknown, label: string) => { const n = Number(value); if (value === undefined || value === null || value === '' || !Number.isSafeInteger(n) || n < 0 || n > 0x7fffffff)
    throw new PaymentError(`The native ${label} is unavailable or invalid.`); return n; };
const fieldCost = (object: WorldObject | null | undefined, key: string) => money(f(object)[key], `${key} price`);
const amount = (object: WorldObject | null | undefined) => klass(object) === 26 ? money(f(object).denom, 'token amount') : 0;
// Fixed object prices plus the two explicitly implemented native quote flows.
// Cashier20504 still needs its preceding bill workflow and is not guessed.
export const NATIVE_PAYMENT_REQUESTS = Object.freeze([1202, 2675, 2924, 3301, 4005, 4009, 4361, 4403, 9908, 20907, 21004, 21304]);
const requests = new Set(NATIVE_PAYMENT_REQUESTS);
/** Registry prices use the last entry for later changes; -1 is a refusal, not a price. */
export function nativeRegistryCost(priceList: unknown, nameChanges: unknown) {
    const count = money(nameChanges, 'name-change counter');
    if (count > 255)
        throw new PaymentError('The native name-change counter is invalid.');
    if (typeof priceList !== 'string')
        throw new PaymentError('The registry returned no native price list.');
    let words;
    try {
        words = parseTclList(priceList || '0', { maxElements: 4096, maxDepth: 8 });
    }
    catch {
        throw new PaymentError('The registry returned an invalid native price list.');
    }
    if (!words.length)
        throw new PaymentError('The registry returned an empty native price list.');
    const prices = words.map((word) => { if (!/^-?\d+$/.test(word))
        throw new PaymentError('The registry returned a nonnumeric native price list.'); const value = Number(word); if (!Number.isSafeInteger(value) || value < -1 || value > 0x7fffffff)
        throw new PaymentError('The registry returned an invalid native price list amount.'); return value; });
    const cost = prices[Math.min(count, prices.length - 1)];
    if (cost === -1)
        throw new PaymentError('The registry does not permit any more name changes.');
    return cost;
}
/** Accept only an explicit amount within the server quote and in whole rent increments. */
export function nativeRentPayment(quote: WireFields, payAmount: unknown) {
    const rent = money(quote?.rent, 'quoted rent'), due = money(quote?.rent_due, 'quoted rent due'), maximum = money(quote?.max_rent, 'quoted maximum rent');
    if (!rent || !maximum || due > maximum)
        throw new PaymentError('The world returned an unavailable or invalid rent quote.');
    const cost = money(payAmount, 'rent payment amount');
    if (!cost || cost % rent !== 0 || cost < due || cost > maximum)
        throw new PaymentError(`Pay a positive multiple of ${rent} tokens, at least ${due} and at most ${maximum}.`);
    return cost;
}
/** Resolve only known native price rules. Missing stock or unsupported totals are errors. */
export function nativePaymentQuote(item: ActionRequest, state: WorldState): PaymentQuote | null {
    const id = Number(item?.id ?? item?.messageId);
    if (!requests.has(id))
        return null;
    const target = lookup(state, item.noid);
    if (!target)
        throw new PaymentError('The payment device is not available in this region.');
    const fields = item.fields ?? item.values ?? {}, p = f(target);
    let cost, source, clearHand = 'positive';
    switch (id) {
        case 1202: { // 000504b2 initialization and 000504b8 command.
            if (klass(target) !== 56)
                throw new PaymentError('This is not a native teleporter.');
            const raw = fieldCost(target, 'rideCost');
            cost = raw === 0 ? 1 : raw === 65535 ? 0 : raw;
            source = '000504b2/000504b8:rideCost';
            break;
        }
        case 2675: { // 00050a28 derives displayed price from child.salePrice.
            if (klass(target) !== 57)
                throw new PaymentError('This is not a native Vendroid.');
            const slot = Number(fields.slot);
            if (!Number.isInteger(slot) || slot < 0 || slot >= Number(p.reducedCapacity ?? 10))
                throw new PaymentError('Choose a valid native Vendroid slot.');
            const stock = child(state, oid(target), slot);
            if (!stock)
                throw new PaymentError('The selected Vendroid stock is unavailable.');
            cost = fieldCost(stock, 'salePrice');
            source = `00050a28/00050a2d:stock(${slot}).salePrice`;
            clearHand = 'always';
            break;
        }
        case 2924: {
            if (klass(target) !== 52)
                throw new PaymentError('This is not a native name registry.');
            const count = money(f(lookup(state, state.actorNoid)).nameChanges, 'name-change counter');
            if (count > 255)
                throw new PaymentError('The native name-change counter is invalid.');
            const commonProps = Boolean(Number(p.common_flags ?? 0) & 1024);
            return Object.freeze({ id, noid: oid(target), cost: commonProps ? null : 0, source: '00050b58/00050b59:.priceList', clearHand: 'always', quoteKind: 'registry', requiresQuote: commonProps, quoteKey: `${count}:${commonProps}`, nameChanges: count });
        }
        case 3301: {
            if (klass(target) !== 34)
                throw new PaymentError('This is not a native body changer.');
            const body = Number(fields.body);
            if (!Number.isInteger(body) || body < 0 || body > 7)
                throw new PaymentError('Choose a valid native body style.');
            cost = fieldCost(target, `bodycost${body}`);
            source = `00050cf7:bodycost${body}`;
            clearHand = 'always';
            break;
        }
        case 4005: {
            if (klass(target) !== 46)
                throw new PaymentError('This is not a native home manager.');
            const plan = Number(fields.plan);
            if (!Number.isInteger(plan) || plan < 0 || plan > 7)
                throw new PaymentError('Choose a valid native rental plan.');
            cost = money(p.rent?.[plan] ?? p[`rent(${plan})`], `rent(${plan}) price`);
            source = `00050fa6:rent(${plan})`;
            clearHand = 'always';
            break;
        }
        case 4009: {
            if (klass(target) !== 46)
                throw new PaymentError('This is not a native home manager.');
            if (typeof fields.address !== 'string' || !fields.address.trim() || fields.address.length > 255 || fields.address.includes('\0'))
                throw new PaymentError('Enter the native home address to quote.');
            return Object.freeze({ id, noid: oid(target), cost: null, source: '00050fa9:4016/4017', clearHand: 'always', quoteKind: 'rent', requiresQuote: true, quoteKey: fields.address, address: fields.address });
        }
        case 4361:
            if (klass(target) !== 43)
                throw new PaymentError('This is not a native Gutenberg.');
            if (Number(fields.copies ?? 1) !== 1)
                throw new PaymentError('The recovered native print wrapper quotes exactly one copy; a multi-copy total is unavailable.');
            cost = fieldCost(target, 'cost');
            source = '0005110d:cost';
            clearHand = 'none';
            break;
        case 4403:
            if (klass(target) !== 47)
                throw new PaymentError('This is not a native newsstand.');
            cost = fieldCost(target, 'price');
            source = '00051132:price';
            clearHand = 'none';
            break;
        case 9908:
            if (klass(target) !== 98)
                throw new PaymentError('This is not a native engraver.');
            cost = fieldCost(target, 'salePrice');
            source = '000526af:salePrice';
            clearHand = 'always';
            break;
        case 20907:
            if (klass(target) !== 209)
                throw new PaymentError('This is not a native portkey.');
            cost = fieldCost(target, 'rideCost');
            source = '000551a6:rideCost';
            break;
        case 21004:
        case 21304:
            if (klass(target) !== (id === 21004 ? 210 : 213))
                throw new PaymentError('This is not the requested native game device.');
            cost = fieldCost(target, 'salePrice');
            source = `${id === 21004 ? '0005520a' : '00055336'}:salePrice`;
            clearHand = 'nontokens';
            break;
    }
    return Object.freeze({ id, noid: oid(target), cost, source, clearHand });
}
/** Spendable preparation funds are the actor's hand and reserved token pocket only. */
export function nativeAvatarTokens(state: WorldState) { const actor = lookup(state, state.actorNoid); if (!actor || klass(actor) !== 21)
    return 0; return amount(child(state, oid(actor), 0)) + amount(child(state, oid(actor), 2)); }
/** Await perform() before ObjectApproach.perform() and the final native action.
 * api must be the RAW bridge API, avoiding recursion through the UI wrapper.
 * Feed every authoritative state snapshot to ingestState(). No balance or
 * inventory update is applied optimistically, and no ATM withdrawal is made.
 */
export class PaymentPreparation {
    api!: ApiRequest;
    getState!: StateProvider;
    onError!: ((error: any) => void) | undefined;
    onQuote!: ((quote: PaymentQuote) => void) | undefined;
    timeout!: number;
    generation!: number;
    pending!: PendingReply | null;
    operation!: {
        generation: number;
        actor: number;
        region: string;
    } | null;
    lastQuote!: PaymentQuote | null;
    destroyed!: boolean;
    constructor({ api, getState, stateProvider, onError, onQuote, timeout = 15000 }: ControllerOptions & {
        onQuote?: (quote: PaymentQuote) => void;
    } = {}) {
        if (typeof api !== 'function')
            throw new TypeError('An action API is required');
        this.api = api;
        this.getState = getState ?? stateProvider ?? (() => ({}));
        this.onError = onError;
        this.onQuote = onQuote;
        this.timeout = timeout;
        this.generation = 0;
        this.pending = null;
        this.operation = null;
        this.lastQuote = null;
        this.destroyed = false;
    }
    cancel(reason: string = 'The pending payment preparation was cancelled.') {
        this.generation++;
        this.operation = null;
        this.lastQuote = null;
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            clearTimeout(pending.timer!);
            pending.reject(new PaymentCancelledError(reason));
        }
    }
    ingestState(state: WorldState) {
        if (!this.operation)
            return;
        if (state.status !== 'connected' || Number(state.actorNoid) !== this.operation.actor || regionKey(state) !== this.operation.region) {
            this.cancel('You changed connection, region or avatar before payment preparation completed.');
            return;
        }
        const pending = this.pending;
        if (!pending)
            return;
        for (const event of state.history ?? []) {
            if (event.type !== 'message' || Number(event.seq) <= pending.after || Number(event.id ?? event.messageId) !== pending.replyId)
                continue;
            // A successful HTTP submission does not confirm an inventory change.
            // Wait for the matching native reply, including Region-0 standard replies.
            const direct = Number(event.noid) === pending.noid, standard = Number(event.noid) === 0 && pending.replyId === 70 && Number(event.requestNoid) === pending.noid;
            if (!direct && !standard)
                continue;
            if (event.requestId !== undefined && Number(event.requestId) !== pending.id)
                continue;
            clearTimeout(pending.timer!);
            this.pending = null;
            const fields = event.fields ?? event.values ?? {};
            if (fields.success !== undefined && Number(fields.success) !== 0)
                pending.reject(new PaymentError(fields.fail_msg || `The world declined token preparation (code ${fields.success}).`));
            else
                pending.resolve(fields);
            break;
        }
    }
    waitFor(id: number, noid: unknown, fields: WireFields, replyId: number, generation: number) {
        if (generation !== this.generation)
            return Promise.reject(new PaymentCancelledError());
        const after = sequence(this.getState());
        return new Promise<WireFields>((resolve, reject) => {
            const pending: PendingReply = { id, noid: Number(noid), replyId, after, resolve, reject, timer: null };
            pending.timer = setTimeout(() => { if (this.pending === pending)
                this.pending = null; reject(new PaymentError('The world did not acknowledge token preparation in time.')); }, this.timeout);
            this.pending = pending;
            Promise.resolve().then(() => { if (generation !== this.generation)
                throw new PaymentCancelledError(); return this.api('/api/action', { noid: Number(noid), id, fields }); }).then((result: any) => this.ingestState(result?.state ?? this.getState())).catch((error: any) => { if (this.pending === pending) {
                clearTimeout(pending.timer!);
                this.pending = null;
                reject(error);
            } });
        });
    }
    async pocketHeld(generation: number) {
        const state = this.getState(), actor = lookup(state, state.actorNoid), held = child(state, oid(actor), 0);
        if (!held)
            return;
        if (klass(held) === 36 && !(Number(f(held).common_flags ?? 0) & 8))
            throw new PaymentError('Close the held container before preparing payment.');
        if (klass(held) !== 26) {
            // Avatar class21 pickFrom4; tokens have reserved avatarSlot2. Other classes
            // in this native snapshot have avatarSlot0 and use the general pocket.
            const capacity = Number(f(actor).reducedCapacity ?? 10);
            let free = false;
            for (let slot = 4; slot < capacity; slot++)
                if (!child(state, oid(actor), slot)) {
                    free = true;
                    break;
                }
            if (!free)
                throw new PaymentError('There is no room in your pocket for the held object.');
        }
        await this.waitFor(89, oid(held), { unused: 0 }, klass(held) === 26 ? 1156 : 90, generation);
        if (child(this.getState(), oid(actor), 0))
            throw new PaymentError('The world did not clear your hand after pocketing the held object.');
    }
    async perform(item: ActionRequest) {
        if (this.destroyed)
            throw new PaymentCancelledError('The payment preparation controller is closed.');
        this.cancel();
        const generation = this.generation, state = this.getState();
        let quote = nativePaymentQuote(item, state);
        if (!quote)
            return item;
        const actor = lookup(state, state.actorNoid);
        if (state.status !== 'connected' || !actor || klass(actor) !== 21)
            throw new PaymentError('Materialize before using a paid device.');
        this.operation = { generation, actor: oid(actor), region: regionKey(state) };
        try {
            if (quote.requiresQuote) {
                if (quote.quoteKind === 'registry') {
                    const reply = await this.waitFor(211, 0, { target: quote.noid, propname: '.priceList' }, 212, generation);
                    const cost = nativeRegistryCost(reply.propdata, quote.nameChanges);
                    quote = Object.freeze({ ...quote, cost, quoted: true, details: Object.freeze({ nameChanges: quote.nameChanges, priceList: String(reply.propdata ?? '') }) });
                }
                else {
                    const reply = await this.waitFor(4016, quote.noid, { address: quote.address }, 4017, generation);
                    const details = Object.freeze({ address: quote.address, rent: money(reply.rent, 'quoted rent'), rent_due: money(reply.rent_due, 'quoted rent due'), max_rent: money(reply.max_rent, 'quoted maximum rent') });
                    // This is browser-only state; pay_amount is never a native 4009 field.
                    this.lastQuote = Object.freeze({ ...quote, details });
                    this.onQuote?.(this.lastQuote);
                    const cost = nativeRentPayment(reply, (item.fields ?? item.values ?? {}).pay_amount ?? item.pay_amount);
                    quote = Object.freeze({ ...quote, cost, quoted: true, details });
                }
            }
            if (generation !== this.generation)
                throw new PaymentCancelledError();
            this.lastQuote = quote;
            this.onQuote?.(quote);
            const currentState = this.getState();
            if (Number(quote.cost) > nativeAvatarTokens(currentState))
                throw new PaymentError(`You need ${quote.cost} tokens in your hand or pocket to use this device.`);
            const held = child(currentState, oid(actor), 0);
            if (held && (quote.clearHand === 'always' || quote.clearHand === 'positive' && Number(quote.cost) > 0 || quote.clearHand === 'nontokens' && klass(held) !== 26))
                await this.pocketHeld(generation);
            if (generation !== this.generation)
                throw new PaymentCancelledError();
            if (Number(quote.cost) > 0) {
                const currentHeld = child(this.getState(), oid(actor), 0);
                if (currentHeld && klass(currentHeld) !== 26)
                    throw new PaymentError('Put the held object in your pocket before paying this device.');
                if (currentHeld)
                    await this.pocketHeld(generation);
                const pocket = child(this.getState(), oid(actor), 2), balance = amount(pocket);
                if (!pocket || balance < Number(quote.cost))
                    throw new PaymentError('The pocket token pile no longer covers this price.');
                if (balance === quote.cost)
                    await this.waitFor(97, oid(pocket), { unused: 0 }, 70, generation);
                else
                    await this.waitFor(1139, oid(pocket), { amount: quote.cost }, 1142, generation);
                // A reply alone is insufficient: the acknowledged snapshot must
                // contain exactly the intended token pile in the hand.
                const payment = child(this.getState(), oid(actor), 0);
                if (klass(payment) !== 26 || amount(payment) !== quote.cost)
                    throw new PaymentError('The world did not place the exact payment tokens in your hand.');
            }
            // Inventory preparation can take multiple round trips. Recheck the
            // device/quote identity before letting the caller send its purchase.
            const latest = this.getState(), current = nativePaymentQuote(item, latest)!;
            if (generation !== this.generation || regionKey(latest) !== this.operation?.region)
                throw new PaymentCancelledError();
            if (current.source !== quote.source || current.quoteKey !== quote.quoteKey || Boolean(current.requiresQuote) !== Boolean(quote.requiresQuote) || !quote.quoted && current.cost !== quote.cost)
                throw new PaymentError('The device price changed while preparing payment. Please choose the action again.');
            return item;
        }
        catch (error: any) {
            if (!(error instanceof PaymentCancelledError))
                this.onError?.(error);
            throw error;
        }
        finally {
            if (this.operation?.generation === generation)
                this.operation = null;
        }
    }
    destroy() { this.cancel('The payment preparation controller was closed.'); this.destroyed = true; }
}
export const PaymentController = PaymentPreparation;
