import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { python, pythonLanguage } from '@codemirror/lang-python';
import {
    autocompletion,
    closeBrackets,
    type CompletionContext,
    type CompletionResult,
} from '@codemirror/autocomplete';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
    syntaxHighlighting,
    HighlightStyle,
    indentOnInput,
    bracketMatching,
    syntaxTree,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

import type { WorkerRequest, WorkerResponse } from './pyodide.worker';
import { renderParameterUI } from './dynamic-ui';

/* ---------------------------------------------------------------------------
 * Python Code Editor (CodeMirror 6)
 * ------------------------------------------------------------------------- */

const STARTER_CODE = `import numpy as np
from scipy import stats

# 1. App inspects this to dynamically build UI sliders
METADATA = {
    "name": "Gaussian (1D)",
    "dimension": 1  # 1 for curves/histograms, 2 for heatmaps/contours
}

PARAMETERS = {
    "mu":    {"val": 0.0, "min": -5.0, "max": 5.0, "step": 0.1,  "label": "Mean (\\u03bc)"},
    "sigma": {"val": 1.0, "min": 0.1,  "max": 3.0, "step": 0.05, "label": "Std (\\u03c3)"}
}

# 2. Hook: Generate empirical samples
def sample(n, mu, sigma):
    return np.random.normal(mu, sigma, n)

# 3. Hook: Evaluate probability density function over an array of points
def pdf(x, mu, sigma):
    return stats.norm.pdf(x, mu, sigma)

# 4. Hook (Optional): Fit parameters to an empirical sample
def fit(data):
    return {"mu": float(np.mean(data)), "sigma": float(np.std(data))}
`;

const EDITOR_FONT_SIZE = 12;
const EDITOR_LINE_HEIGHT = 1.6;
export const MIN_VISIBLE_LINES = 26;

const editorTheme = EditorView.theme(
    {
        '&': {
            backgroundColor: '#0D0D0D',
            color: '#E6E6E6',
            fontSize: `${EDITOR_FONT_SIZE}px`,
        },
        '.cm-content': {
            fontFamily: "'Maple Mono', 'Courier New', monospace",
            lineHeight: String(EDITOR_LINE_HEIGHT),
            caretColor: '#D7263D',
        },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#D7263D' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: 'rgba(215, 38, 61, 0.28)',
        },
        '.cm-gutters': {
            backgroundColor: '#111111',
            color: '#555555',
            border: 'none',
        },
        '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.05)', color: '#999999' },
        '.cm-tooltip': {
            backgroundColor: '#1A1A1A',
            color: '#E6E6E6',
            border: '1px solid rgba(255, 255, 255, 0.15)',
        },
        '.cm-tooltip-autocomplete ul li[aria-selected]': {
            backgroundColor: '#D7263D',
            color: '#FFFFFF',
        },
        '.cm-diagnostic': { fontFamily: "'Computer Modern Sans', sans-serif" },
        '.cm-diagnostic-error': { borderLeftColor: '#FF5F56' },
        '.cm-diagnostic-warning': { borderLeftColor: '#FFBD2E' },
        '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px dotted #FF5F56' },
        '.cm-lintRange-warning': { backgroundImage: 'none', borderBottom: '2px dotted #FFBD2E' },
    },
    { dark: true },
);

const highlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: '#FF6B81' },
    { tag: [t.name, t.deleted, t.character, t.macroName], color: '#E6E6E6' },
    { tag: [t.propertyName], color: '#F5A623' },
    { tag: [t.function(t.variableName), t.labelName], color: '#F5A623' },
    { tag: [t.number, t.bool, t.null], color: '#7ED0FF' },
    { tag: [t.string, t.special(t.string)], color: '#A8E6A1' },
    { tag: [t.comment], color: '#6A737D', fontStyle: 'italic' },
    { tag: t.operator, color: '#FF6B81' },
    { tag: t.definition(t.variableName), color: '#E6E6E6' },
    { tag: t.className, color: '#F5A623' },
]);

const PYTHON_BUILTINS = [
    'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max',
    'abs', 'round', 'sorted', 'reversed', 'list', 'dict', 'set', 'tuple', 'int', 'float',
    'str', 'bool', 'isinstance', 'type', 'open', 'input', 'format', 'any', 'all',
].map((name) => ({ label: name, type: 'function' as const }));

const API_SNIPPETS = [
    { label: 'np.linspace', type: 'function', detail: 'numpy.linspace(start, stop, num)' },
    { label: 'np.exp', type: 'function', detail: 'numpy.exp(x)' },
    { label: 'np.log', type: 'function', detail: 'numpy.log(x)' },
    { label: 'np.sqrt', type: 'function', detail: 'numpy.sqrt(x)' },
    { label: 'np.random.normal', type: 'function', detail: 'normal(loc, scale, size)' },
    { label: 'stats.norm.pdf', type: 'function', detail: 'scipy.stats.norm.pdf(x, loc, scale)' },
    { label: 'stats.cauchy.pdf', type: 'function', detail: 'scipy.stats.cauchy.pdf(x, loc, scale)' },
    { label: 'stats.beta.pdf', type: 'function', detail: 'scipy.stats.beta.pdf(x, a, b)' },
    { label: 'stats.expon.pdf', type: 'function', detail: 'scipy.stats.expon.pdf(x, scale)' },
    { label: 'stats.vonmises.pdf', type: 'function', detail: 'scipy.stats.vonmises.pdf(x, kappa, loc)' },
    { label: 'curve_fit', type: 'function', detail: 'scipy.optimize.curve_fit(f, xdata, ydata, p0)' },
];

const COMPLETION_OPTIONS = [...PYTHON_BUILTINS, ...API_SNIPPETS];

/** AST-aware linter: flags syntax errors from Lezer and mixed indentation. */
const pythonLinter = linter((view): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    const { doc } = view.state;

    // 1. Check line-level indentation issues
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (/^(?:\t+ | +\t)/.test(line.text)) {
            const indentMatch = /^[ \t]+/.exec(line.text);
            diagnostics.push({
                from: line.from,
                to: line.from + (indentMatch ? indentMatch[0].length : line.length),
                severity: 'warning',
                message: 'Mixed tabs and spaces in indentation.',
            });
        }
    }

    // 2. Walk the Lezer syntax tree to flag parser errors (unclosed brackets,
    // invalid `=` in conditions, malformed statements) outside comments/strings.
    syntaxTree(view.state).iterate({
        enter(node) {
            if (node.type.isError) {
                const from = node.from;
                const to = Math.max(node.to, Math.min(from + 1, doc.length));
                diagnostics.push({
                    from,
                    to,
                    severity: 'error',
                    message: 'Syntax error.',
                });
            }
        },
    });

    return diagnostics;
});

/** Python completion source (builtins + tool API), skipping strings/comments. */
function pythonCompletions(context: CompletionContext): CompletionResult | null {
    const nodeBefore = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (nodeBefore.name === 'Comment' || nodeBefore.name === 'String' || nodeBefore.name === 'FormatString') {
        return null;
    }

    // Require an identifier start so float literals like `1.5` don't trigger completion
    const word = context.matchBefore(/[a-zA-Z_][\w.]*/);
    if (!word && !context.explicit) return null;

    return {
        from: word ? word.from : context.pos,
        options: COMPLETION_OPTIONS,
        validFor: /^[a-zA-Z_][\w.]*$/,
    };
}

/** Create the Python editor inside `parent` and return the EditorView. */
export function createPythonEditor(
    parent: HTMLElement,
    onRun?: () => void,
): EditorView {
    const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        python(),
        pythonLanguage.data.of({ autocomplete: pythonCompletions }),
        autocompletion(),
        pythonLinter,
        lintGutter(),
        syntaxHighlighting(highlightStyle),
        editorTheme,
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
        ]),
    ];

    if (onRun) {
        extensions.unshift(
            Prec.highest(
                keymap.of([
                    {
                        key: 'Mod-Enter',
                        run: () => {
                            onRun();
                            return true;
                        },
                    },
                ]),
            ),
        );
    }

    const state = EditorState.create({
        doc: STARTER_CODE,
        extensions,
    });

    return new EditorView({ state, parent });
}

/** Mount the Python editor into `#code-editor` (if present). */
export function initCodeEditor(): void {
    const container = document.getElementById('code-editor');
    if (!container) return;

    let triggerRun: (() => void) | undefined;
    const view = createPythonEditor(container, () => triggerRun?.());
    initResizeHandles();
    triggerRun = initRunner(view);
}

/* ---------------------------------------------------------------------------
 * Resizable code window
 * ------------------------------------------------------------------------- */

function clampSize(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function initResizeHandles(): void {
    const codeWindow = document.querySelector<HTMLElement>('.code-window');
    const body = document.getElementById('code-editor');
    if (!codeWindow || !body) return;

    const minHeight = 8 * EDITOR_LINE_HEIGHT * EDITOR_FONT_SIZE;

    const bindDrag = (
        handle: HTMLElement,
        onStart: (e: PointerEvent) => void,
        onMove: (e: PointerEvent) => void,
    ) => {
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            onStart(event);

            handle.setPointerCapture(event.pointerId);
            handle.classList.add('is-dragging');

            const cleanup = () => {
                handle.classList.remove('is-dragging');
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('lostpointercapture', cleanup);
            };

            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('lostpointercapture', cleanup);
        });
    };

    const heightHandle = codeWindow.querySelector<HTMLElement>('[data-resize="height"]');
    if (heightHandle) {
        const lineHeight = EDITOR_LINE_HEIGHT * EDITOR_FONT_SIZE;
        const maxHeight = () => Math.round(window.innerHeight * 0.8);
        let startY = 0;
        let startHeight = 0;

        bindDrag(
            heightHandle,
            (event) => {
                startY = event.clientY;
                startHeight = body.getBoundingClientRect().height;
            },
            (event) => {
                const raw = startHeight + (event.clientY - startY);
                const snapped = Math.round(raw / lineHeight) * lineHeight;
                body.style.setProperty('--code-editor-height', `${clampSize(snapped, minHeight, maxHeight())}px`);
            },
        );
    }

}

/* ---------------------------------------------------------------------------
 * Pyodide runner
 * ------------------------------------------------------------------------- */

/** Wire the Run button and status indicator to the editor. Returns the `run` trigger. */
function initRunner(view: EditorView): (() => void) | undefined {
    const runButton = document.getElementById('code-run') as HTMLButtonElement | null;
    const status = document.getElementById('code-status');
    const output = document.getElementById('code-output');
    const outputPre = document.getElementById('code-output-pre');
    if (!runButton || !status || !output || !outputPre) return undefined;

    const defaultButtonLabel = runButton.textContent || 'Run';
    let worker: Worker | null = null;
    let running = false;
    let nextId = 1;
    let activeId = 0;

    const setStatus = (text: string, kind: 'idle' | 'busy' | 'error' = 'idle') => {
        status.textContent = text;
        status.dataset.kind = kind;
    };

    const appendOutput = (text: string) => {
        outputPre.textContent += text + '\n';
    };

    const finishRun = () => {
        running = false;
        runButton.textContent = defaultButtonLabel;
    };

    const ensureWorker = (): Worker => {
        if (worker) return worker;
        worker = new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' });

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.id !== activeId) return;

            switch (message.type) {
                case 'stdout':
                case 'stderr':
                    appendOutput(message.text);
                    break;
                case 'meta': {
                    const container = document.getElementById('dynamic-params');
                    if (container) {
                        renderParameterUI(container, message.metadata, message.parameters);
                    }
                    break;
                }
                case 'error':
                    appendOutput(message.message);
                    setStatus('error', 'error');
                    finishRun();
                    break;
                case 'done':
                    setStatus('done', 'idle');
                    finishRun();
                    break;
            }
        };

        worker.onerror = (err) => {
            appendOutput(err.message || 'Worker crashed unexpectedly.');
            setStatus('error', 'error');
            worker?.terminate();
            worker = null;
            finishRun();
        };

        return worker;
    };

    const stop = () => {
        if (!running) return;
        worker?.terminate();
        worker = null;
        activeId = 0;
        appendOutput('[Execution terminated by user]');
        setStatus('stopped', 'idle');
        finishRun();
    };

    const run = () => {
        if (running) {
            stop();
            return;
        }

        running = true;
        runButton.textContent = 'Stop';

        output.hidden = false;
        outputPre.textContent = '';
        setStatus('running…', 'busy');

        const id = nextId++;
        activeId = id;

        const request: WorkerRequest = { id, code: view.state.doc.toString() };
        ensureWorker().postMessage(request);
    };

    runButton.addEventListener('click', run);
    return run;
}