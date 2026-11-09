/** Browser composition root: bridge snapshots feed controllers, while visual
 * projections are composed separately for rendering. Native requests always
 * cross the bridge; this module does not decide authoritative world state. */
import type { WorldState, WorldObject, WorldEvent, ActionDescriptor, WireFields, WireField } from './types.js';
interface ApplicationState extends WorldState {
    status: string;
    objects: WorldObject[];
    history: WorldEvent[];
    avatars: {
        name: string;
        busy?: boolean;
    }[];
}
interface Preferences {
    sound: boolean;
    animation: boolean;
    pixelated: boolean;
    names: boolean;
    advanced: boolean;
    ignored: string;
    classicMode?: boolean;
    [key: string]: any;
}
interface ConversationEntry {
    kind: string;
    author: string;
    text: string;
    url?: string | null;
    time?: number;
    speakerNoid?: number;
    source?: 'wire' | 'presentation';
    presentationKey?: string;
}
import { ACTIONS, CLASSES, getAction, getActions, fieldDefaults, coerceActionValues, actionGroups, actionsForDefinition } from './actions.js';
import { WorldRenderer, activePresentationSpeech, type ObjectBounds } from './renderer.js';
import { ConversationPane } from './conversation.js';
import { RegionEntryTracker } from './region-entry.js';
import { BannerPresentations } from './presentations.js';
import { WorldAudio } from './audio.js';
import { createDocumentEditor } from './documents.js';
import { getObjectMenu, nativePageHelper } from './menus.js';
import { ObjectApproach, nativeApproachTargets, nativeWalkCoordinates, nativeGroundWalkRequest, nativeObjectWalkRequest } from './approach.js';
import { compatibleTargets, selectActionTarget, withPlayerName } from './targets.js';
import { PaymentPreparation, NATIVE_PAYMENT_REQUESTS } from './payments.js';
import { NPCController } from './npc.js';
import { WorldTcl } from './tcl-client.js';
import { bridgeRequest, prepareLogin } from './connection.js';
import { canRegister, rememberedConnection, submitRegistration } from './registration.js';
import { prepareSeatRequest } from './seating.js';
import { installNativeButtonImages } from './native-buttons.js';
import { nativeToolbarTurn } from './native-toolbar.js';
import { escapeHtml as esc, objectName, objectClass, objectParent, isActor, inventoryObjects, safeUrl, noticeText, displayFields, slotName, projectAcknowledgedFacing } from './model.js';
const $ = <T extends Element = any>(selector: string): T => document.querySelector<T>(selector)!;
const clientBanner = $<HTMLElement>('#client-banner');
function updateClientBannerHeight() {
    document.documentElement.style.setProperty('--client-banner-height', `${clientBanner.offsetHeight}px`);
}
updateClientBannerHeight();
new ResizeObserver(updateClientBannerHeight).observe(clientBanner);
const ALTAWAY_LAUNCHER_URL = 'https://altaway.xyz/';
let state: ApplicationState = { status: 'disconnected', objects: [], avatars: [], history: [] }, panel = 'room', selectedNoid: number | null = null, source: EventSource | null = null, lastSeq = 0, currentAction: ActionDescriptor | null = null, actionDialogGeneration = 0, toastTimer: ReturnType<typeof setTimeout> | undefined, config: any = {}, classMetadata: any = null, filter = '';
let approach: ObjectApproach, payments: PaymentPreparation, npc: NPCController, tcl: WorldTcl, preparationGeneration = 0;
let runtimeActions = new Map(ACTIONS.map((action) => [action.id, action])), runtimeClassActions = new Map(), metadataKey = '', metadataPending = false;
let connectionMode: 'login' | 'register' = 'login';
let sendingMessage = false;
let preferences: Preferences = { sound: false, animation: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, pixelated: true, names: false, advanced: false, ignored: '' };
let savedAnimationPreference = false;
try {
    const saved = JSON.parse(localStorage.getItem('altaway.preferences') || '{}');
    savedAnimationPreference = typeof saved.animation === 'boolean';
    preferences = { ...preferences, ...saved, animation: savedAnimationPreference ? saved.animation : preferences.animation };
}
catch { }
if (!preferences.classicMode) {
    preferences.names = false;
    preferences.classicMode = true;
}
const clientAcks = { sequence: 0, orientations: new Map() };
const conversation: ConversationEntry[] = [];
const conversationPane = new ConversationPane($('#chat-log'), $('#world-canvas'));
const presentationMessages = new Map<number, string>();
let conversationScene = '';
const regionEntries = new RegionEntryTracker();
let applyingState = false;
let scenePointer = { x: 100, y: 100 };
const renderer = new WorldRenderer($('#world-canvas'), { onSelect: (object, destination) => sceneSelect(object, destination), onMove: (x, y, z) => walkTo(x, y, z), onLayout: layoutConversation });
const worldAudio = new WorldAudio({ onError: (error: any) => console.warn('World audio:', error.message) });
tcl = new WorldTcl({ api: rawApi, getState: () => state, renderer, audio: worldAudio, onChange: () => renderer.setState(displayState()), onMessage: addScriptConversation, onError: (error: any) => { if (!error.silent)
        notify(error.message, true); } });
const documents = createDocumentEditor({ api, getState: () => state, onError: (error: any) => notify(error.message, true) });
approach = new ObjectApproach({ api: rawApi, getState: () => state });
payments = new PaymentPreparation({ api: rawApi, getState: () => state, onQuote: (quote: any) => { if (Number.isFinite(quote.cost))
        notify(`The world quotes ${quote.cost.toLocaleString()} tokens for this action.`);
    else if (quote.details)
        notify(`The home manager returned the rent quote; checking your chosen payment.`); } });
npc = new NPCController({ api: rawApi, getState: () => state });
const banners = new BannerPresentations({ api, getState: () => state, runTcl: (noid: any, which: any, ad: any) => tcl.presentation(noid, which, ad), onChange: () => renderer.setState(displayState()), onMessage: (message: any) => addConversation({ kind: 'system', author: 'Presentation', text: message }) });
/** Compose presentation and Tcl overlays without writing them into the snapshot. */
function displayState() { return { ...tcl.displayState(banners.displayState(state)), viewport: { width: 512, height: 288 } }; }
// Disconnect snapshots retain objects for diagnostics and native reconnection.
// Keep that stale scene hidden until a connected snapshot arrives.
function renderSceneConnection(online: boolean, reconnecting = false) {
    $('#world-canvas').hidden = !online;
    $('#scene-empty').hidden = online;
    $('#scene-bottom').hidden = !online;
    $('#scene-connect').disabled = reconnecting;
    $('#scene-connect').textContent = reconnecting ? 'Reconnecting to bridge…' : 'Connect to world...';
    if (!online)
        $('#object-context')?.remove();
}
function notify(message: string, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3500); }
// Invalidate continuations as well as controller work: an old quote or walk
// acknowledgement must not release a request after another action replaces it.
function cancelObjectPreparation() { preparationGeneration++; payments?.cancel(); npc?.cancel(); approach?.cancel(); return preparationGeneration; }
/** Run required native preparation before dispatching the caller's final action.
 * Controllers use rawApi for their intermediate requests to avoid re-entering
 * this preparation pipeline recursively. */
async function api(path: string, data?: any) {
    if (path === '/api/action' && renderer.transitioning)
        throw new Error('Your avatar is still leaving the previous region.');
    if (path === '/api/action' && approach) {
        const id = Number(data?.id), paid = NATIVE_PAYMENT_REQUESTS.includes(id), talk = id === 20010, walk = nativeApproachTargets(data, state).length > 0;
        if (paid || talk || walk || id === 1570 || id === 103 || id === 2401) {
            const generation = cancelObjectPreparation();
            if (paid)
                await payments.perform(data);
            if (talk)
                await npc.perform(data);
            if (walk || id === 1570 || id === 103)
                await approach.perform(data);
            if (id === 2401)
                data = await prepareSeatRequest(data, state, { getImage: (noid: any) => tcl.host.image(noid), getState: () => state });
            if (generation !== preparationGeneration)
                throw Object.assign(new Error('A newer object action replaced this request.'), { silent: true });
        }
        if (id === 4009 && data.fields) {
            const { pay_amount, ...fields } = data.fields;
            data = { ...data, fields };
        }
    }
    return rawApi(path, data);
}
async function rawApi(path: string, data?: any) { return bridgeRequest(path, data); }
function show(id: any) { const dialog = $(id); if (!dialog.open)
    dialog.showModal(); }
function close(id: any) { if (id === '#action-dialog') {
    actionDialogGeneration++;
    cancelObjectPreparation();
} $(id).close(); }
function requireConnected() { if (renderer.transitioning) {
    notify('Your avatar is still leaving the previous region.');
    return false;
} if (state.status === 'connected')
    return true; notify('Connect and enter an avatar first.'); if (state.status === 'avatars')
    show('#avatar-dialog');
else
    show('#connect-dialog'); return false; }
function actor() { if (state.actorNoid === null || state.actorNoid === undefined)
    return; return state.objects.find((o) => Number(o.noid) === Number(state.actorNoid)); }
function selection() { if (selectedNoid === null || selectedNoid === undefined)
    return; return state.objects.find((o) => Number(o.noid) === Number(selectedNoid)); }
function className(object: any) { return object?.className || classMetadata?.classes?.find((c: any) => Number(c.classNumber) === objectClass(object))?.name || CLASSES.find((c) => c.classNumber === objectClass(object))?.name || `Class ${objectClass(object)}`; }
function icon(object: WorldObject | undefined) { return ({ 20: '⌂', 21: '♙', 22: '♧', 24: '♙', 26: '◉', 33: '▤', 36: '▣', 37: '▧', 38: '⇥', 39: '↕', 40: '♙', 46: '⌂', 50: '✉', 53: '▰', 54: '≡', 56: '⌁', 57: '▦', 200: '♙', 201: '♧', 209: '⌁', 210: '▦', 215: '✧' })[objectClass(object)] || '◇'; }
function listRows(objects: any, { slots = false }: any = {}) { return objects.map((object: any) => `<button class="object-row ${Number(selectedNoid) === Number(object.noid) ? 'selected' : ''}" data-object="${Number(object.noid)}"><span class="object-icon">${icon(object)}</span><span><strong>${esc(objectName(object))}${Number(object.noid) === Number(state.actorNoid) ? ' <small>(you)</small>' : ''}</strong><small>${esc(slots ? slotName(object.fields?.position?.[0] ?? 0) : className(object))}</small></span><span class="chevron" aria-hidden="true">›</span></button>`).join(''); }
function emptyPanel(title: any, text: any, symbol: any = '◇') { return `<div class="panel-empty"><span>${symbol}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`; }
function fieldsTable(fields: any) { return `<dl class="field-table">${displayFields(fields).map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`; }
function actionButtons(actions: any) { return actions.map((action: any) => `<button class="action-button ${action.danger ? 'danger-button' : ''}" data-action="${action.id}"><span>${esc(action.label)}</span><small>↗</small></button>`).join(''); }
function lookupAction(id: any) { return runtimeActions.get(Number(id)) ?? getAction(id); }
// Keep the authored catalog as a fallback, then overlay contracts supplied by
// the connected world. These schemas describe requests, not permission grants.
function acceptMetadata(metadata: any) {
    classMetadata = metadata;
    runtimeActions = new Map(ACTIONS.map((action) => [action.id, action]));
    runtimeClassActions = new Map();
    for (const definition of metadata?.classes ?? []) {
        const actions = actionsForDefinition(definition, metadata.messages ?? []);
        runtimeClassActions.set(Number(definition.classNumber), actions);
        for (const action of actions)
            runtimeActions.set(action.id, action);
    }
}
async function refreshMetadata() {
    if (metadataPending || !['connected', 'avatars'].includes(state.status))
        return;
    const key = `${state.worldName}:${state.resources?.received}:${state.resources?.total}:${state.resources?.complete}`;
    if (key === metadataKey)
        return;
    metadataPending = true;
    try {
        acceptMetadata(await api('/api/classes'));
        metadataKey = key;
        renderPanel();
    }
    catch { }
    finally {
        metadataPending = false;
    }
}
function objectActions(object: WorldObject) {
    const ownActor = Number(object.noid) === Number(state.actorNoid), parent = objectParent(object), slot = Number(object.fields?.position?.[0] ?? 0);
    return (runtimeClassActions.get(objectClass(object)) ?? getActions(objectClass(object))).filter((action: any) => {
        if (action.admin && !preferences.advanced)
            return false;
        if (isActor(object) && !ownActor && action.receiver === 'actor')
            return false;
        if (action.id === 89 && !(parent === Number(state.actorNoid) && slot === 0))
            return false;
        if (action.id === 97 && !(parent === Number(state.actorNoid) && slot !== 0))
            return false;
        if (action.id === 93 && parent === 0)
            return false;
        return true;
    });
}
function responseTitle(event: any) { return lookupAction(event.requestId)?.label ?? [...runtimeActions.values()].find((action) => action.replyId === Number(event.id))?.label ?? `Message ${event.id}`; }
function responseCard(event: any) { const text = noticeText(event, state.objects); return `<details class="event-card"><summary>${esc(responseTitle(event))} <span class="protocol-tag">#${event.noid}</span></summary>${text?.text ? `<div class="reply-banner">${esc(text.text)}</div>` : ''}${fieldsTable(event.fields)}</details>`; }
function selectedCard(object: any) {
    const actions = objectActions(object), primaryIds = [76, 97, 89, 2801, 2671, 2675, 2561, 2565, 4457, 2781, 2735, 2351, 1202, 20907, 2401, 3201, 3601, 20602, 20010, 20103, 20105];
    const primary = actions.filter((action: any) => primaryIds.includes(action.id)).slice(0, 6), secondary = actions.filter((action: any) => !primary.includes(action));
    const groups = Object.entries(actionGroups(secondary)).map(([category, items]) => `<details><summary>${esc(category)} <span class="protocol-tag">${items.length}</span></summary><div class="action-list">${actionButtons(items)}</div></details>`).join('');
    const replies = state.history.filter((event) => event.type === 'message' && (Number(event.requestNoid ?? event.noid) === Number(object.noid))).slice(-6).reverse();
    const physical = objectClass(actor()) === 21, roomObject = objectParent(object) === 0;
    const link = safeUrl(banners.current(object.noid)?.link || object.fields?.URL || object.fields?.url);
    const extras = (objectClass(object) === 37 ? '<button class="secondary-button" data-quick="document">Read / edit document</button>' : '') + (objectClass(object) === 61 ? '<button class="secondary-button" data-quick="presentation">Start presentation</button>' : '') + (link ? `<a class="secondary-button full-width" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(object.fields?.URLlabel || 'Open link')} ↗</a>` : '');
    return `<section class="selected-card"><div class="selected-heading"><h3>${esc(objectName(object))}</h3><button class="text-button" data-deselect aria-label="Clear object selection">×</button></div><small>${esc(className(object))} <span class="protocol-tag">#${object.noid}</span></small><div class="action-list">${actionButtons(primary)}</div>${(objectClass(object) !== 20 && !isActor(object)) ? `<div class="quick-grid">${roomObject ? `<button data-quick="pickup" ${physical ? '' : 'disabled'}>Pick up</button>` : ''}${[36, 59, 201].includes(objectClass(object)) ? `<button data-action="1608" ${physical ? '' : 'disabled'}>Open</button><button data-action="1611" ${physical ? '' : 'disabled'}>Close</button>` : ''}</div>` : ''}${extras}${groups}${replies.length ? `<details open><summary>Latest replies</summary>${replies.map(responseCard).join('')}</details>` : ''}<details><summary>Object details</summary>${fieldsTable(object.fields)}</details></section>`;
}
function renderPanel() {
    const content = $('#panel-content'), active = document.activeElement;
    if (content.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName ?? ''))
        return;
    const titles: Record<string, string> = { room: 'In this room', inventory: 'Your pockets', people: 'People nearby', travel: 'Find your way', mail: 'Your mailbox', avatar: 'Your avatar', tools: 'World tools' };
    $('#panel-title').textContent = titles[panel];
    const object = selection(), objects = state.objects ?? [], online = state.status === 'connected';
    let html = '', count = '';
    if (!online) {
        html = emptyPanel('A place to belong.', 'The people and things around you will appear here when you connect.', '⌂');
        count = '0';
    }
    else if (panel === 'room') {
        const visible = objects.filter((o) => Number(o.noid) !== 0 && objectParent(o) === 0 && !(objectClass(o) === 22 && (Number(o.fields?.common_flags ?? 0) & 1)));
        html = listRows(visible) || emptyPanel('A quiet corner.', 'There are no objects in this room yet.', '⌂');
        count = String(visible.length);
        if (object)
            html += selectedCard(object);
    }
    else if (panel === 'inventory') {
        const inventory = inventoryObjects(state), tokens = inventory.filter((o) => objectClass(o) === 26).reduce((sum, o) => sum + Number(o.fields?.denom ?? 0), 0);
        count = String(inventory.length);
        html = `<div class="money">${tokens.toLocaleString()} <small>pocket tokens</small></div><div class="quick-grid"><button data-quick="pockets">List pockets</button><button data-quick="drop">Drop held item</button></div>${listRows(inventory, { slots: true }) || '<p class="panel-text">Your pockets are empty. Select an object in the room to pick it up.</p>'}`;
        if (object)
            html += selectedCard(object);
        const pocketReply = [...state.history].reverse().find((e) => Number(e.id) === 1712 && e.fields?.contentsData);
        if (pocketReply)
            html += `<details open><summary>Pocket contents</summary><div class="reply-banner">${esc(pocketReply.fields?.contentsData)}</div></details>`;
    }
    else if (panel === 'people') {
        const people = objects.filter((o) => isActor(o) && !(objectClass(o) === 22 && (Number(o.fields?.common_flags ?? 0) & 1)));
        count = String(people.length);
        html = listRows(people) || emptyPanel('Room to yourself.', 'Other avatars will appear here when they arrive.', '♧');
        html += `<div class="panel-label">Keep in touch</div><div class="quick-grid"><button data-quick="esp">Send ESP</button><button data-action="241">Find avatar</button></div>`;
        if (object && isActor(object))
            html += `<div class="quick-grid"><button data-quick="esp-selected">ESP ${esc(objectName(object))}</button><button data-quick="ignore">${isIgnored(objectName(object)) ? 'Unignore' : 'Ignore'}</button></div>` + selectedCard(object);
    }
    else if (panel === 'travel') {
        const exits = state.region?.fields?.validExits ?? [];
        html = `<div class="panel-label">Room exits</div><div class="quick-grid">${['North ↑', 'East →', 'South ↓', 'West ←'].map((name, index) => `<button data-exit="${index}" ${Number(exits[index]) === 0 ? 'disabled' : ''}>${name}</button>`).join('')}</div><div class="panel-label">Travel objects</div>${listRows(objects.filter((o) => [38, 39, 56, 204, 209].includes(objectClass(o)))) || '<p class="panel-text">No travel devices are visible here. Use the room exits to explore.</p>'}<div class="panel-label">Home & tours</div><div class="action-list">${actionButtons([124, 171, 175, 179, 183].map(lookupAction).filter(Boolean))}</div>`;
        if (object)
            html += selectedCard(object);
    }
    else if (panel === 'mail') {
        html = `<div class="quick-grid"><button data-quick="read-mail">Read new mail</button><button data-quick="compose-mail">Write a letter</button></div><div class="panel-label">Letters received this session</div>`;
        const mail = conversation.filter((e) => e.kind === 'mail');
        html += mail.length ? mail.map((e) => `<article class="mail-item">${esc(e.text || 'No unread letters.')}</article>`).join('') : '<p class="panel-text">Read your mailbox to collect new ESP letters. Use a Postbox in the room for physical parcels.</p>';
        html += `<div class="panel-label">Physical mail</div>${listRows(objects.filter((o) => objectClass(o) === 50))}`;
        count = String(mail.length);
        if (object && objectClass(object) === 50)
            html += selectedCard(object);
    }
    else if (panel === 'avatar') {
        const self = actor(), ghost = objectClass(self) === 22;
        html = `<div class="panel-label">${esc(state.avatar)}</div><p class="panel-text">${ghost ? 'You are exploring as a ghost. Materialize to speak, carry things, and make the world your own.' : 'You are here, in the world. Express yourself with moods, gestures, and a change of look.'}</p><button class="secondary-button" data-quick="${ghost ? 'materialize' : 'ghost'}">${ghost ? 'Materialize' : 'Become a ghost'}</button><div class="panel-label">Express yourself</div><div class="quick-grid"><button data-gesture="0xF00B">Wave</button><button data-gesture="0xF00C">Bow</button><button data-gesture="0xF00D">Shrug</button><button data-gesture="jump_up">Jump</button></div><label for="avatar-mood">Mood</label><select id="avatar-mood">${['Normal', 'Happy', 'Sad', 'Mad', 'Asleep'].map((v, i) => `<option value="${i}" ${Number(self?.fields?.mood) === i ? 'selected' : ''}>${v}</option>`).join('')}</select><div class="panel-label">Information & preferences</div><div class="action-list">${actionButtons([lookupAction(1916), lookupAction(1688)].filter(Boolean))}</div><div class="quick-grid"><button data-status="55">Who is here?</button><button data-status="59">Token balance</button><button data-status="57">My status</button><button data-status="58">World time</button></div>`;
        if (self)
            html += selectedCard(self);
    }
    else if (panel === 'tools') {
        const found = [...runtimeActions.values()].filter((a) => (preferences.advanced || !a.admin) && (!filter || `${a.label} ${a.id} ${a.category}`.toLowerCase().includes(filter.toLowerCase())));
        count = String(found.length);
        html = `<label class="sr-only" for="action-search">Find an action</label><input class="search-input" id="action-search" type="search" placeholder="Find an action…" value="${esc(filter)}"><p class="panel-text">Select an object, then choose an action. Shared and staff actions can be enabled in Settings.</p><div class="panel-note">${classMetadata?.classes?.length ?? CLASSES.length} known classes · ${runtimeActions.size} recovered requests. The server checks your permissions and each request.</div>`;
        for (const [category, actions] of Object.entries(actionGroups(found)))
            html += `<details ${filter ? 'open' : ''}><summary>${esc(category)} <span class="protocol-tag">${actions.length}</span></summary><div class="action-list">${actionButtons(actions)}</div></details>`;
        html += `<details><summary>Recent world replies</summary>${state.history.filter((e) => e.type === 'message' && Number(e.noid) !== 10).slice(-40).reverse().map(responseCard).join('')}</details>`;
    }
    const scroll = content.scrollTop;
    content.innerHTML = html;
    content.scrollTop = scroll;
    $('#panel-count').textContent = count;
}
function setPanel(name: any) { $('#utility-window').hidden = false; panel = name; for (const button of document.querySelectorAll<HTMLElement>('[data-panel]'))
    button.classList.toggle('active', button.dataset.panel === name); renderPanel(); }
function selectObject(noid: any) { selectedNoid = noid === null ? null : Number(noid); renderer.setSelected?.(null); renderPanel(); }
function isIgnored(name: any) { return String(preferences.ignored).split(/\r?\n/).some((item) => item.trim().toLowerCase() === String(name).trim().toLowerCase()); }
function layoutConversation(bounds: readonly ObjectBounds[], width: number) {
    if (applyingState)
        return;
    conversationPane.layout(bounds, width);
    const now = Date.now(), scene = conversationScene;
    for (const bound of bounds) {
        const text = activePresentationSpeech(bound.object, now), speech = bound.object.fields?.presentationSpeech;
        if (!text || ![0, 1].includes(Number(speech.type ?? 0)))
            continue;
        const key = `${speech.until}:${speech.type ?? 0}:${text}`, noid = Number(bound.object.noid);
        if (presentationMessages.get(noid) === key)
            continue;
        presentationMessages.set(noid, key);
        // Rendering can be initiated by a Tcl patch. Append after this frame so
        // changing its quip never re-enters the renderer's layout callback.
        queueMicrotask(() => {
            if (conversationScene === scene)
                addConversation({ kind: Number(speech.type) === 1 ? 'think' : 'say', author: objectName(bound.object), text, speakerNoid: noid, source: 'presentation' });
        });
    }
}
function addScriptConversation(entry: ConversationEntry) {
    if (entry.presentationKey && entry.speakerNoid !== undefined) {
        if (presentationMessages.get(entry.speakerNoid) === entry.presentationKey)
            return;
        presentationMessages.set(entry.speakerNoid, entry.presentationKey);
    }
    addConversation(entry);
}
function addConversation(entry: ConversationEntry) {
    if (!entry?.text || isIgnored(entry.author))
        return;
    const time = Number.isFinite(entry.time) ? entry.time! : Date.now();
    // Native speech may also emit a Tcl balloon for the same wire message.
    // Keep that message once in the pane while preserving repeated wire speech.
    if (entry.source === 'presentation' && conversation.slice(-30).some(previous => previous.source === 'wire' && previous.speakerNoid === entry.speakerNoid && previous.kind === entry.kind && previous.text === entry.text && time - (previous.time ?? 0) < 10000))
        return;
    conversation.push({ ...entry, time });
    if (conversation.length > 1000)
        conversation.shift();
    const log = $('#chat-log'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
    if ($('.log-welcome'))
        log.replaceChildren();
    const div = document.createElement('div');
    div.className = `chat-entry ${entry.kind}`;
    const roomMessage = entry.kind === 'say' || entry.kind === 'think';
    if (roomMessage)
        div.setAttribute('aria-label', `${entry.author} ${entry.kind === 'think' ? 'thinks' : 'says'}`);
    const date = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<time class="chat-time">${esc(date)}</time><div class="message-content">${entry.kind === 'esp' || entry.kind === 'mail' ? `<span class="channel-label">${entry.kind}</span>` : ''}<span class="chat-author">${esc(entry.author)}</span><span class="message-text"></span></div>`;
    const body = div.querySelector('.message-text')!;
    body.textContent = entry.text;
    const url = entry.url && safeUrl(entry.url);
    if (url) {
        body.textContent = '';
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = entry.text;
        body.append(link);
    }
    log.append(div);
    if (roomMessage)
        conversationPane.add(div, entry.speakerNoid);
    while (log.children.length > 1000)
        log.firstChild?.remove();
    if (atBottom)
        log.scrollTop = log.scrollHeight;
    $('#chat-count').textContent = String(conversation.length);
    renderer.setConversationQuip(roomMessage && entry.speakerNoid ? { speakerNoid: entry.speakerNoid, type: entry.kind === 'think' ? 1 : 0, until: time + 10000 } : null);
}
/** Consume one complete bridge snapshot and feed every controller the same view.
 * History is retained across snapshots, so sequence numbers prevent duplicate
 * transcript entries when SSE repeats already observed events. */
function applyState(next: WorldState) {
    applyingState = true;
    const prior = state.status, wasGhost = objectClass(actor()) === 22;
    next = withPlayerName(projectAcknowledgedFacing(next, clientAcks));
    state = { ...next, status: next.status ?? 'disconnected', objects: next.objects ?? [], history: next.history ?? [], avatars: next.avatars ?? [] };
    const { scene, message: regionMessage } = regionEntries.ingest(state);
    if (scene !== conversationScene || state.status !== 'connected') {
        conversationScene = scene;
        $('#object-context')?.remove();
        conversationPane.resetScene();
        presentationMessages.clear();
        renderer.setConversationQuip(null);
    }
    for (const event of state.history) {
        if (event.seq <= lastSeq)
            continue;
        lastSeq = event.seq;
        if (event.type === 'request')
            continue;
        const entry = noticeText(event, state.objects);
        if (entry) {
            const at = event.at ?? event.time;
            addConversation({ ...entry, source: 'wire', time: typeof at === 'string' ? Date.parse(at) : at });
        }
        if (event.id === 184 && event.fields?.newURL) {
            const url = safeUrl(event.fields.newURL);
            if (url)
                addConversation({ kind: 'system', author: 'Web tour', text: url, url });
        }
        if (event.type === 'error')
            addConversation({ kind: 'error', author: 'Connection', text: event.fields?.reason || 'Connection closed.' });
    }
    const online = state.status === 'connected', self = actor(), busy = Number(state.tcl?.blockCount) > 0;
    if (wasGhost && objectClass(self) === 21 && $('#chat-channel').value === 'esp' && !$('#chat-to').value.trim())
        $('#chat-channel').value = 'say';
    const pageHelper = nativePageHelper(state);
    $('#page-helper-button').textContent = pageHelper.label;
    $('#page-helper-button').disabled = pageHelper.disabled;
    renderSceneConnection(online);
    $('#scene-badge').textContent = online ? 'LIVE WORLD' : state.status === 'avatars' ? 'CHOOSE AN AVATAR' : state.status === 'entering' ? 'ENTERING WORLD' : 'OFFLINE';
    $('#status-dot').classList.toggle('connected', online);
    $('#connection-label').textContent = online ? 'Connected' : ({ avatars: 'Choose an avatar', connecting: 'Connecting…', entering: 'Entering world…', error: 'Connection error' })[state.status] || 'Disconnected';
    $('#connect-button').textContent = online ? 'Disconnect' : 'Connect...';
    $('#native-window-title').textContent = `WorldsAway 2.4 - ${state.worldName || config.backendName || 'WorldsAway.app'}`;
    $('#world-name').textContent = online ? String(state.worldName || 'ALTAWAY').toUpperCase() : 'A SHARED VIRTUAL WORLD';
    $('#region-name').textContent = online ? objectName(state.region || state.objects.find((o) => Number(o.noid) === 0)) : 'Somewhere, together.';
    $('#world-meta').textContent = online ? `${objectsInRoom()} nearby · ${state.resources?.received ?? 0} resources` : 'Choose your world. Be yourself.';
    $('#actor-badge').textContent = self ? `${objectName(self)} · ${objectClass(self) === 22 ? 'Ghost' : 'Avatar'}` : state.avatar || '';
    $('#sidebar-footer-text').textContent = online ? `${state.avatar} · ${state.worldName || 'AltAway'}` : 'Original world. Browser window.';
    const seated = objectClass(state.objects.find(object => Number(object.noid) === objectParent(self))) === 53;
    $('#chat-text').disabled = !online || busy;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.native-toolbar>button')) {
        const ghost = objectClass(self) === 22;
        button.hidden = (button.dataset.quick === 'ghost' && ghost) || (button.dataset.quick === 'materialize' && !ghost);
        button.disabled = !online || busy || (button.dataset.quick === 'ghost' && ghost) || (button.dataset.quick === 'materialize' && !ghost)
            || (Boolean(button.dataset.gesture || button.dataset.mood || button.dataset.turn) && ghost)
            || (Boolean(button.dataset.turn) && !nativeToolbarTurn(state, button.dataset.turn!))
            || (seated && Boolean(button.dataset.gesture) && button.dataset.gesture !== '0xF00B');
    }
    channelChange();
    const exits = state.region?.fields?.validExits ?? [];
    for (const button of document.querySelectorAll<HTMLButtonElement>('.native-toolbar [data-exit]'))
        button.disabled = !online || busy || !Number(exits[Number(button.dataset.exit)]);
    if (selectedNoid !== null && !state.objects.some((o) => Number(o.noid) === selectedNoid))
        selectedNoid = null;
    payments.ingestState(state);
    npc.ingestState(state);
    approach.ingestState(state);
    documents.ingestState(state);
    worldAudio.ingestState(state);
    tcl.ingestState(state);
    banners.ingestState(state);
    applyingState = false;
    renderer.setState(displayState());
    refreshMetadata();
    if (renderer.setPreferences)
        renderer.setPreferences(preferences);
    renderPanel();
    renderTclConsole();
    if (state.status === 'avatars') {
        renderAvatars();
        if (!$('#connect-dialog').open)
            show('#avatar-dialog');
    }
    if (online) {
        const ghost = objectClass(self) === 22;
        const recipients = state.objects.filter(isActor).filter((o) => o.noid !== state.actorNoid && !(Number(o.fields?.common_flags ?? 0) & 1));
        $('#avatar-names').innerHTML = recipients.map((o) => `<option value="${esc(objectName(o))}"></option>`).join('');
        $('#recipient-pick').innerHTML = '<option value=""></option>' + recipients.map((o) => `<option value="${esc(objectName(o))}">${esc(objectName(o))}</option>`).join('');
        close('#avatar-dialog');
        close('#connect-dialog');
        if (regionMessage)
            addConversation(regionMessage);
    }
    if (state.error && state.error !== nextError) {
        nextError = state.error;
        notify(state.error, true);
    }
    if (!state.error)
        nextError = null;
}
let nextError: any = null;
function objectsInRoom() { return state.objects.filter((o) => isActor(o) && Number(o.noid) !== Number(state.actorNoid) && !(Number(o.fields?.common_flags ?? 0) & 1)).length; }
// Replace any previous EventSource when login changes the session cookie.
// EventSource reconnects the HTTP stream; native-world reconnect is a separate API.
function stream() {
    source?.close();
    source = new EventSource('/api/events');
    source.addEventListener('state', (event: any) => {
        try {
            applyState(JSON.parse(event.data));
        }
        catch (error: any) {
            console.error('State update failed', error);
        }
    });
    source.onerror = () => {
        renderSceneConnection(false, state.status === 'connected');
        if (state.status === 'connected')
            $('#connection-label').textContent = 'Reconnecting to bridge…';
    };
}
function renderAvatars() { const list = $('#avatar-list'); list.innerHTML = state.avatars.map((a) => `<button class="avatar-choice" data-avatar="${esc(a.name)}" ${a.busy ? 'disabled' : ''}><span aria-hidden="true">♙</span><strong>${esc(a.name)}</strong><small>${a.busy ? 'Already in world' : 'Enter'}</small></button>`).join('') || '<p class="panel-text">No avatars yet. Create your first one below.</p>'; $('#create-avatar-form').hidden = state.newAvatarAllowed === false || state.avatars.length >= state.capacity; }
$('#connect-form').addEventListener('submit', async (event: any) => {
    event.preventDefault();
    const button = $('#login-submit');
    button.disabled = true;
    button.textContent = connectionMode === 'register' ? 'Creating account…' : 'Connecting…';
    for (const selector of ['#sign-in-mode', '#create-account-mode', '#service-select', '#local-launcher']) $(selector).disabled = true;
    $('#connect-error').textContent = '';
    let submitted = false;
    const registering = connectionMode === 'register';
    const values: Record<string, any> = { ...Object.fromEntries(new FormData(event.currentTarget)), mode: 'launcher', launcherUrl: selectedLauncher() };
    const prepareSession = () => {
        submitted = true;
        source?.close(); lastSeq = 0; nextError = null; metadataKey = '';
        regionEntries.reset();
        clientAcks.sequence = 0; clientAcks.orientations.clear();
    };
    try {
        let result;
        if (registering) {
            if (!registrationAvailable()) throw new Error('Account creation is not available on this server.');
            result = await submitRegistration({ account: values.account, password: values.password,
                confirmation: values.confirmation, avatar: values.avatar, launcherUrl: values.launcherUrl }, async (path, data) => {
                prepareSession(); return api(path, data);
            });
        } else {
            const login = await prepareLogin(values, rawApi);
            prepareSession(); result = await api('/api/login', login);
        }
        clearConnectionPasswords();
        try {
            localStorage.setItem('altaway.connection', JSON.stringify(rememberedConnection({
                account: values.account, world: result.state?.worldName || values.world, launcherUrl: values.launcherUrl })));
        }
        catch { }
        close('#connect-dialog');
        if (result.created) updateConnectionMode('login');
        applyState(result.state);
        stream();
        if (result.state.status === 'avatars')
            show('#avatar-dialog');
        if (result.created) notify(`Account created. Welcome to ${result.state.worldName || 'WorldsAway.app'}!`);
    }
    catch (error: any) {
        $('#connect-error').textContent = error.message;
        if (submitted && registering) {
            // Registration failures can preserve a previous native session.
            // Reconnect its event stream rather than hiding that live session.
            try {
                const current = await rawApi('/api/state'); applyState(current);
                if (['connected', 'avatars', 'entering'].includes(current.status)) stream();
                show('#connect-dialog');
            } catch { applyState({ ...state, status: 'disconnected', objects: [] }); }
        } else if (submitted) applyState({ ...state, status: 'disconnected', objects: [] });
    }
    finally {
        button.disabled = false;
        for (const selector of ['#sign-in-mode', '#create-account-mode', '#service-select', '#local-launcher']) $(selector).disabled = false;
        button.textContent = connectionMode === 'register' ? 'Create account & enter' : 'Connect to world';
    }
});
function selectedLauncher(): string { return config.hosted ? config.launcherUrl || 'http://127.0.0.1:8080'
    : $('#service-select').value === 'worldsaway' ? $('#local-launcher').value.trim() || config.localLauncherUrl || 'http://127.0.0.1:8080' : ALTAWAY_LAUNCHER_URL; }
function selectedService(): string { return config.hosted ? config.backendName || 'WorldsAway.app' : $('#service-select').value === 'worldsaway' ? 'WorldsAway.app' : 'AltAway'; }
function registrationAvailable() { return canRegister(config, selectedService(), selectedLauncher()); }
function clearConnectionPasswords() { $('#password').value = ''; $('#password-confirmation').value = ''; }
function updateConnectionMode(mode: 'login' | 'register', focus = false) {
    connectionMode = mode === 'register' && registrationAvailable() ? 'register' : 'login';
    const registering = connectionMode === 'register';
    $('#connection-modes').hidden = !registrationAvailable();
    $('#sign-in-mode').setAttribute('aria-pressed', String(!registering));
    $('#create-account-mode').setAttribute('aria-pressed', String(registering));
    $('#registration-fields').hidden = !registering;
    $('#sign-in-world').hidden = registering;
    $('#world-select').disabled = registering;
    for (const selector of ['#password-confirmation', '#initial-avatar']) {
        $(selector).disabled = !registering; $(selector).required = registering;
    }
    $('#registration-account-note').hidden = !registering;
    $('#registration-password-note').hidden = !registering;
    $('#account').maxLength = registering ? 24 : 255;
    $('#password').maxLength = registering ? 24 : 255;
    $('#password').autocomplete = registering ? 'new-password' : 'current-password';
    $('#connect-title').textContent = registering ? `Create your ${selectedService()} account` : `Connect to ${selectedService()}`;
    $('#connect-intro').textContent = registering ? 'Choose an account name and your first avatar. Your new avatar will enter the world after registration.' : `Sign in with your ${selectedService()} server account.`;
    $('#login-submit').textContent = registering ? 'Create account & enter' : 'Connect to world';
    $('#connect-error').textContent = '';
    if (!registering) $('#password-confirmation').value = '';
    if (focus) $('#account').focus();
}
function clearWorlds() { const select = $('#world-select'); select.replaceChildren(new Option('Default world', '')); $('#world-directory-note').textContent = `Load the directory to choose a ${selectedService()} world.`; }
function updateServiceChoice() {
    const local = !config.hosted && $('#service-select').value === 'worldsaway';
    $('#local-service-address').hidden = !local;
    updateConnectionMode(connectionMode);
    clearWorlds();
}
$('#sign-in-mode').addEventListener('click', () => updateConnectionMode('login', true));
$('#create-account-mode').addEventListener('click', () => updateConnectionMode('register', true));
$('#connect-dialog').addEventListener('close', clearConnectionPasswords);
$('#connect-dialog').addEventListener('cancel', clearConnectionPasswords);
$('#service-select').addEventListener('change', updateServiceChoice);
$('#local-launcher').addEventListener('change', updateServiceChoice);
$('#load-worlds').addEventListener('click', async () => {
    const button = $('#load-worlds'), select = $('#world-select');
    button.disabled = true;
    button.textContent = 'Loading…';
    $('#connect-error').textContent = '';
    try {
        const result = await api(`/api/worlds?url=${encodeURIComponent(selectedLauncher())}`);
        clearWorlds();
        for (const world of result.worlds ?? []) {
            const tunnel = String(world.flags ?? '').includes('w'), option = new Option(`${world.name}${tunnel ? ' (native tunnel)' : ''}`, world.name);
            select.add(option);
        }
        $('#world-directory-note').textContent = `${result.worlds?.length ?? 0} ${selectedService()} worlds listed.`;
    }
    catch (error: any) {
        $('#connect-error').textContent = error.message;
    }
    finally {
        button.disabled = false;
        button.textContent = 'Load worlds';
    }
});
for (const id of ['#scene-connect', '#connect-button'])
    $(id).addEventListener('click', async () => { if (state.canReconnect && state.status !== 'connected') {
        try {
            const result = await api('/api/reconnect', {});
            applyState(result.state);
            stream();
        }
        catch (error: any) {
            notify(error.message, true);
            show('#connect-dialog');
        }
        return;
    } if (state.status === 'connected') {
        try {
            await api('/api/logout', {});
            source?.close();
            applyState({ status: 'disconnected', objects: [], history: [] });
            notify('You left the world.');
        }
        catch (error: any) {
            notify(error.message, true);
        }
    }
    else if (state.status === 'avatars')
        show('#avatar-dialog');
    else
        show('#connect-dialog'); });
$('#avatar-list').addEventListener('click', async (event: any) => { const button = event.target.closest('[data-avatar]'); if (!button)
    return; button.disabled = true; $('#avatar-error').textContent = ''; try {
    const result = await api('/api/enter', { avatar: button.dataset.avatar });
    applyState(result.state);
}
catch (error: any) {
    $('#avatar-error').textContent = error.message;
}
finally {
    button.disabled = false;
} });
$('#create-avatar-form').addEventListener('submit', async (event: any) => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; try {
    const result = await api('/api/avatars', { action: 'create', name: $('#new-avatar').value });
    applyState(result.state);
    stream();
    $('#new-avatar').value = '';
}
catch (error: any) {
    $('#avatar-error').textContent = error.message;
}
finally {
    button.disabled = false;
} });
function actionTarget(action: ActionDescriptor, object: WorldObject | null | undefined = selection()) { return action.receiver === 'region' ? 0 : action.receiver === 'actor' ? Number(state.actorNoid) : Number(object?.noid ?? state.actorNoid); }
function fieldControl(field: Pick<WireField, 'name' | 'label' | 'type' | 'width' | 'count' | 'min' | 'max'> & Partial<WireField>, value: any) {
    const id = `field-${field.name}`, label = `<label for="${esc(id)}">${esc(field.label)}${typeof field.count === 'number' && !['s', 'c'].includes(field.type) ? ` <span class="optional">${field.count} values</span>` : ''}</label>`;
    if (field.hidden)
        return `<input type="hidden" name="${esc(field.name)}" value="${esc(value)}">`;
    if (field.options?.length)
        return label + `<select id="${esc(id)}" name="${esc(field.name)}">${field.options.map((o: any) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (field.count !== null && !['s', 'c'].includes(field.type))
        return label + `<input class="array-input" id="${esc(id)}" name="${esc(field.name)}" value="${esc(JSON.stringify(value))}" required>`;
    if (field.type === 'b')
        return `<label class="checkbox-label"><input id="${esc(id)}" type="checkbox" name="${esc(field.name)}" ${value ? 'checked' : ''}>${esc(field.label)}</label>`;
    if (field.type === 'u' && field.width === 2 && /^(?:item|target|target_noid|container|indirect|src|dest|actor)$/.test(field.name)) {
        const objects = state.objects ?? [], known = objects.some((object) => Number(object.noid) === Number(value));
        return label + `<select id="${esc(id)}" name="${esc(field.name)}">${!known ? `<option value="${esc(value)}" selected>${Number(value) === 0 ? 'World / none' : `Object ${esc(value)}`}</option>` : ''}${objects.map((object) => `<option value="${Number(object.noid)}" ${Number(object.noid) === Number(value) ? 'selected' : ''}>${esc(objectName(object))} (${esc(className(object))})</option>`).join('')}</select>`;
    }
    if (['s', 'c'].includes(field.type)) {
        const large = /text|contents|data|script|description|matrix|sequence/i.test(field.name);
        const max = typeof field.count === 'number' ? field.count : field.type === 'c' && field.count === null ? 1 : 262144;
        return label + (large ? `<textarea rows="4" id="${esc(id)}" name="${esc(field.name)}" maxlength="${max}">${esc(value)}</textarea>` : `<input id="${esc(id)}" name="${esc(field.name)}" maxlength="${max}" value="${esc(value)}" autocomplete="off">`);
    }
    return label + `<input id="${esc(id)}" name="${esc(field.name)}" type="number" step="1" min="${field.min}" max="${field.max}" value="${esc(value)}" required>`;
}
function openAction(id: number, overrides: WireFields = {}, explicitNoid?: number | null) {
    if (!requireConnected())
        return;
    const action = lookupAction(id);
    if (!action) {
        notify('This action has no recovered schema.', true);
        return;
    }
    cancelObjectPreparation();
    actionDialogGeneration++;
    currentAction = action;
    const object = selection(), self = actor();
    const values = fieldDefaults(action, { actorNoid: state.actorNoid, targetNoid: object?.noid ?? state.actorNoid, containerNoid: self?.noid, position: self?.fields?.position ?? [256, 220, 0], colors: object?.fields?.colorMap, classNumber: objectClass(object), fields: overrides });
    $('#action-context').textContent = action.category.toUpperCase();
    $('#action-title').textContent = action.label;
    $('#action-hint').textContent = `${action.danger ? 'This action can make a lasting change. Review the values before sending. ' : ''}${action.admin ? 'Staff or owner permissions may be required. ' : ''}${action.hints?.includes('nearby') ? 'Your avatar approaches the object before using it. ' : ''}${action.hints?.includes('price') ? 'This action may spend tokens. ' : ''}The world server processes this request.`;
    $('#action-fields').innerHTML = action.fields.map((field) => fieldControl(field, values[field.name])).join('') || '<p class="panel-text">This action has no parameters.</p>';
    if (action.id === 4009)
        $('#action-fields').insertAdjacentHTML('beforeend', fieldControl({ name: 'pay_amount', label: 'Tokens to pay', type: 'u', width: 4, count: null, min: 1, max: 0x7fffffff }, overrides.pay_amount ?? '') + '<p class="form-note">The home manager supplies the rent quote. The payment must cover the amount due and use whole rental periods.</p>');
    const candidates = compatibleTargets(action, state), chosen = selectActionTarget(action, state, selectedNoid, explicitNoid), picker = $('#action-object');
    picker.value = chosen ? String(chosen.noid) : '';
    $('#action-submit').textContent = action.danger ? 'Confirm & send action' : 'Send action';
    $('#action-submit').classList.toggle('danger-button', action.danger);
    $('#action-submit').disabled = !chosen;
    $('#action-error').textContent = chosen ? '' : candidates.length ? 'Select an object in the world before opening this action.' : action.receiver === 'actor' && objectClass(actor()) === 22 ? 'Materialize before using this avatar action.' : 'There is no compatible object here for this action.';
    show('#action-dialog');
}
$('#action-dialog').addEventListener('cancel', () => { actionDialogGeneration++; cancelObjectPreparation(); });
$('#action-form').addEventListener('submit', async (event: any) => {
    event.preventDefault();
    const action = currentAction, generation = actionDialogGeneration, button = $('#action-submit');
    button.disabled = true;
    $('#action-error').textContent = '';
    try {
        if (!action)
            throw new Error('Choose an action first.');
        if (Number(state.tcl?.blockCount) > 0)
            throw new Error('The world is finishing another action.');
        const target = selectActionTarget(action, state, null, $('#action-object').value)?.noid;
        if (target === undefined || target === null)
            throw new Error('Choose a compatible object that is still in the world.');
        const raw = Object.fromEntries(new FormData(event.currentTarget));
        for (const field of action.fields)
            if (field.type === 'b')
                raw[field.name] = event.currentTarget.elements.namedItem(field.name).checked;
        const fields = coerceActionValues(action, raw);
        if (action.id === 4009)
            fields.pay_amount = Number(raw.pay_amount);
        const result = await api('/api/action', { noid: target, id: action.id, fields });
        if (generation === actionDialogGeneration) {
            close('#action-dialog');
            notify(`${action.label} sent. The reply will appear in Conversation or World tools.`);
        }
        if (result.state)
            applyState(result.state);
    }
    catch (error: any) {
        if (generation === actionDialogGeneration && !error.silent)
            $('#action-error').textContent = error.message;
    }
    finally {
        if (generation === actionDialogGeneration)
            button.disabled = false;
    }
});
async function send(id: number, fields: WireFields = {}, noid?: number | null) { if (!requireConnected())
    return; if (Number(state.tcl?.blockCount) > 0) {
    notify('The world is finishing another action.');
    return;
} const action = lookupAction(id); try {
    if (!action)
        throw new Error(`Unknown native action ${id}`);
    await api('/api/action', { noid: noid ?? actionTarget(action), id, fields: coerceActionValues(action, { ...fieldDefaults(action), ...fields }) });
}
catch (error: any) {
    if (!error.silent)
        notify(error.message, true);
} }
function walkTo(x: any, y: any, z = 0) { const self = actor(); if (!requireConnected())
    return; if (objectClass(self) === 22) {
    notify('Materialize from the Avatar tab to walk.');
    return;
} send(1570, { coords: [Math.round(Math.max(-32768, Math.min(32767, x))), Math.round(Math.max(-32768, Math.min(32767, y))), z] }, state.actorNoid); }
function walkBy(dx: any, dy: any) { try {
    const self = actor();
    if (!self)
        return;
    const pos = nativeWalkCoordinates(self, state);
    walkTo(pos[0] + dx, pos[1] + dy, pos[2]);
}
catch (error: any) {
    notify(error.message, true);
} }
async function quickAction(name: any) { const object = selection(); switch (name) {
    case 'toggle-ghost': return openAction(objectClass(actor()) === 22 ? 2005 : 1587);
    case 'document':
        try {
            await documents.open(object);
        }
        catch (error: any) {
            notify(error.message, true);
        }
        return;
    case 'presentation':
        try {
            await banners.start(Number(object?.noid));
            notify('Presentation requested.');
        }
        catch (error: any) {
            notify(error.message, true);
        }
        return;
    case 'pickup': return send(1575, { item: object?.noid ?? 0, action: 0 }, state.actorNoid);
    case 'describe': return send(76, { unused: 0 }, object?.noid);
    case 'pockets': return send(1711, { unused: 0 }, state.actorNoid);
    case 'drop': return openAction(1580);
    case 'materialize': return send(2005, { coords: nativeWalkCoordinates(actor(), state) }, state.actorNoid);
    case 'ghost': return send(1587, { unused: 0 }, state.actorNoid);
    case 'esp':
        $('#chat-channel').value = 'esp';
        channelChange();
        $('#chat-to').focus();
        break;
    case 'esp-selected':
        $('#chat-channel').value = 'esp';
        $('#chat-to').value = objectName(object);
        channelChange();
        $('#chat-text').focus();
        break;
    case 'compose-mail': return openAction(244);
    case 'read-mail': return send(247, { unused: 0 }, 0);
    case 'ignore': {
        const name = objectName(object), names = String(preferences.ignored).split(/\r?\n/).filter((n) => n.trim());
        preferences.ignored = isIgnored(name) ? names.filter((n) => n.toLowerCase() !== name.toLowerCase()).join('\n') : [...names, name].join('\n');
        savePreferences();
        notify(`${name} ${isIgnored(name) ? 'ignored' : 'unignored'} on this device.`);
        renderPanel();
        break;
    }
} }
document.addEventListener('click', (event: any) => { void worldAudio.unlock(); const target = event.target.closest('button'); if (!target)
    return; if (target.dataset.close !== undefined) {
    const dialog = target.closest('dialog');
    close(`#${dialog.id}`);
}
else if (target.dataset.panel)
    setPanel(target.dataset.panel);
else if (target.dataset.object !== undefined)
    selectObject(Number(target.dataset.object));
else if (target.dataset.deselect !== undefined)
    selectObject(null);
else if (target.dataset.action)
    openAction(Number(target.dataset.action));
else if (target.dataset.quick)
    quickAction(target.dataset.quick);
else if (target.dataset.exit !== undefined)
    send(103, { exitDir: Number(target.dataset.exit) }, 0);
else if (target.dataset.turn) {
    const request = nativeToolbarTurn(state, target.dataset.turn);
    if (request) send(request.id!, request.fields, request.noid);
}
else if (target.dataset.mood)
    send(1616, { mood: Number(target.dataset.mood) }, state.actorNoid);
else if (target.dataset.gesture)
    send(1594, { gesture: target.dataset.gesture }, state.actorNoid);
else if (target.dataset.status)
    send(1916, { type: Number(target.dataset.status) }, state.actorNoid); });
$('#panel-content').addEventListener('change', (event: any) => { if (event.target.id === 'avatar-mood')
    send(1616, { mood: Number(event.target.value) }, state.actorNoid); });
let searchTimeout: ReturnType<typeof setTimeout> | undefined;
$('#panel-content').addEventListener('input', (event: any) => { if (event.target.id === 'action-search') {
    filter = event.target.value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { const position = event.target.selectionStart; event.target.blur(); renderPanel(); const input = $('#action-search'); input?.focus(); input?.setSelectionRange(position, position); }, 250);
} });
function channelChange() {
    const ghost = objectClass(actor()) === 22, select = $('#chat-channel');
    if (ghost && ['say', 'think'].includes(select.value))
        select.value = 'esp';
    const recipient = ghost || ['esp', 'mail'].includes(select.value);
    $('label[for="chat-to"]').hidden = !recipient;
    $('.native-to-combo').hidden = !recipient;
    $('#chat-to').required = recipient;
    $('#chat-text').placeholder = '';
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-native-channel]'))
        button.disabled = state.status !== 'connected' || Number(state.tcl?.blockCount) > 0 || sendingMessage
            || (ghost && ['say', 'think'].includes(button.dataset.nativeChannel!));
}
$('#chat-channel').addEventListener('change', channelChange);
$('#chat-text').addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        $('#chat-form').requestSubmit();
    }
});
$('#chat-form').addEventListener('submit', async (event: any) => {
    event.preventDefault();
    if (!requireConnected())
        return;
    if (Number(state.tcl?.blockCount) > 0 || sendingMessage)
        return;
    const text = $('#chat-text').value.trim(), to = $('#chat-to').value.trim(), channel = $('#chat-channel').value;
    if (!text)
        return;
    if (['say', 'think'].includes(channel) && objectClass(actor()) === 22) {
        notify('Ghosts can send ESP. Materialize to speak in the room.');
        setPanel('avatar');
        return;
    }
    const room = ['say', 'think'].includes(channel), id = room ? 72 : channel === 'esp' ? 109 : 244, fields = room ? { type: channel === 'think' ? 1 : 0, dummyfielda: 0, text } : channel === 'esp' ? { type: 0, dummyfielda: 0, to, text } : { to, text };
    sendingMessage = true;
    channelChange();
    try {
        await api('/api/action', { noid: channel === 'mail' ? 0 : state.actorNoid, id, fields: coerceActionValues(lookupAction(id)!, fields) });
        $('#chat-text').value = '';
        if (channel === 'mail')
            addConversation({ kind: 'system', author: 'Mail', text: `Letter sent to ${to}; awaiting the server reply.` });
    }
    catch (error: any) {
        notify(error.message, true);
    }
    finally {
        sendingMessage = false;
        channelChange();
        $('#chat-text').focus();
    }
});
function download(name: any, text: any, type: any = 'text/plain') { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('#export-chat').addEventListener('click', () => download(`altaway-conversation-${new Date().toISOString().slice(0, 10)}.txt`, conversation.map((e) => `[${new Date(e.time ?? Date.now()).toISOString()}] ${e.kind} ${e.author}: ${e.text}`).join('\n')));
$('#clear-chat').addEventListener('click', () => { conversation.length = 0; conversationPane.clear(); renderer.setConversationQuip(null); $('#chat-log').innerHTML = '<div class="log-welcome"><span>✦</span> A little conversation makes a world.</div>'; $('#chat-count').textContent = '0'; });
function savePreferences() { worldAudio.setEnabled(preferences.sound); try {
    localStorage.setItem('altaway.preferences', JSON.stringify({ ...preferences, animation: savedAnimationPreference ? preferences.animation : undefined }));
}
catch { } $('#world-canvas').style.imageRendering = preferences.pixelated ? 'pixelated' : 'auto'; renderer.setPreferences?.(preferences); }
$('#settings-button').addEventListener('click', () => { const form = $('#settings-form'); for (const key of ['sound', 'animation', 'pixelated', 'names', 'advanced'])
    form.elements.namedItem(key).checked = Boolean(preferences[key]); $('#ignore-list').value = preferences.ignored || ''; show('#settings-dialog'); });
$('#settings-form').addEventListener('submit', (event: any) => { event.preventDefault(); for (const key of ['sound', 'animation', 'pixelated', 'names', 'advanced'])
    preferences[key] = event.currentTarget.elements.namedItem(key).checked; savedAnimationPreference = true; preferences.ignored = $('#ignore-list').value; savePreferences(); close('#settings-dialog'); renderPanel(); notify('Settings saved on this device.'); });
$('#help-button').addEventListener('click', () => show('#help-dialog'));
$('#page-helper-button').addEventListener('click', () => { const item = nativePageHelper(state); if (!item.disabled && item.id !== undefined)
    send(item.id, item.fields, item.noid); });
function diagnostics() { const errors = state.history.filter((e) => ['decode-error', 'error'].includes(e.type)); return { version: config.version, status: state.status, worldName: state.worldName, avatar: state.avatar, actorNoid: state.actorNoid, region: state.region, permissions: state.permissions, resources: state.resources, objects: state.objects.length, classes: classMetadata?.classes?.length ?? CLASSES.length, requests: runtimeActions.size, decoderErrors: errors, history: state.history.filter((e) => e.noid !== 10 && e.id !== 11).slice(-100) }; }
function renderTclConsole() {
    const model = state.tcl ?? {};
    $('#tcl-console-status').textContent = model.enabled ? `Tcl ${model.version ?? '8.6'} · ${model.status ?? 'idle'} · target ${objectName(selection() ?? actor())}` : 'The Tcl runtime is available after starting the updated browser bridge.';
    $('#tcl-run').disabled = !model.enabled || state.status !== 'connected';
    $('#tcl-stop').disabled = !model.enabled;
    $('#tcl-console-output').textContent = [...(model.logs ?? []).map((entry: any) => entry.text), ...(model.tasks ?? []).slice(-15).map((task: any) => `${task.id} ${task.label}: ${task.status}${task.result ? ` — ${task.result}` : ''}${task.error ? ` — ${task.error}` : ''}`)].join('\n');
}
$('#tcl-run').addEventListener('click', async () => { if (!requireConnected())
    return; $('#tcl-console-error').textContent = ''; $('#tcl-run').disabled = true; try {
    await tcl.run($('#tcl-console-source').value, selection()?.noid ?? state.actorNoid);
}
catch (error: any) {
    $('#tcl-console-error').textContent = error.message;
}
finally {
    renderTclConsole();
} });
$('#tcl-stop').addEventListener('click', async () => { try {
    await tcl.cancel();
}
catch (error: any) {
    $('#tcl-console-error').textContent = error.message;
} });
$('#diagnostics-button').addEventListener('click', () => { $('#diagnostics-content').innerHTML = `${fieldsTable({ status: state.status, world: state.worldName || '—', avatar: state.avatar || '—', objects: state.objects.length, classes: classMetadata?.classes?.length ?? CLASSES.length, requests: runtimeActions.size, resourceProgress: `${state.resources?.received ?? 0}/${state.resources?.total ?? 0}` })}<pre>${esc(JSON.stringify({ permissions: state.permissions, resources: state.resources, error: state.error }, null, 2))}</pre><p class="form-note">Diagnostics may include conversation text and object data. Passwords and native login tokens are not included.</p>`; show('#diagnostics-dialog'); });
$('#download-diagnostics').addEventListener('click', () => download('altaway-diagnostics.json', JSON.stringify(diagnostics(), null, 2), 'application/json'));
$('#refresh-state').addEventListener('click', async () => { try {
    applyState(await api('/api/state'));
    notify('Connection state refreshed.');
}
catch (error: any) {
    notify(error.message, true);
} });
$('#fullscreen-button').addEventListener('click', async () => { try {
    if (document.fullscreenElement)
        await document.exitFullscreen();
    else
        await $('#scene-frame').requestFullscreen();
}
catch (error: any) {
    notify(error.message, true);
} });
document.addEventListener('keydown', (event: any) => { void worldAudio.unlock(); if (event.key === 'Escape') {
    $('#object-context')?.remove();
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('.native-menu>details'))
        menu.open = false;
} if (document.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? ''))
    return; if (event.key === 'Enter') {
    event.preventDefault();
    $('#chat-text').focus();
}
else if (event.key.toLowerCase() === 'i') {
    setPanel('inventory');
}
else if (event.key.toLowerCase() === 'm') {
    setPanel('mail');
}
else if (event.target === $('#world-canvas') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const dx = event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0, dy = event.key === 'ArrowUp' ? 8 : event.key === 'ArrowDown' ? -8 : 0;
    walkBy(dx, dy);
} });
for (const dialog of document.querySelectorAll('dialog'))
    dialog.addEventListener('click', (event: any) => { if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)
            close(`#${dialog.id}`);
    } });
window.addEventListener('pagehide', () => { source?.close(); banners.destroy(); tcl.destroy(); worldAudio.destroy(); documents.destroy(); payments.destroy(); npc.destroy(); approach.destroy(); });
async function initialize() {
    installNativeChrome();
    savePreferences();
    const results = await Promise.allSettled([api('/api/config'), api('/api/state'), api('/api/classes')]);
    if (results[0].status === 'fulfilled')
        config = results[0].value;
    if (results[2].status === 'fulfilled')
        acceptMetadata(results[2].value);
    $('#service-choice').hidden = Boolean(config.hosted);
    if (!config.hosted && config.backendName === 'AltAway') $('#service-select').value = 'altaway';
    if (!config.hosted && config.launcherUrl && config.launcherUrl !== ALTAWAY_LAUNCHER_URL) {
        $('#service-select').value = 'worldsaway';
        $('#local-launcher').value = config.launcherUrl;
    } else if (config.localLauncherUrl) $('#local-launcher').value = config.localLauncherUrl;
    updateServiceChoice();
    try {
        const saved = JSON.parse(localStorage.getItem('altaway.connection') || '{}');
        if (!config.hosted && saved.launcherUrl && new URL(saved.launcherUrl).href !== ALTAWAY_LAUNCHER_URL) {
            $('#service-select').value = 'worldsaway';
            $('#local-launcher').value = saved.launcherUrl;
            updateServiceChoice();
        }
        const sameService = !saved.launcherUrl || new URL(saved.launcherUrl).href === new URL(selectedLauncher()).href;
        if (sameService && saved.account)
            $('#account').value = saved.account;
        if (sameService && saved.world)
            $('#world-select').add(new Option(saved.world, saved.world, true, true));
    }
    catch { }
    if (results[1].status === 'fulfilled') {
        applyState(results[1].value);
        if (['connected', 'avatars', 'entering'].includes(state.status))
            stream();
    }
    else
        notify('The browser bridge is unavailable. Start it with npm start.', true);
}
initialize().catch((error: any) => notify(error.message, true));
function installNativeChrome() {
    installNativeButtonImages();
    for (const image of document.querySelectorAll<HTMLImageElement>('[data-native-icon]')) {
        const name = image.dataset.nativeIcon ?? '';
        const control = image.parentElement!;
        if (control.closest('.native-toolbar')) {
            const left: Record<string, number> = { west: 0, north: 1, south: 2, east: 3, ghost: 4, materialize: 4 }, center: Record<string, number> = { normal: 0, happy: 1, sad: 2, mad: 3, wave: 4, bow: 5, shrug: 6, present: 7, jump: 8, react: 9 }, right: Record<string, number> = { 'turn-left': 0, 'turn-right': 1, 'turn-around': 2, time: 3, tokens: 4 };
            control.classList.add('native-positioned-tool');
            if (name in left)
                control.style.left = `${left[name] * 29 + 2}px`;
            else if (name in center)
                control.style.left = `calc(50% - 145px + ${center[name] * 29}px)`;
            else if (name in right)
                control.style.right = `${(4 - right[name]) * 29 + 2}px`;
        }
    }
    $('#close-utility').addEventListener('click', () => { $('#utility-window').hidden = true; });
    $('#recipient-pick').addEventListener('change', () => { $('#chat-to').value = $('#recipient-pick').value; $('#chat-text').focus(); });
    $('#native-close').addEventListener('click', async () => { try {
        await rawApi('/api/logout', {});
    }
    catch { } source?.close(); applyState({ status: 'disconnected', objects: [], history: [], avatars: [] }); $('#native-window').hidden = true; $('#utility-window').hidden = true; $('#restart-client').hidden = false; });
    $('#restart-client').addEventListener('click', () => { $('#restart-client').hidden = true; $('#native-window').hidden = false; show('#connect-dialog'); });
    $('#native-minimize').addEventListener('click', () => $('#native-window').classList.toggle('minimized'));
    $('#native-maximize').addEventListener('click', () => $('#native-window').classList.toggle('maximized'));
    const grip = document.createElement('div');
    grip.className = 'native-resize-grip';
    grip.setAttribute('aria-hidden', 'true');
    $('#native-window').style.position = 'relative';
    $('#native-window').append(grip);
    let resizing: any = null;
    grip.addEventListener('pointerdown', (event: any) => { const frame = $('#native-window'), rect = frame.getBoundingClientRect(); resizing = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height }; grip.setPointerCapture(event.pointerId); event.preventDefault(); });
    grip.addEventListener('pointermove', (event: any) => { if (!resizing)
        return; const frame = $('#native-window'); frame.classList.add('resized'); frame.style.width = `${Math.max(540, resizing.width + event.clientX - resizing.x)}px`; frame.style.height = `${Math.max(475, resizing.height + event.clientY - resizing.y)}px`; });
    grip.addEventListener('pointerup', () => { resizing = null; });
    document.addEventListener('click', (event: any) => {
        const target = event.target.closest('button');
        if (target?.dataset.nativeChannel) {
            const channel = target.dataset.nativeChannel;
            if (channel === 'mail')
                openAction(244);
            else {
                $('#chat-channel').value = channel;
                channelChange();
                if (['say', 'think'].includes(channel)) {
                    $('#chat-to').value = '';
                    $('#chat-text').focus();
                }
                else if (!$('#chat-to').value.trim())
                    $('#chat-to').focus();
                else
                    $('#chat-text').focus();
                if (['say', 'think'].includes(channel) && $('#chat-text').value.trim() || channel === 'esp' && $('#chat-to').value.trim() && $('#chat-text').value.trim())
                    $('#chat-form').requestSubmit();
            }
        }
        if (target?.dataset.nativeCommand === 'exit')
            $('#native-close').click();
        if (target?.dataset.nativeCommand === 'about')
            show('#about-dialog');
        if (target?.dataset.nativeCommand === 'tcl') {
            renderTclConsole();
            show('#tcl-console-dialog');
        }
        if (target?.dataset.nativeCommand === 'copy') {
            const text = conversation.map((e) => `${e.author}: ${e.text}`).join('\n');
            navigator.clipboard?.writeText(text).then(() => notify('Conversation copied.')).catch(() => notify('Use File → Save text to save the conversation.'));
        }
        for (const menu of document.querySelectorAll<HTMLDetailsElement>('.native-menu>details'))
            if (!menu.contains(event.target) || target)
                menu.open = false;
        if (!event.target.closest('.native-context-menu') && !event.target.closest('#world-canvas'))
            $('#object-context')?.remove();
    });
    $('#world-canvas').addEventListener('pointerdown', (event: any) => { scenePointer = { x: event.clientX, y: event.clientY }; });
    $('#world-canvas').addEventListener('contextmenu', (event: any) => {
        event.preventDefault();
        scenePointer = { x: event.clientX, y: event.clientY };
        renderer.click(event);
    });
    const title = $('.native-titlebar');
    let drag: any = null;
    title.addEventListener('pointerdown', (event: any) => { if (event.target.closest('button'))
        return; const rect = $('#native-window').getBoundingClientRect(); drag = { x: event.clientX - rect.left, y: event.clientY - rect.top }; title.setPointerCapture(event.pointerId); });
    title.addEventListener('pointermove', (event: any) => { if (!drag)
        return; const frame = $('#native-window'); frame.style.position = 'absolute'; frame.style.margin = '0'; frame.style.left = `${Math.max(0, Math.min(innerWidth - 100, event.clientX - drag.x))}px`; frame.style.top = `${Math.max(clientBanner.offsetHeight, event.clientY - drag.y) + scrollY}px`; });
    title.addEventListener('pointerup', () => { drag = null; });
}
function sceneSelect(object: WorldObject | null, walkDestination?: readonly number[]) {
    if (Number(state.tcl?.blockCount) > 0)
        return;
    selectObject(object?.noid ?? null);
    $('#object-context')?.remove();
    if (!object)
        return;
    const f = object.fields ?? object, imageKey = `${f.imageURL ?? ''}@${Number(f.imageVersion) || 0}#${f.imageDefault ? 0x20000 + Number(f.imageDefault) : 0}`, seatImages = new Map([[Number(object.noid), renderer.assets?.get(imageKey)]]);
    const data = getObjectMenu(object, { ...state, advanced: preferences.advanced, seatImages }, walkDestination), menu = document.createElement('div');
    menu.id = 'object-context';
    menu.className = 'native-context-menu with-submenus';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    const label = document.createElement('div'), titleText = document.createElement('span');
    label.className = 'native-context-title';
    titleText.className = 'native-menu-label';
    titleText.textContent = data.label;
    label.append(titleText);
    menu.append(label);
    const append = (parent: any, items: any) => {
        for (const item of items) {
            if (item.separator) {
                parent.append(document.createElement('hr'));
                continue;
            }
            const row = document.createElement('div'), button = document.createElement('button'), text = document.createElement('span');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            text.className = 'native-menu-label';
            text.textContent = item.label;
            button.append(text);
            button.disabled = Boolean(item.disabled);
            row.append(button);
            if (item.items) {
                row.className = 'menu-parent';
                button.setAttribute('aria-haspopup', 'menu');
                const arrow = document.createElement('span');
                arrow.className = 'menu-arrow';
                arrow.textContent = '▶';
                arrow.setAttribute('aria-hidden', 'true');
                button.append(arrow);
                const sub = document.createElement('div');
                sub.className = 'context-submenu';
                sub.setAttribute('role', 'menu');
                if (!item.items.some((entry: any) => entry.items))
                    sub.classList.add('leaf-submenu');
                append(sub, item.items);
                row.append(sub);
                const layout = () => { sub.style.left = '100%'; sub.style.right = 'auto'; sub.style.top = '-3px'; const rect = sub.getBoundingClientRect(); if (rect.right > innerWidth - 4) {
                    sub.style.left = 'auto';
                    sub.style.right = '100%';
                } if (rect.bottom > innerHeight - 4)
                    sub.style.top = `${Math.min(-3, innerHeight - 4 - rect.height - row.getBoundingClientRect().top)}px`; };
                row.addEventListener('mouseenter', layout);
                row.addEventListener('focusin', layout);
                button.addEventListener('keydown', (event: any) => { if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    sub.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
                } });
            }
            else
                button.addEventListener('click', () => { menu.remove(); invokeNativeMenu(item, object); });
            parent.append(row);
        }
    };
    append(menu, data.items);
    if (!data.items.length) {
        const item = document.createElement('button');
        item.textContent = 'Tell me about';
        item.addEventListener('click', () => { menu.remove(); send(76, { unused: 0 }, object.noid); });
        menu.append(item);
    }
    // Keep the opening point on the canvas so a second click can still become
    // its native ground-walk double click instead of landing on the menu title.
    document.body.append(menu);
    menu.style.left = `${Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, scenePointer.x + 3))}px`;
    menu.style.top = `${Math.max(4, Math.min(innerHeight - menu.offsetHeight - 4, scenePointer.y + 3))}px`;
    menu.focus();
    menu.addEventListener('keydown', (event: any) => { if (event.key === 'ArrowDown' && event.target === menu) {
        event.preventDefault();
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    } if (event.key === 'Escape') {
        menu.remove();
        $('#world-canvas').focus();
    } if (event.key === 'ArrowLeft') {
        const sub = event.target.closest('.context-submenu');
        if (sub) {
            event.preventDefault();
            sub.parentElement.querySelector(':scope>button')?.focus();
        }
    } });
}
async function invokeNativeMenu(item: any, object: any) {
    if (item.command === 'walk-to') {
        try {
            const target = state.objects.find((entry) => Number(entry.noid) === Number(item.noid));
            const request = item.fields?.coords !== undefined
                ? nativeGroundWalkRequest(item.fields.coords, state)
                : nativeObjectWalkRequest(target, state);
            await send(request.id, request.fields, request.noid);
        }
        catch (error: any) {
            if (!error.silent)
                notify(error.message, true);
        }
        return;
    }
    if (item.command === 'esp') {
        $('#chat-channel').value = 'esp';
        $('#chat-to').value = item.fields?.to || objectName(object);
        channelChange();
        $('#chat-text').focus();
        return;
    }
    if (item.command === 'mail') {
        openAction(244, { to: item.fields?.to || '' });
        return;
    }
    if (item.command === 'ignore') {
        quickAction('ignore');
        return;
    }
    if (item.command === 'document') {
        try {
            cancelObjectPreparation();
            await approach.perform(item);
        }
        catch (error: any) {
            if (!error.silent)
                notify(error.message, true);
            return;
        }
        documents.open(state.objects.find((o) => Number(o.noid) === Number(item.noid)) || object).catch((error: any) => notify(error.message, true));
        return;
    }
    if (item.command === 'presentation') {
        banners.start(item.noid ?? object.noid).catch((error: any) => notify(error.message, true));
        return;
    }
    if (item.form) {
        openAction(item.id, item.fields, item.noid);
        return;
    }
    send(item.id, item.fields, item.noid);
}
