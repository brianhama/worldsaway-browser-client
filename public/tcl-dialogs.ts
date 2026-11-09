import type { TclVisualHost } from './tcl-host.js';
import type { TclControl, TclDialog, TclDialogUpdate } from './tcl-types.js';
interface DialogControlView {
    wrapper: HTMLDivElement;
    input: any;
    graphicKey?: string;
}
interface DialogView {
    node: HTMLDialogElement;
    title: HTMLHeadingElement;
    body: HTMLDivElement;
    controls: Map<string, DialogControlView>;
    model: TclDialog;
}
/** DOM controls for native Tcl dialog models. Callback programs go back to the
 * Tcl interpreter; no callback is evaluated as browser JavaScript. */
export class TclDialogs {
    declare host: TclVisualHost;
    declare onError: (error: any) => void;
    declare windows: Map<string, DialogView>;
    constructor({ host, onError = () => { } }: {
        host: TclVisualHost;
        onError?: (error: any) => void;
    }) { this.host = host; this.onError = onError; this.windows = new Map(); }
    /** Reconcile a native dialog model by stable control IDs, preserving existing
     * DOM inputs across updates instead of discarding focus on every host change. */
    render(model: TclDialogUpdate) {
        let view = this.windows.get(model.id);
        if (model.closed) {
            if (view) {
                view.node.close();
                view.node.remove();
                this.windows.delete(model.id);
            }
            return;
        }
        if (!view) {
            const node = document.createElement('dialog'), header = document.createElement('header'), title = document.createElement('h2'), close = document.createElement('button'), body = document.createElement('div');
            node.className = 'wa-tcl-dialog';
            body.className = 'wa-tcl-dialog-body';
            close.type = 'button';
            close.textContent = '×';
            close.setAttribute('aria-label', 'Close native dialog');
            header.append(title, close);
            node.append(header, body);
            document.body.append(node);
            view = { node, title, body, controls: new Map(), model };
            this.windows.set(model.id, view);
            const cancel = async () => { const button = view!.model.controls.find((control) => control.type === 'escapeButton' && control.enabled && control.visible); try {
                if (button)
                    await this.activate(view!, button.id);
                else
                    await this.host.dispatch('dialogKill', [model.id]);
            }
            catch (error) {
                this.onError(error);
            } };
            close.addEventListener('click', cancel);
            node.addEventListener('cancel', (event: any) => { event.preventDefault(); cancel(); });
            node.addEventListener('keydown', (event: any) => { if (event.key === 'Enter' && !event.shiftKey && event.target.tagName !== 'TEXTAREA') {
                const button = view!.model.controls.find((control) => control.default && control.enabled && control.visible);
                if (button) {
                    event.preventDefault();
                    this.activate(view!, button.id).catch(this.onError);
                }
            } });
        }
        view.model = model;
        view.title.textContent = model.title;
        view.node.setAttribute('aria-label', model.title);
        view.body.style.width = `${model.width}px`;
        view.body.style.height = `${model.height}px`;
        const ids = new Set(model.controls.map((control) => control.id));
        for (const [id, entry] of view.controls)
            if (!ids.has(id)) {
                entry.wrapper.remove();
                view.controls.delete(id);
            }
        for (const control of model.controls)
            this.control(view, control);
        if (model.visible && !view.node.open)
            view.node.showModal();
        else if (!model.visible && view.node.open)
            view.node.close();
    }
    // A button callback can read values from every control, including text
    // inputs that have not emitted a change event yet. Snapshot them first.
    synchronize(view: DialogView) { for (const [id, entry] of view.controls) {
        const model = this.host.control(view.model.id, id);
        if (['input', 'textarea', 'editcombo'].includes(model.type))
            model.value = entry.input.value;
        else if (['checkbox', 'radio'].includes(model.type))
            model.value = entry.input.checked ? 1 : 0;
        else if (['list', 'combo'].includes(model.type)) {
            model.selected = entry.input.selectedIndex;
            if (model.type === 'combo')
                model.value = entry.input.value;
        }
    } }
    async activate(view: DialogView, id: string, change: {
        value?: any;
        selected?: number;
    } = {}) { this.synchronize(view); return this.host.activateControl(view.model.id, id, change); }
    // Native coordinates are absolute within the dialog. DOM elements supply
    // input semantics while the model retains native callback and selection data.
    control(view: DialogView, model: TclControl) {
        let entry = view.controls.get(model.id);
        if (!entry) {
            const wrapper = document.createElement('div');
            wrapper.className = `wa-tcl-control wa-tcl-${model.type}`;
            let input: any;
            if (['button', 'defaultButton', 'escapeButton'].includes(model.type)) {
                input = document.createElement('button');
                input.type = 'button';
                input.addEventListener('click', () => this.activate(view, model.id).catch(this.onError));
            }
            else if (model.type === 'textarea')
                input = document.createElement('textarea');
            else if (['list', 'combo'].includes(model.type)) {
                input = document.createElement('select');
                if (model.type === 'list')
                    input.size = Math.max(2, Math.floor(model.height / 15));
                input.addEventListener('change', () => this.activate(view, model.id, { selected: input.selectedIndex }).catch(this.onError));
            }
            else if (['checkbox', 'radio'].includes(model.type)) {
                input = document.createElement('input');
                input.type = model.type;
                const label = document.createElement('label');
                label.append(input, document.createTextNode(''));
                wrapper.append(label);
                input.addEventListener('change', () => this.activate(view, model.id, { value: input.checked ? 1 : 0 }).catch(this.onError));
            }
            else if (['input', 'editcombo'].includes(model.type)) {
                input = document.createElement('input');
                input.type = 'text';
                if (model.type === 'editcombo') {
                    const options = document.createElement('datalist');
                    options.id = `tcl-options-${this.windows.size}-${view.controls.size}`;
                    input.setAttribute('list', options.id);
                    wrapper.append(options);
                }
            }
            else if (model.type === 'group') {
                input = document.createElement('fieldset');
                input.append(document.createElement('legend'));
            }
            else if (model.type === 'graphic') {
                input = document.createElement('canvas');
                input.width = Math.max(1, model.width);
                input.height = Math.max(1, model.height);
            }
            else
                input = document.createElement('span');
            if (!input.parentElement)
                wrapper.append(input);
            view.body.append(wrapper);
            entry = { wrapper, input };
            view.controls.set(model.id, entry);
            if (['input', 'editcombo', 'textarea'].includes(model.type)) {
                input.addEventListener('input', () => { this.host.control(view.model.id, model.id).value = input.value; });
                input.addEventListener('change', () => { if (this.host.control(view.model.id, model.id).callback)
                    this.activate(view, model.id, { value: input.value }).catch(this.onError); });
            }
        }
        const { wrapper, input } = entry;
        wrapper.style.left = `${model.x}px`;
        wrapper.style.top = `${model.y}px`;
        wrapper.style.width = `${model.width}px`;
        wrapper.style.height = `${model.height}px`;
        wrapper.hidden = !model.visible;
        input.disabled = !model.enabled;
        input.setAttribute('aria-label', model.text || model.id);
        if (['input', 'editcombo', 'textarea'].includes(model.type)) {
            if (input.value !== String(model.value))
                input.value = String(model.value);
            input.maxLength = model.maxLength;
            if (model.password)
                input.type = 'password';
            if (model.type === 'editcombo') {
                const options = wrapper.querySelector('datalist');
                options!.replaceChildren(...model.items.map((item) => { const option = document.createElement('option'); option.value = item.text; return option; }));
            }
        }
        else if (['list', 'combo'].includes(model.type)) {
            const selected = model.selected;
            input.replaceChildren(...model.items.map((item) => { const option = document.createElement('option'); option.textContent = item.text; option.disabled = !item.enabled; return option; }));
            input.selectedIndex = selected;
        }
        else if (['checkbox', 'radio'].includes(model.type)) {
            if (model.type === 'radio')
                input.name = `${view.model.id}:${model.group ?? 'root'}`;
            input.checked = Boolean(Number(model.value));
            input.parentElement.lastChild.textContent = model.text;
        }
        else if (model.type === 'group')
            input.firstChild.textContent = model.text;
        else if (model.type === 'graphic') {
            const key = JSON.stringify(model.value);
            if (entry.graphicKey !== key) {
                entry.graphicKey = key;
                this.host.drawGraphic?.(input, model).catch(this.onError);
            }
        }
        else
            input.textContent = model.text;
        input.classList.toggle('native-default-control', Boolean(model.default));
    }
    destroy() { for (const view of this.windows.values()) {
        view.node.close();
        view.node.remove();
    } this.windows.clear(); }
}
