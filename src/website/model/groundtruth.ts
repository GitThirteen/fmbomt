import { getDomainSpec, onTargetDistributionChange } from '../ui/configurator';

/* ---------------------------------------------------------------------------
 * File for the definition of the ground-truth distribution, composed by hand 
 * in the visualization.
 *
 * The user plants components directly on the plot, so the "truth" is whatever
 * they draw rather than a fixed formula. Components may come from different
 * families, defined by a heterogeneous mixture:
 *
 *     p(x) = Σ wᵢ * (fᵢ(x) / Σ wⱼ)
 * 
 * ------------------------------------------------------------------------- */

/** The distribution families a component can belong to. */
export type Family = 'gaussian' | 'uniform' | 'exponential' | 'beta' | 'cauchy' | 'vonmises';

/** Every parameter a component can carry, across all families. */
export type ParamKey =
    | 'mean'
    | 'sigma'
    | 'weight'
    | 'lower'
    | 'upper'
    | 'rate'
    | 'alpha'
    | 'beta'
    | 'location'
    | 'scale'
    | 'kappa';

/**
 * A single component of the drawn mixture.
 *
 * All parameter fields are present on every component so the store can be
 * updated uniformly; only the ones listed in `FAMILY_PARAMS[family]` are
 * relevant for a given family.
 */
export interface Component {
    id: number;
    family: Family;
    weight: number;
    mean: number;
    sigma: number;
    lower: number;
    upper: number;
    rate: number;
    alpha: number;
    beta: number;
    location: number;
    scale: number;
    kappa: number;
}

/** The parameters each family exposes, in cycle order. */
const FAMILY_PARAMS: Record<Family, readonly ParamKey[]> = {
    gaussian: ['mean', 'sigma', 'weight'],
    uniform: ['lower', 'upper', 'weight'],
    exponential: ['rate', 'weight'],
    beta: ['alpha', 'beta', 'weight'],
    cauchy: ['location', 'scale', 'weight'],
    vonmises: ['mean', 'kappa', 'weight'],
};

/** Display names for the parameters, used in the on-plot parameter list. */
export const PARAM_LABELS: Record<ParamKey, string> = {
    mean: 'μ',
    sigma: 'σ',
    weight: 'w',
    lower: 'a',
    upper: 'b',
    rate: 'λ',
    alpha: 'α',
    beta: 'β',
    location: 'x₀',
    scale: 'γ',
    kappa: 'κ',
};

/** Display name for each family, used in the parameter list header. */
export const FAMILY_LABELS: Record<Family, string> = {
    gaussian: 'Gaussian',
    uniform: 'Uniform',
    exponential: 'Exponential',
    beta: 'Beta',
    cauchy: 'Cauchy',
    vonmises: 'von Mises',
};

/** Default spread of a freshly drawn lobe, as a fraction of the domain. */
const DEFAULT_SIGMA_FRACTION = 0.09;
const MIN_UNIFORM_WIDTH = 1e-3;

let components: Component[] = [];
let selectedId: number | null = null;
let activeParam: ParamKey = 'mean';
let nextId = 1;
let currentFamily: Family = 'gaussian';

const listeners = new Set<() => void>();

/** Subscribe to ground-truth changes. Returns an unsubscribe function. */
export function onGroundTruthChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify(): void {
    // Snapshot first: a listener may dispose the chart and subscribe a new one
    // (which happens on every re-render). Iterating the live set would then
    // visit the freshly added listener too and recurse indefinitely.
    for (const listener of [...listeners]) listener();
}

/** A copy of the current components, safe to iterate while mutating state. */
export function getComponents(): Component[] {
    return components.map((c) => ({ ...c }));
}

export function getSelectedId(): number | null {
    return selectedId;
}

export function getSelected(): Component | null {
    const found = components.find((c) => c.id === selectedId);
    return found ? { ...found } : null;
}

export function getActiveParam(): ParamKey {
    return activeParam;
}

/** The family newly planted components belong to. */
export function getCurrentFamily(): Family {
    return currentFamily;
}

/** The parameters the given family exposes, in cycle order. */
export function paramsFor(family: Family): ParamKey[] {
    return [...FAMILY_PARAMS[family]];
}

/** Ensure `activeParam` is valid for the given family. */
function syncActiveParam(family: Family): void {
    const allowed = FAMILY_PARAMS[family];
    if (!allowed.includes(activeParam)) {
        activeParam = allowed[0]!;
    }
}

/** Width of the currently selected domain, used to scale defaults and steps. */
function domainWidth(): number {
    const spec = getDomainSpec();
    if (spec.min !== null && spec.max !== null) return Math.abs(spec.max - spec.min) || 1;
    if (spec.space === 'circle') return 2 * Math.PI;
    return 3;
}

/** The domain's numeric range, used to seed per-family defaults. */
function domainBounds(): { min: number; max: number } {
    const spec = getDomainSpec();
    if (spec.min !== null && spec.max !== null) return { min: spec.min, max: spec.max };
    if (spec.space === 'circle') return { min: -Math.PI, max: Math.PI };
    return { min: -1.5, max: 1.5 };
}

/** Default sigma for a new bump, derived from the domain's width. */
export function defaultSigma(): number {
    return Math.max(1e-3, domainWidth() * DEFAULT_SIGMA_FRACTION);
}

/** Compute the effective horizontal anchor of a component for hit-testing and dragging. */
export function componentAnchor(c: Component): number {
    switch (c.family) {
        case 'cauchy':
            return c.location;
        case 'uniform':
            return 0.5 * (c.lower + c.upper);
        case 'exponential':
            return 1 / Math.max(1e-3, c.rate);
        case 'beta': {
            const sum = c.alpha + c.beta;
            return sum > 0 ? c.alpha / sum : 0.5;
        }
        case 'gaussian':
        case 'vonmises':
        default:
            return c.mean;
    }
}

/** Seed a component's parameters with sensible defaults for its family at `at`. */
function makeComponent(id: number, family: Family, at: number): Component {
    const { min, max } = domainBounds();
    const width = Math.max(1e-6, max - min);
    const sigma = defaultSigma();
    const clampedAt = Math.max(min, Math.min(max, at));

    // Ensure uniform bounds stay inside [min, max] with non-zero width
    let lower = Math.max(min, clampedAt - sigma);
    let upper = Math.min(max, clampedAt + sigma);

    if (upper - lower < MIN_UNIFORM_WIDTH) {
        if (lower <= min) upper = Math.min(max, min + MIN_UNIFORM_WIDTH);
        else lower = Math.max(min, max - MIN_UNIFORM_WIDTH);
    }

    const rate = clampedAt > 1e-3 ? 1 / clampedAt : 1 / Math.max(1e-3, width * 0.25);
    const betaMode = Math.max(0.05, Math.min(0.95, (clampedAt - min) / width));
    const concentration = 14;
    const alpha = Math.max(1, betaMode * concentration);
    const beta = Math.max(1, (1 - betaMode) * concentration);

    return {
        id,
        family,
        weight: 1,
        mean: clampedAt,
        sigma,
        lower,
        upper,
        rate,
        alpha,
        beta,
        location: clampedAt,
        scale: Math.max(1e-3, width * 0.08),
        kappa: 4,
    };
}

/** A detached component of `family` at `at`, used for hover previews. */
export function makeGhost(family: Family, at: number): Component {
    return makeComponent(-1, family, at);
}

/** Draw a new lobe of the current family at `mean`. Returns its id. */
export function addComponent(mean: number, family: Family = currentFamily): number {
    const id = nextId++;
    components = [...components, makeComponent(id, family, mean)];
    notify();
    return id;
}

export function deleteComponent(id: number): void {
    const next = components.filter((c) => c.id !== id);
    if (next.length === components.length) return;
    components = next;
    if (selectedId === id) {
        selectedId = null;
        syncActiveParam(currentFamily);
    }
    notify();
}

/** Remove every component and clear the selection. */
export function resetGroundTruth(): void {
    if (components.length === 0 && selectedId === null) return;
    components = [];
    selectedId = null;
    syncActiveParam(currentFamily);
    notify();
}

onTargetDistributionChange((family) => {
    if (!isFamily(family)) return;

    currentFamily = family;
    if (selectedId === null) {
        syncActiveParam(family);
    }

    notify();
});

/** Whether a raw selector value is one of the supported families. */
export function isFamily(value: string): value is Family {
    return Object.prototype.hasOwnProperty.call(FAMILY_PARAMS, value);
}

export function hasComponents(): boolean {
    return components.length > 0;
}

export function select(id: number | null): void {
    if (selectedId === id) return;
    selectedId = id;
    const selected = getSelected();
    syncActiveParam(selected ? selected.family : currentFamily);
    notify();
}

/** Distance between two coordinates, respecting circular topology if active. */
function domainDistance(a: number, b: number): number {
    const diff = Math.abs(a - b);

    if (getDomainSpec().space === 'circle') {
        const tau = 2 * Math.PI;
        const mod = diff % tau;
        return Math.min(mod, tau - mod);
    }

    return diff;
}

/** Select the component whose anchor is nearest to `x`, within `tolerance`. */
export function selectNearest(x: number, tolerance: number): number | null {
    let best: Component | null = null;
    let bestDistance = Infinity;

    for (const c of components) {
        const distance = domainDistance(componentAnchor(c), x);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = c;
        }
    }

    if (!best || bestDistance > tolerance) return null;

    select(best.id);
    return best.id;
}

/** Cycle the active parameter within the selected component's family. */
export function cycleParam(direction: 1 | -1): void {
    const family = getSelected()?.family ?? currentFamily;
    const keys = FAMILY_PARAMS[family];
    const currentIndex = keys.indexOf(activeParam);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const next = (startIndex + direction + keys.length) % keys.length;

    activeParam = keys[next]!;
    notify();
}

/** Per-parameter nudge steps, as a fraction of the domain for unit-scaled ones. */
const STEP: Record<ParamKey, number> = {
    mean: 0.02,
    sigma: 0.01,
    weight: 0.05,
    lower: 0.02,
    upper: 0.02,
    rate: 0.02,
    alpha: 0.05,
    beta: 0.05,
    location: 0.02,
    scale: 0.01,
    kappa: 0.1,
};

/** Parameters measured in domain units, whose steps scale with the domain. */
const UNIT_SCALED = new Set<ParamKey>(['mean', 'sigma', 'lower', 'upper', 'location', 'scale']);

/** Parameters that place a component along the domain's x-axis. */
const LOCATION_PARAMS = new Set<ParamKey>(['mean', 'lower', 'upper', 'location']);

/**
 * Clamp a parameter to its valid range, taking component constraints into account.
 */
function clampParam(param: ParamKey, value: number, component?: Component): number {
    if (param === 'sigma' || param === 'scale') return Math.max(1e-3, value);
    if (param === 'weight' || param === 'rate') return Math.max(1e-3, value);
    if (param === 'alpha' || param === 'beta') return Math.max(1e-2, value);
    if (param === 'kappa') return Math.max(0, value);

    if (LOCATION_PARAMS.has(param)) {
        const { min, max } = domainBounds();
        const clamped = Math.max(min, Math.min(max, value));

        if (component) {
            if (param === 'lower') {
                return Math.min(clamped, component.upper - MIN_UNIFORM_WIDTH);
            }

            if (param === 'upper') {
                return Math.max(clamped, component.lower + MIN_UNIFORM_WIDTH);
            }
        }

        return clamped;
    }

    return value;
}

/**
 * Nudge the selected component's active parameter.
 *
 * `direction` is +1 to grow and -1 to shrink. Every parameter is clamped to a
 * valid range so a component can never become degenerate.
 */
export function nudgeSelected(direction: 1 | -1, param: ParamKey = activeParam): void {
    if (selectedId === null) return;
    const index = components.findIndex((c) => c.id === selectedId);
    if (index === -1) return;

    const current = components[index]!;
    const unit = UNIT_SCALED.has(param) ? domainWidth() : 1;
    const value = clampParam(param, current[param] + STEP[param] * unit * direction, current);
    if (current[param] === value) return;

    const next = [...components];
    next[index] = { ...current, [param]: value };
    components = next;
    notify();
}

/**
 * Overwrite a component's parameters, keeping its id.
 *
 * Used by the visualizer-add to plant the component exactly as previewed, rather than a
 * freshly defaulted one.
 */
export function applyComponent(id: number, patch: Partial<Component>): void {
    const index = components.findIndex((c) => c.id === id);
    if (index === -1) return;
    
    const next = [...components];
    next[index] = { ...next[index]!, ...patch, id };
    components = next;
    notify();
}

/** Set one parameter of the selected component directly (used by dragging). */
export function setSelectedParam(param: ParamKey, value: number): void {
    if (selectedId === null) return;
    const index = components.findIndex((c) => c.id === selectedId);
    if (index === -1) return;

    const current = components[index]!;
    const clamped = clampParam(param, value, current);
    if (current[param] === clamped) return;

    const next = [...components];
    next[index] = { ...current, [param]: clamped };
    components = next;
    notify();
}

/**
 * Move a component's horizontal position without notifying listeners.
 *
 * Updates the relevant location parameter(s) for the component's family so
 * dragging works across Gaussian, Cauchy, Uniform, and von Mises components.
 */
export function moveComponent(id: number, targetX: number): void {
    const index = components.findIndex((c) => c.id === id);
    if (index === -1) return;
    const current = components[index]!;
    const { min, max } = domainBounds();
    const clamped = Math.max(min, Math.min(max, targetX));

    const uniform = (): Component | null => {
        const halfWidth = 0.5 * (current.upper - current.lower);
        const center = Math.max(min + halfWidth, Math.min(max - halfWidth, clamped));
        const lower = center - halfWidth;
        const upper = center + halfWidth;

        if (current.lower === lower && current.upper === upper && current.mean === center) {
            return null;
        }

        return { ...current, mean: center, lower, upper };
    }

    const cauchy = (): Component | null => {
        if (current.location === clamped && current.mean === clamped) {
            return null;
        }

        return { ...current, mean: clamped, location: clamped };
    }

    const beta = (): Component | null => {
        const concentration = Math.max(2, current.alpha + current.beta);
        const mode = Math.max(0.05, Math.min(0.95, (clamped - min) / Math.max(1e-6, max - min)));
        const alpha = Math.max(1, mode * concentration);
        const beta = Math.max(1, (1 - mode) * concentration);

        if (current.alpha === alpha && current.beta === beta && current.mean === clamped) {
            return null;
        }

        return { ...current, mean: clamped, alpha, beta };
    }

    const exponential = (): Component | null => {
        const rate = clamped > 1e-3 
            ? 1 / clamped 
            : 1 / Math.max(1e-3, (max - min) * 0.25);

        if (current.rate === rate && current.mean === clamped) {
            return null;
        }

        return { ...current, mean: clamped, rate };
    }

    const other = (): Component | null => {
        if (current.mean === clamped) {
            return null;
        }

        return { ...current, mean: clamped };
    }

    const handlers: Partial<Record<Component['family'], () => Component | null>> = {
        uniform,
        cauchy,
        beta,
        exponential,
    };

    const updated = (handlers[current.family] ?? other)();
    if (!updated) return;

    const next = [...components];
    next[index] = updated;
    components = next;
}

/**
 * Evaluate the mixture density at `x`.
 *
 * Weights are normalised, so the result integrates to 1 over the domain as
 * long as the components do -- which keeps the curve comparable with the fitted
 * density regardless of how many bumps were drawn.
 */
export function groundTruthPdf(x: number): number {
    return mixturePdf(components, x);
}

/**
 * The mixture density of an arbitrary component list.
 *
 * Used to preview the distribution that *would* result from planting a pending
 * lobe, without having to mutate the store first.
 */
export function mixturePdf(list: Component[], x: number): number {
    if (list.length === 0) return 0;
    const totalWeight = list.reduce((sum, c) => sum + c.weight, 0);
    if (totalWeight <= 0) return 0;
    let density = 0;
    for (const c of list) {
        density += (c.weight / totalWeight) * componentPdf(c, x);
    }
    return density;
}

/**
 * Exponentially scaled modified Bessel function of the first kind, order 0:
 * I0(x) * exp(-|x|). Prevents overflow for large kappa in von Mises PDFs.
 */
function besselI0Scaled(x: number): number {
    const ax = Math.abs(x);
    if (ax < 3.75) {
        const t = x / 3.75;
        const t2 = t * t;
        const i0 =
            1.0 +
            t2 *
                (3.5156229 +
                    t2 *
                        (3.0899424 +
                            t2 *
                                (1.2067492 +
                                    t2 * (0.2659732 + t2 * (0.0360768 + t2 * 0.0045813)))));
        return i0 * Math.exp(-ax);
    }
    const t = 3.75 / ax;
    return (
        (1 / Math.sqrt(ax)) *
        (0.39894228 +
            t *
                (0.01328592 +
                    t *
                        (0.00225319 +
                            t *
                                (-0.00157565 +
                                    t *
                                        (0.00916281 +
                                            t *
                                                (-0.02057706 +
                                                    t *
                                                        (0.02635537 +
                                                            t * (-0.01647633 + t * 0.00392377))))))))
    );
}

/** Lanczos approximation of ln(Gamma(z)), avoiding overflow at large z. */
function logGamma(z: number): number {
    if (z < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    const g = 7;
    const c = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];
    z -= 1;
    let x = c[0]!;
    for (let i = 1; i < g + 2; i++) x += c[i]! / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Evaluate a single component's density at `x`. */
export function componentPdf(component: Component, x: number): number {
    switch (component.family) {
        case 'gaussian': {
            const sigma = Math.max(1e-3, component.sigma);
            const z = (x - component.mean) / sigma;
            return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
        }
        case 'uniform': {
            const lo = Math.min(component.lower, component.upper);
            const hi = Math.max(component.lower, component.upper);
            const width = hi - lo;
            if (width <= 0) return 0;
            return x >= lo && x <= hi ? 1 / width : 0;
        }
        case 'exponential': {
            const rate = Math.max(1e-6, component.rate);
            return x >= 0 ? rate * Math.exp(-rate * x) : 0;
        }
        case 'beta': {
            if (x < 0 || x > 1) return 0;
            const a = Math.max(1e-2, component.alpha);
            const b = Math.max(1e-2, component.beta);

            // With a shape below 1 the density diverges at the edge. The singularity is integrable, but drawing it would produce an
            // infinite peak and a NaN y-axis, so the edge value is evaluated a hair inside the support instead.
            const eps = 1e-6;
            const t = Math.min(1 - eps, Math.max(eps, x));
            const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
            const density = Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t) - logBeta);
            return Number.isFinite(density) ? density : 0;
        }
        case 'cauchy': {
            const scale = Math.max(1e-3, component.scale);
            const z = (x - component.location) / scale;
            return 1 / (Math.PI * scale * (1 + z * z));
        }
        case 'vonmises': {
            const kappa = Math.max(0, component.kappa);
            // exp(kappa * cos(x - mu)) / I0(kappa) = exp(kappa * (cos(x - mu) - 1)) / I0Scaled(kappa)
            return (
                Math.exp(kappa * (Math.cos(x - component.mean) - 1)) /
                (2 * Math.PI * besselI0Scaled(kappa))
            );
        }
        default:
            return 0;
    }
}