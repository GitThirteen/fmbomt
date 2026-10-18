import { type Component, componentPdf, getComponents } from './groundtruth';

/* ---------------------------------------------------------------------------
 * Sampling from the drawn mixture.
 * ------------------------------------------------------------------------- */

export interface SamplerRNG {
    (): number;
    normal: () => number;
}

/**
 * Mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random` because the Seed field must be reproducible across
 * reloads and machines, which a global RNG cannot guarantee. Paired with a cached
 * Box-Muller generator.
 */
export function createRNG(seed: number): SamplerRNG {
    let a = seed >>> 0;
    let hasSpare = false;
    let spare = 0;

    const next = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const normal = (): number => {
        if (hasSpare) {
            hasSpare = false;
            return spare;
        }

        const u = Math.max(Number.EPSILON, next());
        const v = next();
        const mag = Math.sqrt(-2.0 * Math.log(u));

        spare = mag * Math.sin(2.0 * Math.PI * v);
        hasSpare = true;
        return mag * Math.cos(2.0 * Math.PI * v);
    };

    const rng = next as SamplerRNG;
    rng.normal = normal;
    return rng;
}

/** Gamma(shape, 1) via Marsaglia–Tsang (2000). */
function sampleGamma(rng: SamplerRNG, shape: number): number {
    if (shape <= 0) return 0;

    const isBoosted = shape < 1;
    const a = isBoosted ? shape + 1 : shape;
    const d = a - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
        const x = rng.normal();
        const v = 1 + c * x;

        if (v <= 0) continue;

        const v3 = v * v * v;
        const u = rng();
        const x2 = x * x;

        // Fast squeeze test
        if (u < 1 - 0.0331 * x2 * x2) {
            const out = d * v3;
            return isBoosted ? out * Math.pow(rng(), 1 / shape) : out;
        }

        // Full log-ratio test
        if (Math.log(u) < 0.5 * x2 + d * (1 - v3 + Math.log(v3))) {
            const out = d * v3;
            return isBoosted ? out * Math.pow(rng(), 1 / shape) : out;
        }
    }
}

/**
 * Von Mises using Best–Fisher rejection sampling (1979).
 */
function sampleVonMises(mean: number, kappa: number, rng: SamplerRNG): number {
    if (kappa < 1e-6) {
        return mean + (rng() * 2 - 1) * Math.PI;
    }

    const tau = 1 + Math.sqrt(1 + 4 * kappa * kappa);
    const rho = (tau - Math.sqrt(2 * tau)) / (2 * kappa);
    const r = (1 + rho * rho) / (2 * rho);

    while (true) {
        const u1 = rng();
        const z = Math.cos(Math.PI * u1);
        const f = (1 + r * z) / (r + z);
        const c = kappa * (r - f);

        const u2 = rng();
        if (u2 < c * (2 - c) || Math.log(u2) <= c - 1) {
            const u3 = rng();
            const theta = Math.acos(f);
            const sign = u3 < 0.5 ? -1 : 1;
            return mean + sign * theta;
        }
    }
}

/** Draw one value from a single component. */
export function sampleComponent(c: Component, rng: SamplerRNG): number {
    switch (c.family) {
        case 'gaussian':
            return c.mean + Math.max(1e-3, c.sigma) * rng.normal();

        case 'uniform': {
            const lo = Math.min(c.lower, c.upper);
            const hi = Math.max(c.lower, c.upper);
            return lo + (hi - lo) * rng();
        }

        case 'exponential':
            // Avoid Math.log(0) by using 1 - rng() where rng() in [0, 1)
            return -Math.log(1 - rng()) / Math.max(1e-6, c.rate);

        case 'beta': {
            const a = Math.max(1e-2, c.alpha);
            const b = Math.max(1e-2, c.beta);
            const x = sampleGamma(rng, a);
            const y = sampleGamma(rng, b);
            return x + y === 0 ? 0 : x / (x + y);
        }

        case 'cauchy':
            return c.location + Math.max(1e-3, c.scale) * Math.tan(Math.PI * (rng() - 0.5));

        case 'vonmises':
            return sampleVonMises(c.mean, Math.max(0, c.kappa), rng);

        default:
            return (c as { mean?: number }).mean ?? 0;
    }
}

/**
 * Draw `n` samples from the current mixture.
 */
export function drawSamples(n: number, seed: number, components = getComponents()): Float64Array {
    if (components.length === 0 || n <= 0) return new Float64Array(0);

    const rng = createRNG(seed);
    const total = components.reduce((sum, c) => sum + c.weight, 0);
    if (total <= 0) return new Float64Array(0);

    // Cumulative CDF for O(log K) binary search
    const numComponents = components.length;
    const cumulative = new Float64Array(numComponents);
    let running = 0;

    for (let i = 0; i < numComponents; i++) {
        running += components[i]!.weight / total;
        cumulative[i] = running;
    }

    cumulative[numComponents - 1] = 1.0; // hard-code ceiling to guarantee that CDF is well-formed

    const pick = (): Component => {
        const u = rng();
        let low = 0;
        let high = numComponents - 1;

        while (low < high) {
            const mid = (low + high) >>> 1;
            if (u <= cumulative[mid]!) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return components[low]!;
    };

    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = sampleComponent(pick(), rng);
    }

    return out;
}

/**
 * Draw samples by rejection against the mixture density.
 */
export function drawSamplesRejection(n: number, seed: number, lo: number, hi: number): Float64Array {
    const components = getComponents();
    if (components.length === 0 || n <= 0) return new Float64Array(0);

    const rng = createRNG(seed);
    const total = components.reduce((sum, c) => sum + c.weight, 0) || 1;
    const density = (x: number) => components.reduce((sum, c) => sum + (c.weight / total) * componentPdf(c, x), 0);

    let peak = 0;
    const steps = 2000;
    const stepSize = (hi - lo) / steps;

    for (let i = 0; i <= steps; i++) {
        peak = Math.max(peak, density(lo + i * stepSize));
    }

    const out = new Float64Array(n);
    let count = 0;
    let guard = 0;
    const maxTrials = n * 200;

    while (count < n && guard++ < maxTrials) {
        const x = lo + (hi - lo) * rng();
        if (rng() * peak <= density(x)) {
            out[count++] = x;
        }
    }

    return count === n ? out : out.slice(0, count);
}
