/// <reference lib="webworker" />

/* ---------------------------------------------------------------------------
 * Pyodide runs entirely inside this Web Worker so that untrusted Python code
 * cannot touch the DOM or the main thread. Access to the `js` and `pyodide`
 * modules is blocked, preventing user code from reaching browser APIs.
 * ------------------------------------------------------------------------- */

const ALLOWED_CDN_PREFIX = 'https://cdn.jsdelivr.net/pyodide/';

/**
 * Lock down network and storage APIs inside the worker before loading Pyodide.
 * Only GET/HEAD requests to the official Pyodide CDN prefix are permitted.
 */
function lockdownWorkerScope(): void {
    const nativeFetch = self.fetch.bind(self);
    const NativeXHR = self.XMLHttpRequest;

    const assertAllowedUrl = (rawUrl: string | URL, method = 'GET'): void => {
        const normalizedMethod = method.toUpperCase();
        if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
            throw new Error(`Blocked network method "${normalizedMethod}" in worker sandbox.`);
        }
        const resolved = new URL(String(rawUrl), self.location.href).href;
        if (!resolved.startsWith(ALLOWED_CDN_PREFIX)) {
            throw new Error(`Blocked network request to "${resolved}" by worker sandbox.`);
        }
    };

    // 1. Restrict fetch() to the Pyodide CDN prefix
    self.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : input;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        try {
            assertAllowedUrl(url, method);
        } catch (err) {
            return Promise.reject(err);
        }
        return nativeFetch(input, { ...init, credentials: 'omit' });
    };

    // 2. Restrict XMLHttpRequest
    class SandboxedXHR extends NativeXHR {
        override open(
            method: string,
            url: string | URL,
            async = true,
            username?: string | null,
            password?: string | null,
        ): void {
            assertAllowedUrl(url, method);
            super.open(method, url, async, username, password);
        }
    }
    self.XMLHttpRequest = SandboxedXHR;

    // 3. Disable side-channel network & origin storage APIs
    const blockedApis = [
        'WebSocket',
        'EventSource',
        'WebTransport',
        'indexedDB',
        'caches',
        'BroadcastChannel',
        'SharedWorker',
    ] as const;

    for (const api of blockedApis) {
        if (api in self) {
            Object.defineProperty(self, api, {
                value: undefined,
                writable: false,
                configurable: false,
            });
        }
    }

    if ('navigator' in self && 'sendBeacon' in self.navigator) {
        Object.defineProperty(self.navigator, 'sendBeacon', {
            value: () => false,
            writable: false,
            configurable: false,
        });
    }
}

lockdownWorkerScope();

interface PyProxy {
    destroy: () => void;
}

type PyodideInterface = {
    runPythonAsync: (code: string, options?: { globals?: PyProxy }) => Promise<unknown>;
    runPython: (code: string, options?: { globals?: PyProxy }) => unknown;
    setStdout: (opts: { batched: (text: string) => void }) => void;
    setStderr: (opts: { batched: (text: string) => void }) => void;
    loadPackagesFromImports: (code: string) => Promise<void>;
    globals: {
        get: (name: string) => (...args: unknown[]) => PyProxy;
    };
};

let pyodidePromise: Promise<PyodideInterface> | null = null;

/** Load Pyodide once and install the sandbox helpers. */
async function getPyodide(): Promise<PyodideInterface> {
    if (!pyodidePromise) {
        pyodidePromise = (async () => {
            const { loadPyodide, version } = await import('pyodide');
            const indexURL = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
            const pyodide = (await loadPyodide({ indexURL })) as unknown as PyodideInterface;
            
            pyodide.runPython(`
def _init_sandbox():
    import sys
    import json

    blocked_roots = frozenset({"js", "pyodide", "pyodide_js", "_pyodide"})
    saved_modules = {}

    class _BlockedModuleFinder:
        def find_spec(self, fullname, path=None, target=None):
            root = fullname.split(".")[0]
            if root in blocked_roots:
                raise ImportError(
                    f"Importing '{fullname}' is disabled for security reasons."
                )
            return None

    finder = _BlockedModuleFinder()
    sys.meta_path.insert(0, finder)

    def _enter_sandbox():
        if finder not in sys.meta_path:
            sys.meta_path.insert(0, finder)
        for name in list(sys.modules.keys()):
            if name.split(".")[0] in blocked_roots:
                saved_modules[name] = sys.modules.pop(name)

    def _exit_sandbox():
        sys.modules.update(saved_modules)
        saved_modules.clear()
        sys.stdout.flush()
        sys.stderr.flush()

    def _extract_meta(ns):
        def _default(obj):
            if hasattr(obj, "item"):
                return obj.item()
            raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

        out = {
            "metadata": ns.get("METADATA", {}),
            "parameters": ns.get("PARAMETERS", {}),
        }
        return json.dumps(out, default=_default)

    return _enter_sandbox, _exit_sandbox, _extract_meta

_enter_sandbox, _exit_sandbox, _extract_meta = _init_sandbox()
del _init_sandbox
`);

            return pyodide;
        })().catch((err) => {
            pyodidePromise = null;
            throw err;
        });
    }
    return pyodidePromise;
}

/** Messages exchanged with the main thread. */
export interface WorkerRequest {
    id: number;
    code: string;
}

export interface ParameterSpec {
    val: number;
    min: number;
    max: number;
    step: number;
    label?: string;
}

export interface Metadata {
    name?: string;
    dimension?: number;
}

export type WorkerResponse =
    | { id: number; type: 'stdout'; text: string }
    | { id: number; type: 'stderr'; text: string }
    | { id: number; type: 'meta'; metadata: Metadata; parameters: Record<string, ParameterSpec> }
    | { id: number; type: 'done' }
    | { id: number; type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const { id, code } = event.data;
    const post = (message: WorkerResponse) => self.postMessage(message);

    try {
        const pyodide = await getPyodide();

        pyodide.setStdout({ batched: (text) => post({ id, type: 'stdout', text }) });
        pyodide.setStderr({ batched: (text) => post({ id, type: 'stderr', text }) });

        // Load required packages before locking down internal modules
        await pyodide.loadPackagesFromImports(code);

        // Create an isolated global namespace for this execution
        const createDict = pyodide.globals.get('dict');
        const userGlobals = createDict();

        try {
            pyodide.runPython('_enter_sandbox()');
            await pyodide.runPythonAsync(code, { globals: userGlobals });
        } finally {
            pyodide.runPython('_exit_sandbox()');
        }

        // Extract METADATA / PARAMETERS from the isolated namespace
        try {
            const extractMeta = pyodide.globals.get('_extract_meta') as unknown as (
                ns: PyProxy,
            ) => string;
            const raw = extractMeta(userGlobals);
            const parsed = JSON.parse(String(raw)) as {
                metadata: Metadata;
                parameters: Record<string, ParameterSpec>;
            };
            post({
                id,
                type: 'meta',
                metadata: parsed.metadata ?? {},
                parameters: parsed.parameters ?? {},
            });
        } catch (metaError) {
            const msg = metaError instanceof Error ? metaError.message : String(metaError);
            post({
                id,
                type: 'stderr',
                text: `Warning: Could not serialize METADATA/PARAMETERS: ${msg}`,
            });
        } finally {
            userGlobals.destroy();
        }

        post({ id, type: 'done' });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        post({ id, type: 'error', message });
    }
};