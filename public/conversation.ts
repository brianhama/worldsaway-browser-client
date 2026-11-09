/** Align transcript balloons with the same rendered bounds as their speakers.
 * Canvas bounds include seated poses, attached heads and walking interpolation. */
import type { ObjectBounds } from './renderer.js';

export function roomMessageLeft(speakerX: number, messageWidth: number, paneWidth: number) {
    return Math.max(0, Math.min(Math.max(0, paneWidth - messageWidth), speakerX - messageWidth / 2));
}

export class ConversationPane {
    private anchors = new Map<number, number>();
    private rows = new Map<HTMLElement, { noid: number; width: number }>();
    private signature = '';
    private bounds: readonly ObjectBounds[] = [];
    private worldWidth = 512;
    private observer: ResizeObserver;
    private pinnedAtBottom = true;

    constructor(private log: HTMLElement, private canvas: HTMLCanvasElement) {
        this.observer = new ResizeObserver(() => this.layout(this.bounds, this.worldWidth, true));
        this.observer.observe(log);
        this.observer.observe(canvas);
        log.addEventListener('scroll', () => {
            this.pinnedAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
        }, { passive: true });
        document.fonts?.ready.then(() => this.layout(this.bounds, this.worldWidth, true));
    }

    add(row: HTMLElement, speakerNoid?: number) {
        const noid = Number.isInteger(speakerNoid) && speakerNoid! > 0 ? speakerNoid! : 0;
        row.classList.add('room-message');
        row.dataset.speakerNoid = String(noid);
        const width = row.querySelector<HTMLElement>('.message-content')?.getBoundingClientRect().width ?? 0;
        this.rows.set(row, { noid, width });
        this.position(row, noid, width);
    }

    private position(row: HTMLElement, noid: number, width: number) {
        const content = row.querySelector<HTMLElement>('.message-content');
        if (!content)
            return;
        const x = this.anchors.get(noid) ?? this.log.clientWidth / 2;
        const left = `${roomMessageLeft(x, width, this.log.clientWidth)}px`;
        if (content.style.marginLeft !== left)
            content.style.marginLeft = left;
    }

    layout(bounds: readonly ObjectBounds[], worldWidth: number, force = false) {
        this.bounds = bounds;
        this.worldWidth = worldWidth;
        const scene = this.canvas.getBoundingClientRect(), pane = this.log.getBoundingClientRect();
        const offset = scene.left - pane.left - this.log.clientLeft, scale = scene.width / worldWidth;
        const signature = `${offset}:${scale}:${this.log.clientWidth}:` + bounds.map(bound => `${bound.object.noid},${bound.x + bound.width / 2}`).join(';');
        if (!force && signature === this.signature)
            return;
        this.signature = signature;
        for (const bound of bounds)
            this.anchors.set(Number(bound.object.noid), offset + (bound.x + bound.width / 2) * scale);
        // Measure only when wrapping can change, and finish all reads before
        // moving rows. Walking frames can reuse the cached balloon widths.
        for (const [row, item] of this.rows) {
            if (row.parentElement !== this.log)
                this.rows.delete(row);
            else if (force)
                item.width = row.querySelector<HTMLElement>('.message-content')?.getBoundingClientRect().width ?? 0;
        }
        for (const [row, item] of this.rows)
            this.position(row, item.noid, item.width);
        if (force && this.pinnedAtBottom)
            this.log.scrollTop = this.log.scrollHeight;
    }

    resetScene() { this.anchors.clear(); this.signature = ''; }
    clear() { this.rows.clear(); }
}
