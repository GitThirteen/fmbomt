/* ---------------------------------------------------------------------------
 * Configurator panel wiring: domain/support, dimension toggle, model &
 * target-distribution parameter visibility, and misc controls. Purely
 * presentational for now — the actual fitting logic is not wired up yet.
 * ------------------------------------------------------------------------- */

/**
 * Supported spaces for the target distribution. `min`/`max` are the numeric
 * bounds used for sampling and rendering; `null` means unbounded on that side.
 * `space` is the mathematical space id that distributions/models can require
 * via `data-requires-space` (e.g. Von Mises needs `circle`). `dim` is the
 * dimensionality the space lives in (S² is inherently 2D).
 */
interface DomainSpec {
    min: number | null;
    max: number | null;
    space: 'real' | 'circle' | 'sphere';
    dim?: '2d';
    label: string; // string (hopefully) understandable to humans
}

const DOMAINS: Record<string, DomainSpec> = {
    real: { min: null, max: null, space: 'real', label: 'ℝ' },
    positive: { min: 0, max: null, space: 'real', label: 'ℝ≥0' },
    'unit-interval': { min: 0, max: 1, space: 'real', label: '[0, 1]' },
    'positive-unit-interval': { min: 0, max: 1, space: 'real', label: '(0, 1]' },
    custom: { min: null, max: null, space: 'real', label: '[a, b]' },
    circle: { min: -Math.PI, max: Math.PI, space: 'circle', label: 'S¹' },
    sphere: { min: null, max: null, space: 'sphere', dim: '2d', label: 'S²' },
};

/** Current domain id. */
let currentDomain = 'unit-interval';

/** Bounds entered for the custom interval (null = unbounded / not set). */
let customMin: number | null = null;
let customMax: number | null = null;

/** Current dimensionality ('1d' | '2d'). */
let currentDimension = '1d';

type DimensionListener = (dim: string) => void;
const dimensionListeners = new Set<DimensionListener>();

/** Subscribe to dimensionality changes. Returns an unsubscribe function. */
export function onDimensionChange(listener: DimensionListener): () => void {
    dimensionListeners.add(listener);
    return () => dimensionListeners.delete(listener);
}

type DomainListener = (domain: string) => void;
const domainListeners = new Set<DomainListener>();

/** Subscribe to domain changes. Returns an unsubscribe function. */
export function onDomainChange(listener: DomainListener): () => void {
    domainListeners.add(listener);
    return () => domainListeners.delete(listener);
}

type TargetListener = (dist: string) => void;
const targetListeners = new Set<TargetListener>();
/**
 * Subscribe to target-distribution changes. Returns an unsubscribe function.
 *
 * The ground-truth store listens here so that switching the distribution family
 * clears whatever was drawn for the previous one.
 */
export function onTargetDistributionChange(listener: TargetListener): () => void {
    targetListeners.add(listener);
    return () => targetListeners.delete(listener);
}

/* ---------------------------------------------------------------------------
 * Sampling settings
 *
 * The General card drives how many samples are drawn, the seed used to draw
 * them, and whether they are shown at all.
 * ------------------------------------------------------------------------- */

export interface SamplingSettings {
    /** How many samples to draw from the mixture. */
    count: number;
    /** Seed for the deterministic RNG, so a sample set is reproducible. */
    seed: number;
    /** Whether the samples are drawn in the visualization. */
    visible: boolean;
}

const sampling: SamplingSettings = { count: 500, seed: 42, visible: true };
const samplingListeners = new Set<(s: SamplingSettings) => void>();

/** The current sampling settings. */
export function getSamplingSettings(): SamplingSettings {
    return { ...sampling };
}

/** Subscribe to sampling-setting changes. Returns an unsubscribe function. */
export function onSamplingChange(listener: (s: SamplingSettings) => void): () => void {
    samplingListeners.add(listener);
    return () => samplingListeners.delete(listener);
}

function notifySampling(): void {
    const snapshot = getSamplingSettings();
    for (const listener of [...samplingListeners]) listener(snapshot);
}

/** The domain currently selected in the configurator. */
export function getCurrentDomain(): string {
    return currentDomain;
}

/** The selected domain's specification (bounds + space). */
export function getDomainSpec(): DomainSpec {
    const spec = DOMAINS[currentDomain] ?? DOMAINS.real!;
    if (currentDomain !== 'custom') return spec;

    // The custom interval takes its bounds from the inputs. Fall back to the
    // static "[a, b]" label while either bound is still unset.
    const lo = customMin;
    const hi = customMax;
    const label = lo !== null && hi !== null ? `[${formatBound(lo)}, ${formatBound(hi)}]` : '[a, b]';
    return { ...spec, min: lo, max: hi, label };
}

/** Format a bound without trailing zeros, e.g. 0 → "0", 1.5 → "1.5". */
function formatBound(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** The dimensionality currently selected in the configurator. */
export function getCurrentDimension(): string {
    return currentDimension;
}

/** Show/hide the model-specific parameter groups based on the chosen model. */
function syncModelParams(model: string): void {
    document.querySelectorAll<HTMLElement>('[data-model-params]').forEach((group) => {
        group.classList.toggle('is-hidden', group.dataset.modelParams !== model);
    });
}

/** Toggle the 1D/2D segmented control. */
function syncDimension(dim: string): void {
    currentDimension = dim;
    document.querySelectorAll<HTMLElement>('.dim-toggle__btn').forEach((btn) => {
        const active = btn.dataset.dim === dim;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    syncAvailability();
    dimensionListeners.forEach((listener) => listener(dim));
}

/** Lock the 1D/2D toggle while a space that only exists in one dimension (S²) is selected. */
function syncDimensionLock(): void {
    const locked = (DOMAINS[currentDomain] ?? DOMAINS.real!).dim === '2d';
    document.querySelectorAll<HTMLButtonElement>('.dim-toggle__btn').forEach((btn) => {
        btn.disabled = locked;
        btn.title = locked ? 'The sphere (S²) is a 2D space.' : '';
    });
}

/**
 * Enable/disable options that only make sense in a given space or
 * dimensionality (e.g. Von Mises needs the circle, vMF needs 2D). A selection
 * that becomes invalid falls back to the first valid option.
 */
function syncAvailability(): void {
    const space = (DOMAINS[currentDomain] ?? DOMAINS.real!).space;

    document.querySelectorAll<HTMLOptionElement>('option[data-requires-space], option[data-requires-dim]').forEach((option) => {
        const spaceOk = option.dataset.requiresSpace === undefined || option.dataset.requiresSpace === space;
        const dimOk = option.dataset.requiresDim === undefined || option.dataset.requiresDim === currentDimension;
        const allowed = spaceOk && dimOk;
        option.disabled = !allowed;
        if (!allowed) {
            const select = option.closest('select');
            if (select && select.value === option.value) {
                const fallback = Array.from(select.options).find((o) => !o.disabled);
                if (fallback) {
                    select.value = fallback.value;
                    select.dispatchEvent(new Event('change'));
                }
            }
        }
    });

    syncDirectionalModel();
}

/**
 * The directional model is a single entry in the model list: von Mises in 1D
 * and its spherical generalisation (von Mises–Fisher) in 2D. Only the label
 * changes; the underlying model id stays `vonmises`. The 2D form is defined on
 * the sphere (S²) and on the circle (S¹); the 1D form only on the circle.
 */
function syncDirectionalModel(): void {
    const option = document.querySelector<HTMLOptionElement>('#fit-model option[value="vonmises"]');
    if (!option) return;
    const space = (DOMAINS[currentDomain] ?? DOMAINS.real!).space;
    option.textContent = currentDimension === '2d'
        ? 'von Mises-Fisher Mixture Model'
        : 'von Mises Mixture Model';
    option.disabled = currentDimension === '2d'
        ? space !== 'sphere' && space !== 'circle'
        : space !== 'circle';
    if (option.disabled) {
        const select = option.closest('select');
        if (select && select.value === option.value) {
            const fallback = Array.from(select.options).find((o) => !o.disabled);
            if (fallback) {
                select.value = fallback.value;
                select.dispatchEvent(new Event('change'));
            }
        }
    }
}

/**
 * Apply a domain: fill in (or clear) the min/max fields and disable them
 * unless the domain is a custom interval, then re-check which options are
 * available in this space. Spaces that only exist in one dimensionality
 * (S² is inherently 2D) switch the 1D/2D toggle accordingly.
 */
function syncDomain(domainId: string): void {
    const spec = DOMAINS[domainId] ?? DOMAINS.real!;
    currentDomain = domainId;

    // Spaces that only exist in one dimensionality (S² is inherently 2D)
    // switch the toggle, which in turn re-runs availability.
    if (spec.dim && spec.dim !== currentDimension) {
        syncDimension(spec.dim);
    } else {
        syncAvailability();
    }
    syncDimensionLock();

    const minInput = document.querySelector<HTMLInputElement>('#domain-min');
    const maxInput = document.querySelector<HTMLInputElement>('#domain-max');
    const isCustom = domainId === 'custom';

    // Entering the custom domain seeds the bounds from the current spec so the
    // inputs start somewhere sensible instead of empty.
    if (isCustom) {
        if (customMin === null && customMax === null && spec.min !== null && spec.max !== null) {
            customMin = spec.min;
            customMax = spec.max;
        }
    }

    const apply = (input: HTMLInputElement | null, value: number | null) => {
        if (!input) return;
        input.disabled = !isCustom;
        input.value = value === null ? '' : String(value);
        // A missing bound means "unbounded" only on an interval-like space. On
        // the circle/sphere the fields don't apply at all, so an infinity
        // placeholder would be misleading.
        const intervalLike = spec.space === 'real';
        input.placeholder = value !== null ? '' : intervalLike ? (input === minInput ? '−∞' : '+∞') : '???';
    };
    apply(minInput, isCustom ? customMin : spec.min);
    apply(maxInput, isCustom ? customMax : spec.max);

    syncAvailability();
    domainListeners.forEach((listener) => listener(domainId));
}

/** Read a bounds input, treating an empty or non-numeric value as unset. */
function readBound(input: HTMLInputElement | null): number | null {
    if (!input || input.value.trim() === '') return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}

/** Re-read the custom bounds and notify listeners if they changed. */
function updateCustomBounds(): void {
    if (currentDomain !== 'custom') return;
    const nextMin = readBound(document.querySelector<HTMLInputElement>('#domain-min'));
    const nextMax = readBound(document.querySelector<HTMLInputElement>('#domain-max'));
    if (nextMin === customMin && nextMax === customMax) return;

    // Keep the interval well-formed: a max at or below the min is rejected,
    // leaving the previous value in place until the user corrects it.
    if (nextMin !== null && nextMax !== null && nextMax <= nextMin) {
        customMin = nextMin;
        return;
    }
    customMin = nextMin;
    customMax = nextMax;
    domainListeners.forEach((listener) => listener(currentDomain));
}

/**
/**
 * Called when the target distribution type changes.
 *
 * Changing the family invalidates whatever was drawn for the previous one, so
 * listeners (the ground-truth store) clear it.
 */
function notifyTargetDistributionChange(dist: string): void {
    for (const listener of [...targetListeners]) listener(dist);
}

/** Initialize all configurator interactivity. */
export function initConfigurator(): void {
    const dimButtons = document.querySelectorAll<HTMLElement>('.dim-toggle__btn');
    dimButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const dim = btn.dataset.dim;
            if (dim) syncDimension(dim);
        });
    });

    const modelSelect = document.querySelector<HTMLSelectElement>('#fit-model');
    modelSelect?.addEventListener('change', () => syncModelParams(modelSelect.value));
    syncModelParams(modelSelect?.value ?? 'gmm');
    syncDirectionalModel();

    const targetSelect = document.querySelector<HTMLSelectElement>('#target-dist');
    targetSelect?.addEventListener('change', () => notifyTargetDistributionChange(targetSelect.value));
    // Push the initial selection so the store starts on the right family.
    if (targetSelect) notifyTargetDistributionChange(targetSelect.value);

    const domainSelect = document.querySelector<HTMLSelectElement>('#domain-mode');
    domainSelect?.addEventListener('change', () => syncDomain(domainSelect.value));
    syncDomain(domainSelect?.value ?? 'unit-interval');

    // Custom interval bounds: live-update the visualization as they're typed.
    const minInput = document.querySelector<HTMLInputElement>('#domain-min');
    const maxInput = document.querySelector<HTMLInputElement>('#domain-max');
    for (const input of [minInput, maxInput]) {
        input?.addEventListener('input', updateCustomBounds);
        input?.addEventListener('change', updateCustomBounds);
    }

    // Sampling settings: count, seed and visibility.
    const countInput = document.querySelector<HTMLInputElement>('#sample-count');
    const seedInput = document.querySelector<HTMLInputElement>('#sample-seed');
    const readCount = () => {
        const value = Number(countInput?.value);
        return Number.isFinite(value) && value >= 1 ? Math.min(100000, Math.floor(value)) : sampling.count;
    };
    const readSeed = () => {
        const value = Number(seedInput?.value);
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : sampling.seed;
    };
    const applySampling = () => {
        const next = { count: readCount(), seed: readSeed(), visible: sampling.visible };
        if (next.count === sampling.count && next.seed === sampling.seed) return;
        sampling.count = next.count;
        sampling.seed = next.seed;
        notifySampling();
    };
    for (const input of [countInput, seedInput]) {
        input?.addEventListener('input', applySampling);
        input?.addEventListener('change', applySampling);
    }

    // The "Show samples" display toggle.
    const samplesCheckbox = document.querySelector<HTMLInputElement>(
        '.cfg-field--toggle:has([data-display="samples"]) input[type="checkbox"]',
    );
    samplesCheckbox?.addEventListener('change', () => {
        sampling.visible = samplesCheckbox.checked;
        notifySampling();
    });
    if (samplesCheckbox) sampling.visible = samplesCheckbox.checked;
}
