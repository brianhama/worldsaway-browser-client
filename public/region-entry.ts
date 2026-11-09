import type { WorldState } from './types.js';

const TRAVEL_REQUESTS = new Set([103, 1202, 2351, 4102, 20907, 3106, 3117]);

/** HereIs replaces the displayed scene but can also refresh the current room.
 * Announce changed regions and successful travel, rather than peer updates. */
export class RegionEntryTracker {
    private context = '';
    private sequence = 0;
    private announcedScene = '';
    private observedScene = '';
    private regionSignature = '';
    private pendingAnnouncement = false;
    private pendingSignature = false;

    reset() {
        this.context = ''; this.sequence = 0; this.announcedScene = '';
        this.observedScene = ''; this.regionSignature = '';
        this.pendingAnnouncement = false; this.pendingSignature = false;
    }

    ingest(state: WorldState) {
        if (state.status !== 'connected') {
            this.reset();
            return { scene: '', message: null };
        }
        const context = JSON.stringify([state.worldName ?? '', state.avatar ?? '']);
        if (context !== this.context) {
            this.reset();
            this.context = context;
        }
        // Bounded history eventually evicts HereIs. Preserve its sequence until
        // the next delivery, including when SSE repeats an older snapshot.
        const previousSequence = this.sequence;
        for (const event of state.history ?? [])
            if (event.type === 'message' && Number(event.id) === 101 && Number(event.noid) === 0)
                this.sequence = Math.max(this.sequence, Number(event.seq) || 0);
        const scene = `${context}:${this.sequence}`;
        const region = state.region ?? state.objects?.find(object => Number(object.noid) === 0);
        const name = region?.fields?.name ?? region?.name;
        const named = typeof name === 'string' && Boolean(name.trim());
        const signature = named ? JSON.stringify([name, region?.fields?.imageURL ?? '', region?.fields?.areaCode ?? '']) : '';
        if (scene !== this.observedScene) {
            // The native schema has no persistent region ID. A correlated
            // successful exit also identifies travel between identical scenes.
            const travelled = (state.history ?? []).some(event => event.type === 'message'
                && Number(event.id) === 70 && TRAVEL_REQUESTS.has(Number(event.requestId))
                && Number(event.fields?.success) === 0
                && Number(event.seq) > previousSequence && Number(event.seq) < this.sequence);
            this.pendingAnnouncement = !this.regionSignature || Boolean(signature && signature !== this.regionSignature) || travelled;
            this.pendingSignature = !named;
            this.observedScene = scene;
        }
        else if (this.pendingSignature && named) {
            this.pendingAnnouncement ||= !this.regionSignature || signature !== this.regionSignature;
            this.pendingSignature = false;
        }
        if (signature)
            this.regionSignature = signature;
        if (scene === this.announcedScene || !this.pendingAnnouncement || !named)
            return { scene, message: null };
        this.announcedScene = scene;
        this.pendingAnnouncement = false;
        return { scene, message: { kind: 'system', author: 'World', text: `You arrived in ${name}.` } };
    }
}
