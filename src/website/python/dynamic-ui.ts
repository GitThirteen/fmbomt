import type { ParameterSpec, Metadata } from './pyodide.worker';

type AttrValue = string | number | boolean | null | undefined;

interface ElementOptions {
    text?: string;
    className?: string;
    attrs?: Record<string, AttrValue>;
    children?: (Node | string)[];
    events?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/** Create an element with safe text content, attributes, and child nodes. */
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);

    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;

    if (options.attrs) {
        for (const [key, value] of Object.entries(options.attrs)) {
            if (value === null || value === undefined || value === false) {
                continue;
            }
            if (value === true) {
                node.setAttribute(key, '');
            } else {
                node.setAttribute(key, String(value));
            }
        }
    }

    if (options.events) {
        for (const [evt, listener] of Object.entries(options.events)) {
            if (listener) {
                node.addEventListener(evt, listener as EventListener);
            }
        }
    }

    if (options.children) {
        node.append(...options.children);
    }

    return node;
}

let instanceCounter = 0;

export interface RenderOptions {
    /** Called whenever a slider is dragged. */
    onInput?: (key: string, value: number) => void;
    /** Called when a user commits a change (releases the slider). */
    onChange?: (key: string, value: number) => void;
}

/**
 * Render the model name + parameter sliders into `container`, replacing its
 * children. All values are treated as plain text.
 */
export function renderParameterUI(
    container: HTMLElement,
    metadata: Metadata,
    parameters: Record<string, ParameterSpec>,
    options: RenderOptions = {},
): void {
    container.replaceChildren();

    if (metadata?.name) {
        container.append(el('div', { className: 'dyn-ui__title', text: metadata.name }));
    }

    const entries = Object.entries(parameters ?? {});
    if (entries.length === 0) return;

    const instanceId = ++instanceCounter;
    const list = el('div', { className: 'dyn-ui__params' });

    entries.forEach(([key, spec]) => {
        // Sanitize key for use in HTML ID tokens
        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        const inputId = `dyn-param-${instanceId}-${safeKey}`;

        const min = Number.isFinite(spec.min) ? spec.min : 0;
        const max = Number.isFinite(spec.max) ? spec.max : 100;
        const step = Number.isFinite(spec.step) ? spec.step : 1;
        const initialVal = Number.isFinite(spec.val) ? spec.val : min;

        const label = el('label', {
            className: 'dyn-ui__label',
            text: spec.label ?? key,
            attrs: { for: inputId },
        });

        const output = el('output', {
            className: 'dyn-ui__value',
            text: String(initialVal),
            attrs: { for: inputId },
        });

        const input = el('input', {
            className: 'dyn-ui__slider',
            attrs: {
                id: inputId,
                type: 'range',
                min,
                max,
                step,
                value: initialVal,
            },
            events: {
                input: () => {
                    const numVal = input.valueAsNumber;
                    output.textContent = input.value;
                    options.onInput?.(key, numVal);
                },
                change: () => {
                    options.onChange?.(key, input.valueAsNumber);
                },
            },
        });

        list.append(
            el('div', {
                className: 'dyn-ui__row',
                children: [label, input, output],
            }),
        );
    });

    container.append(list);
}