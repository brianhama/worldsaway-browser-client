/** Original Windows toolbar cells, extracted from RT_BITMAP 15390/15391.
 * Artwork is supplied separately; source-only builds retain an authored fallback. */
const controls: Record<string, string> = {
    west: '00', north: '01', south: '02', east: '03', ghost: '04', materialize: '05',
    normal: '06', happy: '07', sad: '08', mad: '09', wave: '10', bow: '11',
    shrug: '12', show: '13', jump: '14', stomp: '15', drop: '16', pockets: '17',
    inventory: '18', time: '19', tokens: '20',
};
const speech: Record<string, string> = { say: '00', think: '01', esp: '02', mail: '02' };
const symbols: Record<string, string> = {
    west: '←', north: '↑', south: '↓', east: '→', ghost: '○', materialize: '♙',
    normal: '·', happy: '☺', sad: '☹', mad: '!', wave: '↗', bow: '↘', shrug: '?',
    show: '↔', jump: '⇧', stomp: '⇩', drop: '⇓', pockets: '▣', inventory: '▤',
    time: '◷', tokens: '◉', say: 'S', think: 'T', esp: 'E', mail: 'M',
};

interface NativeButton {
    image: HTMLImageElement;
    button: HTMLButtonElement;
    base: string;
    speech: boolean;
    pressed: boolean;
    fallback: boolean;
    symbol: string;
}

function fallbackImage(symbol: string, pressed: boolean): string {
    const light = pressed ? '#808080' : '#fff', dark = pressed ? '#fff' : '#404040';
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="29" height="28"><path fill="#c0c0c0" d="M0 0h29v28H0z"/><path fill="none" stroke="${light}" d="M.5 27V.5H28"/><path fill="none" stroke="${dark}" d="M28.5 0v27.5H0"/><text x="${pressed ? 15.5 : 14.5}" y="${pressed ? 22 : 21}" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#202020">${symbol}</text></svg>`);
}

function render(entry: NativeButton): void {
    const { image, button } = entry;
    const pressed = !button.disabled && (entry.pressed || button.classList.contains('active'));
    // Controls have explicit embossed disabled cells. The speech strip's extra
    // columns are dark/pressed variants, so keep its raised cell when disabled.
    const state = button.disabled ? (entry.speech ? 0 : 4) : pressed ? 1 : 0;
    const src = entry.fallback ? fallbackImage(entry.symbol, pressed)
        : `${entry.base}${state ? `-state-${state}` : ''}.png`;
    image.classList.toggle('native-button-dimmed', button.disabled && (entry.speech || entry.fallback));
    if (image.getAttribute('src') !== src) image.src = src;
}

/** Keep button pictures in sync with pointer, keyboard and application state. */
export function installNativeButtonImages(root: ParentNode = document): void {
    const entries = new Map<HTMLButtonElement, NativeButton>();
    for (const image of root.querySelectorAll<HTMLImageElement>('[data-native-icon]')) {
        const name = image.dataset.nativeIcon ?? '';
        const button = image.closest('button');
        if (!button || !(name in controls || name in speech)) continue;
        const isSpeech = !(name in controls);
        const entry: NativeButton = {
            image, button, base: `/native-icons/${isSpeech ? 'speech' : 'control'}-${isSpeech ? speech[name] : controls[name]}`,
            speech: isSpeech, pressed: false, fallback: false, symbol: symbols[name] ?? '·',
        };
        entries.set(button, entry);
        image.width = 29;
        image.height = 28;
        image.draggable = false;
        image.addEventListener('error', () => {
            // A missing optional extract must not be retried at every snapshot.
            entry.fallback = true;
            render(entry);
        }, { once: true });
        const press = (pressed: boolean) => { entry.pressed = pressed; render(entry); };
        button.addEventListener('pointerdown', event => { if (event.button === 0) press(true); });
        button.addEventListener('pointerleave', () => press(false));
        button.addEventListener('pointerenter', event => { if (event.buttons === 1) press(true); });
        button.addEventListener('pointercancel', () => press(false));
        button.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') press(true); });
        button.addEventListener('keyup', () => press(false));
        button.addEventListener('blur', () => press(false));
        render(entry);
    }
    const release = () => { for (const entry of entries.values()) { entry.pressed = false; render(entry); } };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    // Disabled states also change after exit availability and Tcl updates. Watch
    // the final DOM attributes instead of rendering an intermediate snapshot.
    const observer = new MutationObserver(records => {
        for (const button of new Set(records.map(record => record.target as HTMLButtonElement))) {
            const entry = entries.get(button);
            if (entry) { if (button.disabled) entry.pressed = false; render(entry); }
        }
    });
    for (const button of entries.keys()) observer.observe(button, { attributes: true, attributeFilter: ['disabled', 'class'] });
}
