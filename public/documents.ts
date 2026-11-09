export interface BinderEntry {
    index: number;
    title: string;
    author: string;
    date: string;
    type: number;
    id: number;
    raw: string[];
}
/** Editor state is separate from native object fields; dirty text is a local draft. */
export interface DocumentModel {
    open: boolean;
    busy: boolean;
    error: string | null;
    object: WorldObject | null;
    header: WireFields;
    page: number;
    pageCount: number;
    text: string;
    entries: BinderEntry[];
    index: boolean;
    documentId: number;
    indexId: number;
    rootIndexId: number;
    readOnly: boolean;
    dirty: boolean;
    blankPages?: number;
}
export interface DocumentOptions {
    api: ApiRequest;
    getState?: StateProvider;
    onChange?: (model: DocumentModel) => void;
    onError?: (error: unknown) => void;
    timeout?: number;
}
export interface DocumentMetadata {
    subject?: unknown;
    author?: unknown;
    maxSize?: unknown;
    daysToLive?: unknown;
}
import type { WireFields, WorldState, WorldObject, ApiRequest, StateProvider, PendingReply } from './types.js';
/** Native AltAway document/binder editor. All world text remains inert text. */
// This bounded list reader handles document data only. Brackets, dollar signs,
// and command-looking words remain text rather than Tcl substitutions.
export function parseTclList(input: unknown, { maxElements = 4096, maxDepth = 32 }: {
    maxElements?: number;
    maxDepth?: number;
} = {}) {
    const text = String(input ?? '');
    if (text.length > 262144)
        throw new Error('Binder index is too large');
    const values: string[] = [];
    let at = 0;
    const escaped = () => { if (++at >= text.length)
        throw new Error('Truncated binder escape'); const c = text[at++]; return c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c; };
    while (at < text.length) {
        while (/\s/.test(text[at] ?? '') && at < text.length)
            at++;
        if (at >= text.length)
            break;
        let value = '';
        if (text[at] === '{') {
            let depth = 1;
            at++;
            while (at < text.length && depth) {
                const c = text[at++];
                if (c === '\\') {
                    at--;
                    value += escaped();
                }
                else if (c === '{') {
                    if (++depth > maxDepth)
                        throw new Error('Binder index is nested too deeply');
                    value += c;
                }
                else if (c === '}') {
                    if (--depth)
                        value += c;
                }
                else
                    value += c;
            }
            if (depth)
                throw new Error('Unterminated binder entry');
            if (at < text.length && !/\s/.test(text[at]))
                throw new Error('Invalid binder list separator');
        }
        else if (text[at] === '"') {
            at++;
            let closed = false;
            while (at < text.length) {
                if (text[at] === '"') {
                    at++;
                    closed = true;
                    break;
                }
                value += text[at] === '\\' ? escaped() : text[at++];
            }
            if (!closed)
                throw new Error('Unterminated binder quote');
        }
        else {
            while (at < text.length && !/\s/.test(text[at])) {
                if (text[at] === '}')
                    throw new Error('Unexpected binder brace');
                value += text[at] === '\\' ? escaped() : text[at++];
            }
        }
        values.push(value);
        if (values.length > maxElements)
            throw new Error('Binder has too many entries');
    }
    return values;
}
/** Normalize native five-column rows and the compact title/ID fallback format. */
export function parseBinderEntries(contents: unknown) { return parseTclList(contents).map((value: string, index: number) => { const row = parseTclList(value); const native = row.length >= 5; const id = Number(native ? row[4] : row[1]); return { index, title: row[0] ?? `Document ${index + 1}`, author: native ? row[1] : '', date: native ? row[2] : '', type: native ? Number(row[3]) : 0, id: Number.isInteger(id) && id >= 0 ? id : 0, raw: row }; }); }
const latestSeq = (state: WorldState) => Math.max(0, ...(state?.history ?? []).map((e) => Number(e.seq) || 0));
const integer = (value: unknown, min: number, max: number, label: string) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${label} must be ${min}–${max}`); return n; };
const clientText = (value: unknown, max: number, label: string) => { const text = String(value ?? ''); if (text.includes('\0') || text.length > max)
    throw new Error(`${label} is too long or contains NUL`); for (const c of text)
    if (c.codePointAt(0)! > 255 && !/[€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/.test(c))
        throw new Error(`${label} contains characters outside the native Windows-1252 character set`); return text; };
/** Serialize page/index operations so a reply cannot overtake a preceding edit.
 * Closing or opening a document rejects waiters and invalidates queued work. */
export class DocumentController {
    api!: ApiRequest;
    getState!: StateProvider;
    onChange!: (model: DocumentModel) => void;
    onError!: ((error: any) => void) | undefined;
    timeout!: number;
    pending!: PendingReply[];
    queue!: Promise<unknown>;
    lastSeq!: number;
    generation!: number;
    model!: DocumentModel;
    constructor({ api, getState = () => ({}), onChange = () => { }, onError = () => { }, timeout = 15000 }: DocumentOptions) { this.api = api; this.getState = getState; this.onChange = onChange; this.onError = onError; this.timeout = timeout; this.pending = []; this.queue = Promise.resolve(); this.lastSeq = latestSeq(getState()); this.generation = 0; this.model = { open: false, busy: false, error: null, object: null, header: {}, page: 0, pageCount: 1, text: '', entries: [], index: false, documentId: 0, indexId: 0, rootIndexId: 0, readOnly: true, dirty: false }; }
    emit() { this.onChange(this.model); }
    ingestState(state: WorldState) {
        for (const event of state?.history ?? []) {
            if (Number(event.seq) <= this.lastSeq)
                continue;
            this.lastSeq = Number(event.seq);
            if (event.type !== 'message' || !this.model.object || Number(event.noid) !== Number(this.model.object!.noid))
                continue;
            const fields = event.fields ?? event.values ?? {};
            if ([2770, 2772].includes(Number(event.id)) && (fields.success === undefined || fields.success === 0)) {
                this.model.pageCount = Number(fields.doc_page_count) || 0;
                this.model.blankPages = Number(fields.blank_page_count) || 0;
            }
            const pending = this.pending.find((p) => p.id === Number(event.id) && Number(event.seq) > p.after && (event.requestId === undefined || Number(event.requestId) === p.requestId));
            if (pending) {
                this.pending.splice(this.pending.indexOf(pending), 1);
                clearTimeout(pending.timer!);
                if (fields.success !== undefined && Number(fields.success) !== 0)
                    pending.reject(new Error(fields.fail_msg || `The world declined this document operation (${fields.success})`));
                else
                    pending.resolve(fields);
            }
        }
        const current = state?.objects?.find((o) => o.noid === this.model.object?.noid);
        if (current) {
            this.model.object = current;
            this.model.blankPages = current.fields.blank_page_count ?? this.model.blankPages;
        }
        this.emit();
    }
    request(id: number, fields: WireFields, replyId: number) {
        if (!this.model.object)
            return Promise.reject(new Error('Choose a document first'));
        const noid = this.model.object!.noid, after = latestSeq(this.getState());
        return new Promise<WireFields>((resolve, reject) => {
            const item: PendingReply = { id: replyId, requestId: id, after, resolve, reject, timer: null };
            item.timer = setTimeout(() => { this.pending = this.pending.filter((p) => p !== item); reject(new Error('The document server did not respond in time')); }, this.timeout);
            // Register first because the SSE reply may arrive before the POST settles.
            this.pending.push(item);
            Promise.resolve(this.api('/api/action', { noid, id, fields })).then(() => this.ingestState(this.getState())).catch((error: any) => { clearTimeout(item.timer!); this.pending = this.pending.filter((p) => p !== item); reject(error); });
        });
    }
    run<T>(operation: () => T | Promise<T>) { const generation = this.generation; const result = this.queue.catch(() => { }).then(async () => { if (generation !== this.generation)
        return; this.model.busy = true; this.model.error = null; this.emit(); try {
        return await operation();
    }
    catch (error: any) {
        if (generation === this.generation) {
            this.model.error = error.message;
            this.onError?.(error);
        }
        throw error;
    }
    finally {
        if (generation === this.generation) {
            this.model.busy = false;
            this.emit();
        }
    } }); this.queue = result; return result; }
    async open(object: WorldObject | null | undefined) {
        this.cancelPending();
        this.generation++;
        this.queue = Promise.resolve();
        const f = object?.fields ?? {};
        if (!object || Number(object.classNumber) !== 37)
            throw new Error('This object is not a document');
        this.lastSeq = latestSeq(this.getState());
        this.model = { open: true, busy: false, error: null, object, header: {}, page: 0, pageCount: 1, text: '', entries: [], index: Boolean(f.documentFlags & 6), documentId: Number(f.textid) || 0, indexId: Number(f.textid) || 0, rootIndexId: Number(f.textid) || 0, readOnly: true, blankPages: f.blank_page_count ?? 0, dirty: false };
        this.emit();
        return this.run(async () => {
            let textid = Number(f.textid) || 0;
            // Header reads are public native operations. Determine ownership before the
            // optional activation/create path, which changes the physical document.
            // A ground book can be readable without granting permission to activate it.
            if (this.model.index)
                await this.loadIndex(textid);
            else
                await this.readHeader(textid);
            if (this.model.readOnly) {
                if (!this.model.index)
                    await this.readPage(0);
                return;
            }
            if (Number(f.docState ?? 0) === 0) {
                const result = await this.request(2720, { state: 1 }, 2721);
                textid = Number(result.textid) || textid;
            }
            if (Number(f.docState ?? 0) !== 2) {
                const result = await this.request(2720, { state: 2 }, 2721);
                textid = Number(result.textid) || textid;
            }
            if (!textid) {
                const result = await this.request(this.model.index ? 2740 : 2737, this.model.index ? { in_menu: 0 } : { actor: this.getState().actorNoid }, this.model.index ? 2741 : 2738);
                textid = Number(result.textid) || 0;
            }
            this.model.documentId = textid;
            this.model.indexId = textid;
            this.model.rootIndexId = textid;
            if (this.model.index)
                await this.loadIndex();
            else {
                await this.readHeader(textid);
                await this.readPage(0);
            }
        });
    }
    async readHeader(id: number) { const result = await this.request(2710, { doc_id: integer(id, 0, 65535, 'Document ID') }, 2711); this.model.header = result; this.model.documentId = id; this.model.readOnly = Boolean((this.model.object!.fields.documentFlags & 1) || (result.flags & 1) || (this.model.object!.fields.documentFlags & 4) || !result.owner); this.model.pageCount = Math.max(1, Math.ceil(Number(result.size || 0) / 4096)); return result; }
    async readPage(page: unknown) { const result = await this.request(2781, { page: integer(page, 0, 65535, 'Page') }, 2780); this.model.page = Number(result.page); this.model.text = String(result.text ?? ''); this.model.dirty = false; return result; }
    page(page: unknown) { return this.run(() => this.readPage(page)); }
    save(text: unknown, metadata: DocumentMetadata = {}) {
        return this.run(async () => {
            if (this.model.readOnly)
                throw new Error('This document is read-only');
            if (!this.model.index) {
                const result = await this.request(2771, { page: this.model.page, text: clientText(text, Math.min(Number(this.model.header.max_size) || 32000, 32000), 'Page text') }, 2770);
                this.model.text = String(text);
                this.model.pageCount = Number(result.doc_page_count) || 0;
                this.model.blankPages = Number(result.blank_page_count) || 0;
            }
            if (metadata.subject !== undefined) {
                const fields: WireFields = { max_size_allowed: integer(metadata.maxSize ?? this.model.header.max_size ?? 32000, 1, 32000, 'Document size'), author: clientText(metadata.author ?? this.model.header.author ?? '', 255, 'Author'), subject: clientText(metadata.subject, 255, 'Subject') };
                if (!this.model.index)
                    fields.days_to_live = integer(metadata.daysToLive ?? this.model.header.days_to_live ?? 0, 0, 36500, 'Expiration days');
                await this.request(this.model.index ? 2717 : 2712, fields, this.model.index ? 2718 : 2713);
                this.model.header = { ...this.model.header, author: fields.author, subject: fields.subject };
            }
            this.model.dirty = false;
        });
    }
    deletePage() { return this.save(''); }
    newPage() { return this.run(async () => { if (this.model.readOnly)
        throw new Error('This document is read-only'); if (Number(this.model.blankPages) < 1 && !(this.model.object!.fields.documentFlags & 4))
        throw new Error('This document needs a blank page'); await this.readPage(this.model.pageCount); }); }
    reorder(up: boolean) { return this.run(async () => { await this.request(2761, { page: this.model.page, up: up ? 1 : 0 }, 2762); await this.readPage(Math.max(0, this.model.page + (up ? -1 : 1))); }); }
    async loadIndex(id: number = this.model.indexId) { const header = await this.request(2715, { idx_id: integer(id, 0, 65535, 'Binder ID') }, 2716); this.model.header = header; this.model.indexId = id; this.model.index = true; this.model.readOnly = Boolean((this.model.object!.fields.documentFlags & 1) || !header.owner); const result = await this.request(2735, { idx_id: id }, 2736); this.model.entries = parseBinderEntries(result.contents); this.model.dirty = false; return result; }
    refreshIndex() { return this.run(() => this.loadIndex()); }
    newEntry() { return this.run(async () => { const result = await this.request(2737, { actor: this.getState().actorNoid }, 2738); this.model.index = false; await this.readHeader(Number(result.textid) || 0); await this.readPage(0); }); }
    openEntry(entry: BinderEntry) { return this.run(async () => { if (entry.type === 1)
        await this.loadIndex(entry.id);
    else {
        this.model.index = false;
        await this.readHeader(entry.id);
        await this.readPage(0);
    } }); }
    backToIndex() { return this.run(() => this.loadIndex(this.model.rootIndexId)); }
    insert(src: unknown, { keepblank = false }: {
        keepblank?: boolean;
    } = {}) { return this.run(async () => { await this.request(2743, { src: integer(src, 0, 65535, 'Document object'), keepblank: keepblank ? 1 : 0, in_menu: 0 }, 2744); await this.loadIndex(); }); }
    remove(entry: unknown) { return this.run(async () => { await this.request(2747, { entry: integer(entry, 0, 65535, 'Binder entry'), inhand: this.model.object!.fields.container_noid === this.getState().actorNoid && this.model.object!.fields.position?.[0] === 0 ? 1 : 0 }, 2748); await this.loadIndex(); }); }
    destroyEntry(entry: unknown) { return this.run(async () => { await this.request(2724, { entry: integer(entry, 0, 65535, 'Binder entry') }, 70); await this.loadIndex(); }); }
    cancelPending() { for (const item of this.pending) {
        clearTimeout(item.timer!);
        item.reject(new Error('Document operation was closed'));
    } this.pending = []; }
    close() { this.generation++; this.cancelPending(); this.model.open = false; this.model.busy = false; this.emit(); }
    destroy() { this.close(); this.onChange = () => { }; }
}
export function createDocumentEditor(options: DocumentOptions) {
    const style = document.createElement('style');
    style.textContent = `.wa-doc-dialog{width:min(860px,calc(100vw - 36px));max-height:90vh;border:1px solid #3b4845;border-radius:16px;padding:0;background:#182321;color:#edf4ef;box-shadow:0 30px 100px #0009;font:14px system-ui}.wa-doc-dialog::backdrop{background:#07100dc4}.wa-doc-dialog *{box-sizing:border-box}.wa-doc-dialog header,.wa-doc-dialog footer{padding:18px 22px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #35423d}.wa-doc-dialog footer{border-top:1px solid #35423d;border-bottom:0;flex-wrap:wrap}.wa-doc-dialog h2{margin:0;font-size:20px;flex:1}.wa-doc-dialog main{padding:18px 22px;display:grid;gap:14px;overflow:auto;max-height:65vh}.wa-doc-dialog label{display:grid;gap:7px;color:#bacbc1}.wa-doc-dialog input,.wa-doc-dialog textarea,.wa-doc-dialog select{width:100%;border:1px solid #4c5c52;border-radius:7px;background:#101b17;color:#f3f7f2;padding:10px;font:inherit}.wa-doc-dialog textarea{min-height:280px;resize:vertical;line-height:1.65}.wa-doc-dialog button{padding:9px 12px;border:1px solid #4b5c50;border-radius:7px;background:#27392e;color:#edf4ef;cursor:pointer;font:inherit}.wa-doc-dialog button:disabled{opacity:.45;cursor:default}.wa-doc-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.wa-doc-meta{font-size:12px;color:#a7b8aa}.wa-doc-index{display:grid;gap:8px}.wa-doc-index button{text-align:left}.wa-doc-error{color:#ffc0a6;margin:0}.wa-doc-status{margin-right:auto;color:#b8c6b9}@media(max-width:540px){.wa-doc-grid{grid-template-columns:1fr}.wa-doc-dialog main,.wa-doc-dialog header,.wa-doc-dialog footer{padding:14px}}`;
    document.head.append(style);
    const dialog = document.createElement('dialog');
    dialog.className = 'wa-doc-dialog';
    dialog.setAttribute('aria-label', 'Document editor');
    document.body.append(dialog);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text !== undefined)
        node.textContent = text; return node; };
    const header = el('header'), title = el('h2', 'Document'), closeButton = el('button', 'Close');
    closeButton.type = 'button';
    header.append(title, closeButton);
    const main = el('main'), metadata = el('div'), subject = el('input'), author = el('input'), expires = el('input'), page = el('input'), text = el('textarea'), index = el('div'), error = el('p'), info = el('div');
    metadata.className = 'wa-doc-grid';
    index.className = 'wa-doc-index';
    error.className = 'wa-doc-error';
    error.setAttribute('role', 'alert');
    info.className = 'wa-doc-meta';
    expires.type = 'number';
    expires.min = '0';
    expires.max = '36500';
    page.type = 'number';
    page.min = '0';
    page.max = '65535';
    text.spellcheck = true;
    text.setAttribute('aria-label', 'Page text');
    const label = (name: string, input: Node) => { const node = el('label', name); node.append(input); return node; };
    metadata.append(label('Subject', subject), label('Author', author), label('Expires in days (0 = never)', expires), label('Page', page));
    main.append(metadata, info, index, text, error);
    const footer = el('footer'), status = el('span'), buttons: Record<string, HTMLButtonElement> = {};
    status.className = 'wa-doc-status';
    footer.append(status);
    dialog.append(header, main, footer);
    let controller: DocumentController, viewKey = '', entryKey = '';
    const invoke = (fn: () => unknown) => Promise.resolve().then(fn).catch((error: any) => { if (controller?.model.open) {
        controller.model.error = error.message;
        controller.emit();
        options.onError?.(error);
    } });
    const saveDraft = () => controller.model.dirty ? controller.save(text.value, { subject: subject.value, author: author.value, daysToLive: expires.value }) : Promise.resolve();
    // Navigation flushes the current draft before changing the page or binder.
    const navigate = (fn: () => unknown) => invoke(async () => { await saveDraft(); return fn(); });
    const button = (key: string, label: string, fn: () => unknown) => { const node = el('button', label); node.type = 'button'; node.addEventListener('click', () => ['save', 'delete'].includes(key) ? invoke(fn) : navigate(fn)); buttons[key] = node; footer.append(node); };
    button('back', 'Back to binder', () => controller.backToIndex());
    button('previous', 'Previous', () => controller.page(Math.max(0, controller.model.page - 1)));
    button('next', 'Next', () => controller.page(controller.model.page + 1));
    button('new', 'New page', () => controller.newPage());
    button('up', 'Move page up', () => controller.reorder(true));
    button('down', 'Move page down', () => controller.reorder(false));
    button('delete', 'Delete page', () => { if (confirm('Delete this page? Its blank page will return to the document.'))
        return controller.deletePage(); });
    button('insert', 'Insert held document', () => { const state = options.getState?.() ?? {}, held = state.objects?.find((o) => o.fields.container_noid === state.actorNoid && o.fields.position?.[0] === 0 && o.noid !== controller.model.object!.noid); if (!held)
        throw new Error('Hold another document to insert it'); return controller.insert(held.noid); });
    button('post', 'New document', () => controller.newEntry());
    button('refresh', 'Refresh', () => controller.refreshIndex());
    button('save', 'Save changes', () => controller.save(text.value, { subject: subject.value, author: author.value, daysToLive: expires.value }));
    controller = new DocumentController({ ...options, onChange: (model: DocumentModel) => {
            options.onChange?.(model);
            if (model.open && !dialog.open)
                dialog.showModal();
            if (!model.open) {
                if (dialog.open)
                    dialog.close();
                return;
            }
            title.textContent = model.index ? 'Binder · ' + (model.header.subject || model.object!.fields.name) : 'Document · ' + (model.header.subject || model.object!.fields.name);
            const key = [model.object!.noid, model.index, model.indexId, model.documentId, model.page, model.text, model.header.subject, model.header.author].join('\0');
            if (key !== viewKey) {
                viewKey = key;
                subject.value = model.header.subject ?? '';
                author.value = model.header.author ?? '';
                expires.value = String(model.header.days_to_live ?? 0);
                page.value = String(model.page);
                text.value = model.text;
            }
            for (const node of [subject, author, expires, text])
                node.disabled = model.busy || model.readOnly;
            author.disabled = true;
            page.disabled = model.busy || model.index;
            text.hidden = model.index;
            index.hidden = !model.index;
            expires.parentElement!.hidden = model.index;
            page.parentElement!.hidden = model.index;
            info.textContent = `${model.readOnly ? 'Read-only' : 'Editable'} · ${model.header.date || ''} · ${model.blankPages ?? 0} blank pages available`;
            status.textContent = model.busy ? 'Waiting for the world…' : model.index ? `${model.entries.length} documents` : `Page ${model.page} · ${model.pageCount} written pages`;
            error.textContent = model.error || '';
            for (const [name, node] of Object.entries(buttons)) {
                node.disabled = model.busy || (['save', 'new', 'up', 'down', 'delete', 'insert', 'post'].includes(name) && model.readOnly);
                node.hidden = ['insert', 'refresh', 'post'].includes(name) ? !model.index : ['previous', 'next', 'new', 'up', 'down', 'delete'].includes(name) ? model.index : name === 'back' ? !Boolean(model.rootIndexId && (model.object!.fields.documentFlags & 6) && !model.index) : false;
            }
            buttons.previous.disabled ||= model.page <= 0;
            buttons.up.disabled ||= model.page <= 0;
            buttons.down.disabled ||= model.page >= model.pageCount - 1;
            const nextEntryKey = String(model.readOnly) + JSON.stringify(model.entries);
            if (nextEntryKey !== entryKey) {
                entryKey = nextEntryKey;
                index.replaceChildren();
                for (const entry of model.entries) {
                    const row = el('div'), read = el('button', `${entry.type === 1 ? 'Binder' : 'Document'} · ${entry.title}${entry.author ? ' — ' + entry.author : ''}`);
                    read.type = 'button';
                    read.addEventListener('click', () => navigate(() => controller.openEntry(entry)));
                    row.append(read);
                    if (!model.readOnly) {
                        const remove = el('button', 'Take out'), del = el('button', 'Delete');
                        remove.type = del.type = 'button';
                        remove.addEventListener('click', () => invoke(() => controller.remove(entry.index)));
                        del.addEventListener('click', () => { if (confirm(`Permanently delete “${entry.title}” from this binder?`))
                            invoke(() => controller.destroyEntry(entry.index)); });
                        row.append(remove, del);
                    }
                    index.append(row);
                }
                if (!model.entries.length)
                    index.append(el('p', 'This binder is empty.'));
            }
            for (const node of index.querySelectorAll('button'))
                node.disabled = model.busy;
        } });
    closeButton.addEventListener('click', () => { if (!controller.model.dirty || confirm('Discard unsaved document changes?'))
        controller.close(); });
    dialog.addEventListener('cancel', (event: Event) => { event.preventDefault(); closeButton.click(); });
    page.addEventListener('change', () => navigate(() => controller.page(page.value)));
    for (const field of [text, subject, author, expires])
        field.addEventListener('input', () => { controller.model.dirty = true; status.textContent = 'Unsaved changes'; });
    return { open: (object: WorldObject | null | undefined) => controller.open(object), ingestState: (state: WorldState) => controller.ingestState(state), close: () => controller.close(), destroy() { controller.destroy(); dialog.remove(); style.remove(); }, element: dialog, controller };
}
