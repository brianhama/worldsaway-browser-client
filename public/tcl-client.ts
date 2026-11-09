import type { WorldState, WireFields, ApiRequest } from './types.js';
import type { WorldTclOptions } from './tcl-types.js';
import { TclVisualHost } from './tcl-host.js';
import { TclDialogs } from './tcl-dialogs.js';
/** Drives asynchronous browser bindings emitted by the authenticated Tcl worker. */
export class WorldTcl {
    declare api: ApiRequest;
    declare getState: () => WorldState;
    declare onChange: WorldTclOptions['onChange'];
    declare onMessage: WorldTclOptions['onMessage'];
    declare onError: (error: any) => void;
    declare handled: Set<string>;
    declare cancelled: Set<string | number | undefined>;
    declare effectStatuses: Map<string, string>;
    declare key: string | null;
    declare destroyed: boolean;
    declare host: TclVisualHost;
    declare dialogs: TclDialogs;
    constructor({ api, getState, renderer, audio, onChange, onMessage, onError }: WorldTclOptions) {
        this.api = api;
        this.getState = getState;
        this.onChange = onChange;
        this.onMessage = onMessage;
        this.onError = onError ?? (() => { });
        this.handled = new Set();
        this.cancelled = new Set();
        this.effectStatuses = new Map();
        this.key = null;
        this.destroyed = false;
        this.host = new TclVisualHost({ getState: () => this.mergeState(this.getState()), renderer, audio, onChange, onBalloon: (event: any) => {
            const room = Number(event.type) < 2;
            const speaker = this.getState().objects?.find(object => Number(object.noid) === Number(event.noid));
            // Text must survive even when a script speaks for a hidden object,
            // the region, or an object whose artwork has not loaded yet.
            onMessage?.({ kind: room ? Number(event.type) === 1 ? 'think' : 'say' : 'system', author: speaker?.fields?.name || speaker?.name || 'World script', text: event.text,
                ...(room ? { speakerNoid: Number(event.noid), source: 'presentation', presentationKey: `${event.until}:${event.type}:${event.text}` } : {}) });
        }, onDialog: (model: any) => this.dialogs.render(model), onCallback: (event: any) => this.api('/api/tcl/callback', event), onError: this.onError });
        this.dialogs = new TclDialogs({ host: this.host, onError: this.onError });
    }
    /** Merge server-side Tcl display patches and virtual objects into a copy.
     * These projections are for the host/renderer, not a mutation of world data. */
    mergeState(state: WorldState): WorldState { const patches = new Map<number, WireFields>((state.tcl?.overrides ?? []).map((item: any) => [Number(item.noid), item.fields])), objects = [...(state.objects ?? []), ...(state.tcl?.virtualObjects ?? [])].map((object) => patches.has(Number(object.noid)) ? { ...object, fields: { ...object.fields, ...patches.get(Number(object.noid)) } } : object); return { ...state, objects, region: objects.find((object) => Number(object.noid) === 0) ?? state.region }; }
    displayState(state: WorldState) { return this.host.displayState(this.mergeState(state)); }
    ingestState(state: WorldState) {
        if (this.destroyed)
            return;
        const key = `${state.worldName ?? ''}|${state.avatar ?? ''}|${state.region?.fields?.name ?? ''}|${state.tcl?.generation ?? 0}`;
        // Object/effect identifiers may be reused after travel or a new script
        // generation; no deduplication or pending work may cross that boundary.
        if (key !== this.key) {
            if (this.key !== null)
                this.host.reset();
            this.key = key;
            this.handled.clear();
            this.cancelled.clear();
        }
        this.host.ingestState(this.mergeState(state));
        for (const task of state.tcl?.tasks ?? [])
            if (task.status === 'cancelled') {
                this.cancelled.add(task.id);
                this.host.cancelTask(task.id);
            }
        this.effectStatuses = new Map((state.tcl?.effects ?? []).map((effect: any) => [effect.id, effect.status]));
        for (const effect of state.tcl?.effects ?? []) {
            if (effect.status === 'cancelled') {
                this.host.cancelTask?.(effect.context?.taskId);
                continue;
            }
            if (effect.status !== 'pending' || this.handled.has(effect.id))
                continue;
            // Claim before the microtask starts: another snapshot can arrive
            // while dispatch is awaiting an image, timer, or dialog interaction.
            this.handled.add(effect.id);
            // Re-check at dispatch and completion. A late value/error from an
            // old world or cancelled task must never resume the current worker.
            const current = () => !this.destroyed && this.key === key && !this.cancelled.has(effect.context?.taskId) && this.effectStatuses.get(effect.id) === 'pending';
            Promise.resolve().then(() => { if (!current())
                return; return effect.name === 'openURL' ? this.link(effect.args[0]) : this.host.dispatch(effect.name, effect.args, effect.context); }).then((value: any) => current() ? this.api('/api/tcl/reply', { id: effect.id, value, overrides: this.host.visualUpdates() }) : undefined, (error: any) => current() ? this.api('/api/tcl/reply', { id: effect.id, error: error.message }) : undefined).catch((error: any) => { if (current())
                this.onError(error); });
        }
        if (this.handled.size > 1024) {
            const active = new Set((state.tcl?.effects ?? []).map((effect: any) => effect.id));
            this.handled = new Set([...this.handled].filter((id) => active.has(id)));
        }
    }
    async run(script: string, noid?: number | null) { return this.api('/api/tcl/run', { script, noid }); }
    // Surface a validated link as a transcript entry; world scripts do not
    // navigate the browser automatically or open an arbitrary URL scheme.
    link(value: string) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('World Tcl links must use HTTP or HTTPS.'); this.onMessage?.({ kind: 'system', author: 'World link', text: url.href, url: url.href }); return ''; }
    async presentation(noid: number, which: number | string, ad: any) { return this.api('/api/tcl/presentation', { noid, which, ad }); }
    cancel(taskId?: string | number) { return this.api('/api/tcl/cancel', { taskId }); }
    destroy() { this.destroyed = true; this.host.destroy(); this.dialogs.destroy(); this.handled.clear(); }
}
