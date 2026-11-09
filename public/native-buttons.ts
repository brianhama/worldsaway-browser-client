/** Original Windows toolbar cells, extracted from RT_BITMAP 15390/15391.
 * Artwork is supplied separately; source-only builds retain an authored fallback. */
const controls: Record<string, string> = {
    west: '00', north: '01', south: '02', east: '03', ghost: '04', materialize: '05',
    normal: '06', happy: '07', sad: '08', mad: '09', wave: '10', bow: '11',
    shrug: '12', present: '13', jump: '14', react: '15', 'turn-left': '16', 'turn-right': '17',
    'turn-around': '18', time: '19', tokens: '20',
};
const speech: Record<string, string> = { say: '00', think: '01', esp: '02', mail: '02' };
const symbols: Record<string, string> = {
    west: '←', north: '↑', south: '↓', east: '→', ghost: '○', materialize: '♙',
    normal: '·', happy: '☺', sad: '☹', mad: '!', wave: '↗', bow: '↘', shrug: '?',
    present: '↔', jump: '⇧', react: '⇩', 'turn-left': '↶', 'turn-right': '↷', 'turn-around': '↵',
    time: '◷', tokens: '◉', say: 'S', think: 'T', esp: 'E', mail: 'M',
};

interface NativeButton {
    image: HTMLImageElement;
    button: HTMLButtonElement;
    base: string;
    speech: boolean;
    pointerId: number | null;
    pointerInside: boolean;
    activationKey: string | null;
    fallback: boolean;
    symbol: string;
}

function fallbackImage(symbol: string, pressed: boolean): string {
    const light = pressed ? '#808080' : '#fff', dark = pressed ? '#fff' : '#404040';
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="29" height="28"><path fill="#c0c0c0" d="M0 0h29v28H0z"/><path fill="none" stroke="${light}" d="M.5 27V.5H28"/><path fill="none" stroke="${dark}" d="M28.5 0v27.5H0"/><text x="${pressed ? 15.5 : 14.5}" y="${pressed ? 22 : 21}" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#202020">${symbol}</text></svg>`);
}

function render(entry: NativeButton): void {
    const { image, button } = entry;
    const focused = button.matches(':focus-visible'), selected = button.classList.contains('active');
    const pressed = !button.disabled && (entry.pointerId !== null && entry.pointerInside
        || entry.activationKey !== null || !entry.speech && selected);
    // Columns 2/3 supply the native keyboard-focus mark. Controls also have
    // embossed disabled cells at 4/5; speech uses 4–7 for selected states.
    const state = button.disabled ? (entry.speech ? (focused ? 2 : 0) : focused ? 5 : 4)
        : (focused ? 2 : 0) + (pressed ? 1 : 0) + (entry.speech && selected ? 4 : 0);
    const src = entry.fallback ? fallbackImage(entry.symbol, pressed || selected)
        : `${entry.base}${state ? `-state-${state}` : ''}.png`;
    button.classList.toggle('native-button-bitmap-focus', focused && !entry.fallback);
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
            speech: isSpeech, pointerId: null, pointerInside: false, activationKey: null,
            fallback: false, symbol: symbols[name] ?? '·',
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
        button.addEventListener('pointerdown', event => {
            if (!button.disabled && event.button === 0 && entry.pointerId === null) {
                entry.pointerId = event.pointerId;
                entry.pointerInside = true;
                render(entry);
            }
        });
        button.addEventListener('pointerleave', event => {
            if (entry.pointerId === event.pointerId) { entry.pointerInside = false; render(entry); }
        });
        button.addEventListener('pointerenter', event => {
            // Dragging across another button never presses it. Only a press
            // that began on this button may be resumed after leaving it.
            if (entry.pointerId === event.pointerId) {
                entry.pointerInside = Boolean(event.buttons & 1);
                if (!entry.pointerInside) entry.pointerId = null;
                render(entry);
            }
        });
        button.addEventListener('keydown', event => {
            if (!button.disabled && (event.key === ' ' || event.key === 'Enter') && entry.activationKey === null) {
                entry.activationKey = event.key;
            }
            render(entry);
        });
        button.addEventListener('keyup', event => {
            if (event.key === entry.activationKey) { entry.activationKey = null; render(entry); }
        });
        button.addEventListener('focus', () => render(entry));
        button.addEventListener('blur', () => { cancelPress(entry); render(entry); });
        render(entry);
    }
    const releasePointer = (event: PointerEvent) => {
        for (const entry of entries.values()) {
            if (entry.pointerId !== event.pointerId) continue;
            entry.pointerId = null;
            entry.pointerInside = false;
            render(entry);
        }
    };
    window.addEventListener('pointerup', releasePointer, { capture: true });
    window.addEventListener('pointercancel', releasePointer, { capture: true });
    window.addEventListener('blur', () => {
        for (const entry of entries.values()) { cancelPress(entry); render(entry); }
    });
    // A focused button can gain or lose :focus-visible when the user changes
    // input methods without moving focus. Read the browser's final state.
    const refreshFocus = () => queueMicrotask(() => {
        for (const entry of entries.values()) render(entry);
    });
    window.addEventListener('keydown', refreshFocus, { capture: true });
    window.addEventListener('pointerdown', refreshFocus, { capture: true });
    // Disabled states also change after exit availability and Tcl updates. Watch
    // the final DOM attributes instead of rendering an intermediate snapshot.
    const observer = new MutationObserver(records => {
        for (const button of new Set(records.map(record => record.target as HTMLButtonElement))) {
            const entry = entries.get(button);
            if (entry) { if (button.disabled) cancelPress(entry); render(entry); }
        }
    });
    for (const button of entries.keys()) observer.observe(button, { attributes: true, attributeFilter: ['disabled', 'class'] });
}

function cancelPress(entry: NativeButton): void {
    entry.pointerId = null;
    entry.pointerInside = false;
    entry.activationKey = null;
}
