import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeButtonImages } from '../../dist/public/native-buttons.js';

function harness(t, names = ['west', 'east', 'say']) {
    const oldWindow = globalThis.window, oldObserver = globalThis.MutationObserver;
    const window = globalThis.window = new EventTarget();
    let observer;
    globalThis.MutationObserver = class {
        constructor(callback) { observer = callback; }
        observe() {}
    };
    t.after(() => {
        if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
        if (oldObserver === undefined) delete globalThis.MutationObserver; else globalThis.MutationObserver = oldObserver;
    });
    const classList = () => {
        const values = new Set();
        return { contains: value => values.has(value), toggle(value, enabled) {
            if (enabled) values.add(value); else values.delete(value);
        } };
    };
    const controls = names.map(name => {
        const button = Object.assign(new EventTarget(), { disabled: false, focusVisible: false,
            classList: classList(), matches: selector => selector === ':focus-visible' && button.focusVisible });
        const image = Object.assign(new EventTarget(), {
            dataset: { nativeIcon: name }, classList: classList(), src: '',
            closest: () => button, getAttribute: name => name === 'src' ? image.src : null,
        });
        return { button, image };
    });
    installNativeButtonImages({ querySelectorAll: () => controls.map(({ image }) => image) });
    return { window, controls, update: button => observer([{ target: button }]) };
}

function fire(target, type, properties = {}) {
    const event = new Event(type);
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
}
const pointer = { button: 0, buttons: 1, pointerId: 7 };
const isPressed = image => /-state-1\.png$/.test(image.src);

test('a held pointer depresses only its original button and can leave, return, or cancel', t => {
    const { window, controls: [first, second] } = harness(t);
    fire(first.button, 'pointerdown', pointer);
    assert(isPressed(first.image));
    fire(first.button, 'pointerleave', pointer);
    fire(second.button, 'pointerenter', pointer);
    assert(!isPressed(first.image));
    assert(!isPressed(second.image), 'dragging onto a different control does not press it');
    fire(first.button, 'pointerenter', pointer);
    assert(isPressed(first.image));
    fire(window, 'pointerup', { pointerId: 8 });
    assert(isPressed(first.image), 'an unrelated pointer cannot release the initiating pointer');
    fire(window, 'pointercancel', { pointerId: 7 });
    assert(!isPressed(first.image));
    fire(first.button, 'pointerenter', pointer);
    assert(!isPressed(first.image), 'a canceled press cannot be resumed');
    fire(first.button, 'pointerdown', { ...pointer, button: 2 });
    assert(!isPressed(first.image), 'a context-menu click does not press the button');
});

test('keyboard and pointer presses release independently and only on their matching events', t => {
    const { window, controls: [first] } = harness(t);
    fire(first.button, 'keydown', { key: ' ' });
    fire(first.button, 'keydown', { key: ' ', repeat: true });
    fire(first.button, 'keyup', { key: 'Shift' });
    assert(isPressed(first.image));
    fire(window, 'pointerup', { pointerId: 7 });
    assert(isPressed(first.image), 'pointer release does not cancel a held activation key');
    fire(first.button, 'pointerdown', pointer);
    fire(first.button, 'keyup', { key: ' ' });
    assert(isPressed(first.image), 'key release does not cancel a held pointer');
    fire(window, 'pointerup', { pointerId: 7 });
    assert(!isPressed(first.image));
    fire(first.button, 'keydown', { key: 'Enter' });
    assert(isPressed(first.image));
    fire(first.button, 'blur');
    assert(!isPressed(first.image));
});

test('disabled and focus changes clear held presses while preserving application selection and fallback', t => {
    const { window, controls: [control, , speech], update } = harness(t);
    fire(control.button, 'pointerdown', pointer);
    control.button.disabled = true;
    update(control.button);
    assert.match(control.image.src, /-state-4\.png$/);
    fire(control.button, 'keydown', { key: 'Enter' });
    control.button.disabled = false;
    update(control.button);
    assert(!isPressed(control.image), 'reenabling does not restore an old press');
    fire(control.button, 'pointerenter', pointer);
    assert(!isPressed(control.image));
    control.button.classList.toggle('active', true);
    update(control.button);
    assert(isPressed(control.image));
    fire(window, 'blur');
    assert(isPressed(control.image), 'application selection is independent of input state');
    control.button.classList.toggle('active', false);
    update(control.button);
    speech.button.disabled = true;
    update(speech.button);
    assert.match(speech.image.src, /speech-00\.png$/);
    assert(speech.image.classList.contains('native-button-dimmed'));
    fire(control.image, 'error');
    assert.match(control.image.src, /^data:image\/svg\+xml,/);
    control.button.disabled = true;
    update(control.button);
    assert(control.image.classList.contains('native-button-dimmed'));
});

test('keyboard focus uses the native released, pressed, and disabled focus cells', t => {
    const { controls: [control], update } = harness(t);
    control.button.focusVisible = true;
    fire(control.button, 'focus');
    assert.match(control.image.src, /-state-2\.png$/);
    assert(control.button.classList.contains('native-button-bitmap-focus'));
    fire(control.button, 'keydown', { key: ' ' });
    assert.match(control.image.src, /-state-3\.png$/);
    fire(control.button, 'keyup', { key: ' ' });
    assert.match(control.image.src, /-state-2\.png$/);
    control.button.disabled = true;
    update(control.button);
    assert.match(control.image.src, /-state-5\.png$/);
    control.button.focusVisible = false;
    fire(control.button, 'blur');
    assert.match(control.image.src, /-state-4\.png$/);
    assert(!control.button.classList.contains('native-button-bitmap-focus'));
    control.button.focusVisible = true;
    fire(control.button, 'focus');
    fire(control.image, 'error');
    assert(!control.button.classList.contains('native-button-bitmap-focus'), 'fallback keeps the CSS focus outline');
});

test('speech selection and keyboard focus use separate native image columns', t => {
    const { controls: [, , speech], update } = harness(t);
    speech.button.classList.toggle('active', true);
    update(speech.button);
    assert.match(speech.image.src, /-state-4\.png$/);
    speech.button.focusVisible = true;
    fire(speech.button, 'focus');
    assert.match(speech.image.src, /-state-6\.png$/);
    fire(speech.button, 'keydown', { key: 'Enter' });
    assert.match(speech.image.src, /-state-7\.png$/);
    fire(speech.button, 'keyup', { key: 'Enter' });
    assert.match(speech.image.src, /-state-6\.png$/);
    speech.button.disabled = true;
    update(speech.button);
    assert.match(speech.image.src, /-state-2\.png$/);
    assert(speech.image.classList.contains('native-button-dimmed'));
});

test('changing input methods refreshes keyboard focus without requiring focus to move', async t => {
    const { window, controls: [control] } = harness(t);
    control.button.focusVisible = true;
    fire(window, 'keydown', { key: 'Shift' });
    await Promise.resolve();
    assert.match(control.image.src, /-state-2\.png$/);
    control.button.focusVisible = false;
    fire(window, 'pointerdown', pointer);
    await Promise.resolve();
    assert.match(control.image.src, /control-00\.png$/);
});
