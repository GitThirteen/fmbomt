import * as d3 from 'd3';
import { getDomainSpec, getSamplingSettings, onDimensionChange, onDomainChange, onSamplingChange } from '../ui/configurator';
import { drawSamples } from '../model/sampling';
import {
    addComponent,
    applyComponent,
    componentPdf,
    type Component,
    cycleParam,
    deleteComponent,
    FAMILY_LABELS,
    getActiveParam,
    getComponents,
    getCurrentFamily,
    getSelectedId,
    groundTruthPdf,
    hasComponents,
    makeGhost,
    mixturePdf,
    moveComponent,
    nudgeSelected,
    onGroundTruthChange,
    PARAM_LABELS,
    type ParamKey,
    paramsFor,
    resetGroundTruth,
    select,
    setTwoDimensional,
} from '../model/groundtruth';

/* ---------------------------------------------------------------------------
 * The visualization.
 *
 * The base of the plot is the selected domain:
 *
 *   interval ([0,1], (0,1], custom)  → a square floor
 *   real / half-line (ℝ, ℝ≥0)        → an open plane (grid, no walls)
 *   circle (S¹)                      → a hemisphere over a disc
 *   sphere (S²)                      → a full sphere
 *
 * 1D mode shows the density as a curve over the domain. 2D mode shows it as a
 * surface over the domain's base, navigated with an arcball camera. On the
 * curved domains the camera is clipped to the visible hemisphere.
 *
 * The data is placeholder for now — the fitting pipeline is not wired up.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Palette
 * ------------------------------------------------------------------------- */

const COLOR = {
    ink: '#111111',
    grid: 'rgba(17, 17, 17, 0.08)',
    gridStrong: 'rgba(17, 17, 17, 0.16)',
    muted: 'rgba(17, 17, 17, 0.55)',
    red: '#D7263D',
    redDark: '#A91C30',
};

/* ---------------------------------------------------------------------------
 * Placeholder data
 * ------------------------------------------------------------------------- */

/** Fitted density: a deliberately imperfect single-Gaussian fit. */
function fitPdf(x: number): number {
    return Math.exp(-0.5 * ((x - 0.05) / 0.5) ** 2) / (0.5 * Math.sqrt(2 * Math.PI));
}

/* ---------------------------------------------------------------------------
 * Drawing tools
 * ------------------------------------------------------------------------- */

/** What a click on the plot does. */
export type Tool = 'select' | 'add' | 'delete' | 'reset';

/** How close (in pixels) a click must land to hit a component. */
const HIT_RADIUS_PX = 22;

let currentTool: Tool = 'select';
let toolSubscriptions: Array<() => void> = [];
/** Whether the last render was made in pen mode, so the y-scale can be reset. */
let wasPen = false;

/** The tool currently armed. */
export function getTool(): Tool {
    return currentTool;
}

/**
 * Arm a tool.
 *
 * Entering pen mode clears the selection: the pen plants new lobes, so leaving
 * an old one highlighted would suggest the shortcuts still edit it.
 */
export function setTool(tool: Tool): void {
    if (currentTool === tool) return;
    currentTool = tool;
    if (tool === 'add' && getSelectedId() !== null) select(null);
    // Snapshot, for the same reason as `notify` in the ground-truth store: a
    // listener may add or remove subscriptions while being notified.
    for (const listener of [...toolSubscriptions]) listener();
}

/**
 * Render the parameter list for a lobe.
 *
 * Every parameter is shown in a small stacked list with the active one
 * highlighted, so the user can see both what the shortcuts will edit now and
 * which parameter comes next when cycling.
 *
 * The list is clamped to the plot rectangle: near an edge it flips to the other
 * side of the anchor, and it is nudged back inside if even that would overflow.
 */
function drawParamList(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    anchorX: number,
    anchorY: number,
    values: Component,
    active: ParamKey,
    bounds: { width: number; height: number },
): void {
    const lineHeight = 13;
    const keys = paramsFor(values.family);
    const rowCount = keys.length;
    // Approximate rendered size, used only for the clamping decision.
    const listWidth = 86;
    const listHeight = (rowCount - 1) * lineHeight + 10;
    const pad = 4;

    // Prefer down-right of the anchor; flip when that would overflow.
    let x = anchorX + 12;
    let y = anchorY;
    if (x + listWidth > bounds.width - pad) x = anchorX - 12 - listWidth;
    if (y + listHeight > bounds.height - pad) y = anchorY - listHeight;
    // Final clamp, so a lobe near a corner cannot push the list out.
    x = Math.max(pad, Math.min(bounds.width - pad - listWidth, x));
    y = Math.max(pad + 8, Math.min(bounds.height - pad - listHeight, y));

    const group = parent
        .append('g')
        .attr('class', 'vis-truth-params')
        .attr('data-family', values.family)
        .attr('transform', `translate(${x},${y})`)
        .attr('pointer-events', 'none');

    group.append('title').text('Shift+Q / Shift+E cycle parameter · Shift+W / Shift+S adjust');

    // The family name heads the list so a heterogeneous mixture stays legible.
    group
        .append('text')
        .attr('class', 'vis-truth-family')
        .attr('x', 0)
        .attr('y', -lineHeight)
        .attr('font-size', 9.5)
        .attr('fill', COLOR.muted)
        .attr('opacity', 0.8)
        .text(FAMILY_LABELS[values.family]);

    keys.forEach((key, index) => {
        const isActive = key === active;
        const row = group
            .append('text')
            .attr('class', 'vis-truth-param')
            .attr('data-param', key)
            .attr('data-active', String(isActive))
            .attr('x', 0)
            .attr('y', index * lineHeight)
            .attr('font-size', 10.5)
            .attr('fill', isActive ? COLOR.red : COLOR.muted)
            .attr('font-weight', isActive ? 700 : 400)
            .attr('opacity', isActive ? 1 : 0.75);
        // The active row gets a marker so the highlight survives a grayscale
        // export as well as being colour-coded on screen.
        row.text(`${isActive ? '▸' : ' '} ${PARAM_LABELS[key]} = ${values[key].toFixed(3)}`);
    });
}

/** The x-position a component is anchored at, for the stem and hover line. */
function locationOf(c: Component): number {
    if (c.family === 'cauchy') return c.location;
    if (c.family === 'uniform') return (Math.min(c.lower, c.upper) + Math.max(c.lower, c.upper)) / 2;
    if (c.family === 'exponential') return 0;
    if (c.family === 'beta') {
        // The Beta's anchor is its mode, which is where its shape parameters
        // place it; it has no location parameter of its own.
        const a = Math.max(1e-2, c.alpha);
        const b = Math.max(1e-2, c.beta);
        const sum = a + b;
        return sum > 0 ? (a - 1) / (sum - 2) : 0.5;
    }
    return c.mean;
}

/**
 * The fields that move a component to `at`.
 *
 * Each family stores its location in a different parameter, so the pen has to
 * write the right one when the cursor moves.
 */
function locationPatch(c: Component, at: number): Partial<Component> {
    switch (c.family) {
        case 'cauchy':
            return { location: at };
        case 'uniform': {
            // Keep the width, slide the support so its centre lands on `at`.
            const half = Math.abs(c.upper - c.lower) / 2 || 0.05;
            return { lower: at - half, upper: at + half };
        }
        case 'exponential':
            // The exponential is anchored at its origin; the cursor only
            // scales it, so the location is fixed at 0.
            return {};
        case 'beta': {
            // The Beta has no location parameter: its shape parameters put the
            // mode at the cursor. Both are kept at or above 1 so the density
            // stays finite at the domain edges.
            const bounds = domainRange();
            const width = Math.max(1e-6, bounds.max - bounds.min);
            const mode = Math.max(0.05, Math.min(0.95, (at - bounds.min) / width));
            const concentration = 14;
            return {
                alpha: Math.max(1, mode * concentration),
                beta: Math.max(1, (1 - mode) * concentration),
            };
        }
        default:
            return { mean: at };
    }
}

/**
 * The fields that move a component to `(atX, atY)` in 2D.
 *
 * The 2D families are separable, so the x location is written exactly as in 1D
 * and the y location follows the same rule with the `*Y` parameters.
 */
function locationPatch2D(c: Component, atX: number, atY: number): Partial<Component> {
    const patch: Partial<Component> = {};
    switch (c.family) {
        case 'cauchy':
            patch.location = atX;
            break;
        case 'uniform': {
            const half = Math.abs(c.upper - c.lower) / 2 || 0.05;
            patch.lower = atX - half;
            patch.upper = atX + half;
            break;
        }
        case 'exponential':
            // Anchored at the origin; the cursor only scales it.
            break;
        case 'beta': {
            const bounds = domainRange();
            const width = Math.max(1e-6, bounds.max - bounds.min);
            const mode = Math.max(0.05, Math.min(0.95, (atX - bounds.min) / width));
            const concentration = 14;
            patch.alpha = Math.max(1, mode * concentration);
            patch.beta = Math.max(1, (1 - mode) * concentration);
            break;
        }
        default:
            patch.mean = atX;
            patch.meanY = atY;
            break;
    }
    // The y anchor is always tracked so the 2D handle follows the cursor even
    // for families whose x location is implicit.
    if (patch.meanY === undefined) patch.meanY = atY;
    return patch;
}

/** Parameters measured in domain units, whose steps scale with the domain. */
const UNIT_SCALED = new Set<ParamKey>(['mean', 'meanY', 'sigma', 'sigmaY', 'lower', 'upper', 'location', 'scale']);

/** Per-parameter nudge steps, mirroring the store's. */
const PARAM_STEP: Record<ParamKey, number> = {
    mean: 0.02,
    meanY: 0.02,
    sigma: 0.01,
    sigmaY: 0.01,
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

/** Parameters that place a component along the domain's x-axis. */
const PREVIEW_LOCATION_PARAMS = new Set<ParamKey>(['mean', 'meanY', 'lower', 'upper', 'location']);

/** Clamp a preview parameter to its valid range, mirroring the store. */
function clampPreviewParam(param: ParamKey, value: number, range: { min: number; max: number }): number {
    if (param === 'sigma' || param === 'sigmaY' || param === 'scale') return Math.max(1e-3, value);
    if (param === 'weight' || param === 'rate') return Math.max(1e-3, value);
    if (param === 'alpha' || param === 'beta') return Math.max(1e-2, value);
    if (param === 'kappa') return Math.max(0, value);
    if (PREVIEW_LOCATION_PARAMS.has(param)) return Math.max(range.min, Math.min(range.max, value));
    return value;
}

/**
 * The pointer cursor for a tool over the plot.
 *
 * Erase uses a crosshair rather than `not-allowed`: removing a lobe is a valid
 * action, and a stop sign reads as "you cannot click here" even when the cursor
 * is directly over a lobe that *can* be erased.
 */
function toolCursor(tool: Tool): string {
    return tool === 'add' || tool === 'delete' ? 'crosshair' : 'default';
}

/** Subscribe to tool changes. Returns an unsubscribe function. */
function onToolChange(listener: () => void): () => void {
    toolSubscriptions.push(listener);
    return () => {
        const index = toolSubscriptions.indexOf(listener);
        if (index !== -1) toolSubscriptions.splice(index, 1);
    };
}

/* ---------------------------------------------------------------------------
 * Shared state
 * ------------------------------------------------------------------------- */

let container: HTMLElement | null = null;
let currentDim = '1d';
let lastWidth = 0;
let lastHeight = 0;
let resizeObserver: ResizeObserver | null = null;

/**
 * Tear-down callbacks for the chart that is currently mounted. The chart is
 * rebuilt from scratch on every render, so any subscription it opened must be
 * released first or the old closures keep running against detached nodes.
 */
let chartSubscriptions: Array<() => void> = [];

function disposeChart(): void {
    for (const dispose of chartSubscriptions) dispose();
    chartSubscriptions = [];
}

/* ---------------------------------------------------------------------------
 * 1D view
 * ------------------------------------------------------------------------- */

/** The x-range shown in 1D mode, derived from the domain. */
function domainRange(): { min: number; max: number; wrap: boolean } {
    const spec = getDomainSpec();
    if (spec.space === 'circle') return { min: -Math.PI, max: Math.PI, wrap: true };
    if (spec.min !== null && spec.max !== null) return { min: spec.min, max: spec.max, wrap: false };
    if (spec.min !== null) return { min: spec.min, max: spec.min + 3, wrap: false };
    if (spec.max !== null) return { min: spec.max - 3, max: spec.max, wrap: false };
    return { min: -1.5, max: 1.5, wrap: false };
}

function render1D(root: d3.Selection<SVGSVGElement, unknown, null, undefined>, width: number, height: number): void {
    const spec = getDomainSpec();
    const range = domainRange();
    const margin = { top: 30, right: 24, bottom: 46, left: 64 };
    const iw = Math.max(10, width - margin.left - margin.right);
    const ih = Math.max(10, height - margin.top - margin.bottom);

    const curve = d3.range(0, 241).map((i) => range.min + ((range.max - range.min) * i) / 240);
    // The y-range tracks the drawn lobes in *both* directions: it grows when a
    // lobe is shot up and shrinks back when it is lowered again, so the plot
    // stays legible instead of being stuck at a huge scale. The floor is the
    // default p(x) = 1 height.
    //
    // Every candidate peak is filtered through `finitePeak`: a Beta (or
    // exponential) component with a shape parameter below 1 has an integrable
    // singularity at the domain edge, which evaluates to Infinity. Letting that
    // into the scale would produce a NaN axis and blank the whole plot.
    const finitePeak = (value: number | undefined): number =>
        value !== undefined && Number.isFinite(value) ? value : 0;

    // Densities are sampled on a denser grid than the drawn curve: a narrow
    // spike (a Beta with a shape below 1, a tight Gaussian) can fall entirely
    // between two points of the 241-sample curve, and the axis would then clip
    // the very lobe it is meant to fit.
    const peakGrid = d3.range(0, 2001).map((i) => range.min + ((range.max - range.min) * i) / 2000);
    const peakOf = (fn: (x: number) => number): number =>
        finitePeak(d3.max(peakGrid, (d) => fn(d)));

    const truthPeak = peakOf((d) => groundTruthPdf(d));
    // Each component is also drawn as its own dashed outline, and a narrow
    // component can be much taller than the mixture. The scale has to fit those
    // outlines too, or their handles land off the plot. The outline shows the
    // component's own shape, so its peak ignores weight.
    const componentPeak = finitePeak(
        d3.max(getComponents(), (c) => peakOf((d) => componentPdf(c, d))),
    );
    // While the pen is armed, the pending lobe is part of the picture too: both
    // its ghost and the mixture it would produce are drawn, so the axis must
    // leave room for them or the preview would shoot off the top of the plot.
    const previewLobe = currentTool === 'add' ? pendingGhost() : null;
    const previewPeak = previewLobe ? peakOf((d) => componentPdf(previewLobe, d)) : 0;
    const prospectivePeak = previewLobe
        ? peakOf((d) => mixturePdf([...getComponents(), previewLobe], d))
        : 0;
    const yMax = Math.max(
        1,
        truthPeak * 1.15,
        componentPeak * 1.15,
        previewPeak * 1.15,
        prospectivePeak * 1.15,
    );

    const x = d3.scaleLinear().domain([range.min, range.max]).range([0, iw]);
    const y = d3.scaleLinear().domain([0, yMax]).range([ih, 0]);

    const plot = root.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const xTicks = x.ticks(range.wrap ? 6 : 8);
    const yTicks = y.ticks(5);
    plot
        .append('g')
        .selectAll('line')
        .data(xTicks)
        .join('line')
        .attr('x1', (d) => x(d))
        .attr('x2', (d) => x(d))
        .attr('y1', 0)
        .attr('y2', ih)
        .attr('stroke', COLOR.grid);
    plot
        .append('g')
        .selectAll('line')
        .data(yTicks)
        .join('line')
        .attr('x1', 0)
        .attr('x2', iw)
        .attr('y1', (d) => y(d))
        .attr('y2', (d) => y(d))
        .attr('stroke', COLOR.grid);

    // Histogram of samples drawn from the drawn mixture.
    //
    // Drawing is deliberately disabled for now: the histogram is meant to be
    // revealed as an animation during fitting, not shown up front. Sampling
    // itself is implemented and verified in `sampling.ts`; flipping this flag
    // turns the bars back on.
    const SHOW_SAMPLE_HISTOGRAM = false;
    const samplingSettings = getSamplingSettings();
    if (SHOW_SAMPLE_HISTOGRAM && !range.wrap && samplingSettings.visible && hasComponents()) {
        const samples = drawSamples(samplingSettings.count, samplingSettings.seed).filter(
            (s) => Number.isFinite(s) && s >= range.min && s <= range.max,
        );
        if (samples.length > 0) {
            const binCount = 40;
            const binWidth = (range.max - range.min) / binCount;
            const bins = d3
                .bin()
                .domain([range.min, range.max])
                .thresholds(d3.range(range.min, range.max + binWidth, binWidth))(samples);
            // Bars are drawn on the same y-scale as the curves, so the
            // histogram's height is directly comparable with the density it was
            // sampled from: bar height = count / (n · binWidth).
            const binDensity = (count: number) => count / (samples.length * binWidth);

            plot
                .append('g')
                .attr('class', 'vis-samples')
                .selectAll('rect')
                .data(bins)
                .join('rect')
                .attr('x', (b) => x(b.x0 ?? 0) + 0.5)
                .attr('width', (b) => Math.max(0, x(b.x1 ?? 0) - x(b.x0 ?? 0) - 1))
                .attr('y', (b) => y(binDensity(b.length)))
                .attr('height', (b) => ih - y(binDensity(b.length)))
                .attr('fill', 'rgba(17, 17, 17, 0.10)');
        }
    }

    // ---- Ground truth, drawn by hand ------------------------------------
    // The truth lives in its own group so the handles stay clickable.
    // Everything here is rebuilt on each ground-truth change; the hover
    // preview is updated per pointer move without a rebuild.
    //
    // There is no fitted curve yet: fitting is not wired up, and drawing a
    // placeholder curve would be mistaken for a real result.
    const truthLayer = plot.append('g').attr('class', 'vis-truth');
    const drawGroundTruth = () => {
        truthLayer.selectAll('*').remove();
        const components = getComponents();
        if (components.length === 0) return;

        // Full mixture, drawn as a solid ink curve. This is where weight takes
        // effect: it scales each component's contribution to the sum.
        truthLayer
            .append('path')
            .datum(curve)
            .attr('d', d3.line<number>().x((d) => x(d)).y((d) => y(groundTruthPdf(d))))
            .attr('fill', 'none')
            .attr('stroke', COLOR.ink)
            .attr('stroke-width', 1.8)
            .attr('stroke-linejoin', 'round')
            .attr('pointer-events', 'none');

        // Each component gets a faint outline plus a draggable handle at its
        // peak. The outline shows the component's own shape — its mean, sigma
        // and peak — which is independent of its weight. Weight scales how much
        // the component contributes to the *mixture* curve above, so raising one
        // lobe's weight must not shrink the others' outlines.
        for (const c of components) {
            const isSelected = c.id === getSelectedId();
            const contribution = (value: number) => componentPdf(c, value);
            truthLayer
                .append('path')
                .datum(curve)
                .attr('d', d3.line<number>().x((d) => x(d)).y((d) => y(contribution(d))))
                .attr('fill', 'none')
                .attr('stroke', COLOR.ink)
                .attr('stroke-width', 1)
                .attr('stroke-opacity', isSelected ? 0.5 : 0.22)
                .attr('stroke-dasharray', '3 3')
                .attr('pointer-events', 'none');

            const anchor = locationOf(c);
            const peakX = x(anchor);
            const peakY = y(contribution(anchor));

            truthLayer
                .append('line')
                .attr('class', 'vis-truth-stem')
                .attr('data-id', c.id)
                .attr('x1', peakX)
                .attr('x2', peakX)
                .attr('y1', ih)
                .attr('y2', peakY)
                .attr('stroke', COLOR.ink)
                .attr('stroke-width', isSelected ? 1.4 : 1)
                .attr('stroke-opacity', isSelected ? 0.85 : 0.35)
                .attr('pointer-events', 'none');

            const handle = truthLayer
                .append('circle')
                .attr('class', 'vis-truth-handle')
                .datum(c)
                .attr('cx', peakX)
                .attr('cy', peakY)
                .attr('r', isSelected ? 6 : 4.5)
                .attr('fill', isSelected ? COLOR.red : '#FFFFFF')
                .attr('stroke', isSelected ? COLOR.red : COLOR.ink)
                .attr('stroke-width', 1.6)
                // Handles are only grabbable in select mode. In pen/erase mode
                // they must not intercept clicks, or the click would neither
                // plant a new component nor erase the one under the cursor.
                .attr('pointer-events', currentTool === 'select' ? 'auto' : 'none')
                .attr('cursor', currentTool === 'select' ? 'grab' : 'inherit');
            handle
                .append('title')
                .text(
                    `${FAMILY_LABELS[c.family]} · ` +
                        paramsFor(c.family)
                            .map((k) => `${PARAM_LABELS[k]} ${c[k].toFixed(3)}`)
                            .join(' · '),
                );

            // The selected component lists every parameter so the user can see
            // which one is active and which comes next when cycling.
            if (isSelected) {
                drawParamList(truthLayer, peakX, peakY, c, getActiveParam(), { width: iw, height: ih });
            }
        }
    };

    drawGroundTruth();

    // Hover preview: the ghost lobe, a drop line at its mean, and the mixture
    // curve that *would* result if it were planted. The layer is clipped to the
    // plot so a tall or narrow lobe cannot spill over the axes.
    const clipId = `vis-preview-clip-${Math.random().toString(36).slice(2, 9)}`;
    plot
        .append('defs')
        .append('clipPath')
        .attr('id', clipId)
        .append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', iw)
        .attr('height', ih);
    const previewLayer = plot.append('g').attr('class', 'vis-truth-preview').attr('clip-path', `url(#${clipId})`);
    // The prospective mixture, drawn beneath the ghost so the ghost stays legible.
    const previewMixture = previewLayer
        .append('path')
        .attr('fill', 'none')
        .attr('stroke', COLOR.ink)
        .attr('stroke-width', 1.8)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-dasharray', '5 4')
        .attr('pointer-events', 'none')
        .attr('display', 'none');
    const previewGhost = previewLayer
        .append('path')
        .attr('fill', COLOR.red)
        .attr('fill-opacity', 0.12)
        .attr('stroke', COLOR.red)
        .attr('stroke-width', 1.4)
        .attr('stroke-dasharray', '4 3')
        .attr('pointer-events', 'none')
        .attr('display', 'none');
    const previewLine = previewLayer
        .append('line')
        .attr('stroke', COLOR.red)
        .attr('stroke-width', 1.2)
        .attr('stroke-dasharray', '3 3')
        .attr('pointer-events', 'none')
        .attr('display', 'none');
    const previewDot = previewLayer
        .append('circle')
        .attr('r', 3.5)
        .attr('fill', COLOR.red)
        .attr('pointer-events', 'none')
        .attr('display', 'none');
    const previewLabel = previewLayer.append('g').attr('pointer-events', 'none').attr('display', 'none');

    const hidePreview = () => {
        previewGhost.attr('display', 'none');
        previewMixture.attr('display', 'none');
        previewLine.attr('display', 'none');
        previewDot.attr('display', 'none');
        previewLabel.attr('display', 'none');
    };

    // The pen's pending lobe. Hovering sets its location; the parameter
    // shortcuts adjust the rest *before* it is planted, so a lobe can be fully
    // shaped in the preview rather than only after the fact. The component is
    // built for whichever family the selector currently names.
    const preview: {
        active: boolean;
        /** Once a parameter is adjusted the lobe stops following the cursor. */
        pinned: boolean;
        param: ParamKey;
        component: Component;
        /** True after a parameter shortcut, so a click commits the shaped lobe. */
        adjusted?: boolean;
    } = {
        active: false,
        pinned: false,
        param: 'mean',
        component: makeGhost(getCurrentFamily(), 0),
    };

    /** The previewed component, with its location synced to the cursor. */
    const ghostComponent = (): Component => preview.component;

    /** Plant the previewed component, keeping every parameter the user set. */
    const plantFromPreview = (at: number) => {
        const id = addComponent(at, preview.component.family);
        // Carry the shaped parameters over, leaving the location to `at`.
        applyComponent(id, { ...preview.component, ...locationPatch(preview.component, at) });
    };

    const drawPreview = () => {
        if (!preview.active) return;
        const ghost = ghostComponent();        const ghostArea = d3
            .area<number>()
            .x((d) => x(d))
            .y0(ih)
            .y1((d) => y(componentPdf(ghost, d)));
        previewGhost.attr('d', ghostArea(curve)).attr('display', null);

        // The distribution that would result from planting this lobe, so the
        // effect on the mixture is visible before committing.
        const prospective = [...getComponents(), ghost];
        previewMixture
            .datum(curve)
            .attr('d', d3.line<number>().x((d) => x(d)).y((d) => y(mixturePdf(prospective, d))))
            .attr('display', null);

        const anchorX = x(locationOf(ghost));
        const anchorY = y(componentPdf(ghost, locationOf(ghost)));
        previewLine
            .attr('x1', anchorX)
            .attr('x2', anchorX)
            .attr('y1', ih)
            .attr('y2', anchorY)
            .attr('display', null);
        previewDot.attr('cx', anchorX).attr('cy', ih).attr('display', null);
        previewLabel.attr('display', null).selectAll('*').remove();
        drawParamList(previewLabel, anchorX, anchorY, ghost, preview.param, { width: iw, height: ih });
    };

    // Let the parameter shortcuts shape the pending lobe while it is previewed.
    // The bounds match select mode, so a lobe can be sized the same way before
    // and after planting.
    previewNudge = (direction) => {
        if (!preview.active) return;
        preview.pinned = true;
        preview.adjusted = true;
        const param = preview.param;
        const unit = UNIT_SCALED.has(param) ? range.max - range.min : 1;
        const step = PARAM_STEP[param] * unit * direction;
        const next = { ...preview.component };
        next[param] = clampPreviewParam(param, next[param] + step, range);
        preview.component = next;
        // A shape change moves the ghost's peak, so the axis has to follow it.
        // The preview lives outside the store, so the shape is handed to the
        // next render, which re-establishes the ghost and its label.
        if (param !== 'weight' && param !== 'lower' && param !== 'upper') {
            pendingPreview = { component: preview.component, pinned: true, param: preview.param };
            render();
            return;
        }
        drawPreview();
    };
    previewCycle = (direction) => {
        if (!preview.active) return;
        const keys = paramsFor(preview.component.family);
        const index = keys.indexOf(preview.param);
        preview.param = keys[(index + direction + keys.length) % keys.length]!;
        preview.adjusted = true;
        drawPreview();
    };

    // Re-establish a preview that was carried across the render a shape change
    // triggered, so adjusting a parameter does not dismiss the ghost. The
    // pinned flag must be carried too, or the next pointer move would snap the
    // lobe back under the cursor.
    if (pendingPreview) {
        preview.component = pendingPreview.component;
        preview.pinned = pendingPreview.pinned;
        preview.param = pendingPreview.param;
        preview.adjusted = true;
        pendingPreview = null;
        preview.active = true;
        drawPreview();
    }

    chartSubscriptions.push(() => {
        previewNudge = null;
        previewCycle = null;
    });

    // Transparent capture rect: receives pointer events for hover and clicks.
    // It is inserted *before* the truth layer so the component handles stay on
    // top and remain draggable.
    const capture = plot
        .insert('rect', '.vis-truth')
        .attr('class', 'vis-truth-capture')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', iw)
        .attr('height', ih)
        .attr('fill', 'transparent')
        .attr('cursor', toolCursor(currentTool));

    const xFromEvent = (event: PointerEvent): number => {
        const [px] = d3.pointer(event, plot.node());
        return x.invert(Math.max(0, Math.min(iw, px)));
    };

    /**
     * The component the erase/select tools would act on at `value`.
     *
     * Shared by the click handler and the erase hover indicator so the
     * highlight always matches what a click would actually hit.
     */
    const hitTest = (value: number): number | null => {
        const tolerance = Math.abs(x.invert(HIT_RADIUS_PX) - x.invert(0));
        let best: number | null = null;
        let bestDistance = Infinity;
        for (const c of getComponents()) {
            const distance = Math.abs(locationOf(c) - value);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = c.id;
            }
        }
        return best !== null && bestDistance <= tolerance ? best : null;
    };

    // Erase hover indicator: a ring around the lobe that a click would remove.
    // It lives in its own layer so it can be shown and hidden without a redraw.
    const eraseLayer = plot.append('g').attr('class', 'vis-erase-target').attr('pointer-events', 'none');
    const eraseRing = eraseLayer.append('circle').attr('display', 'none');

    const hideEraseTarget = () => {
        eraseRing.attr('display', 'none');
    };

    /** Highlight the lobe the erase tool would delete at `value`. */
    const showEraseTarget = (value: number) => {
        if (currentTool !== 'delete') {
            hideEraseTarget();
            return;
        }
        const id = hitTest(value);
        const component = id === null ? null : getComponents().find((c) => c.id === id);
        if (!component) {
            hideEraseTarget();
            return;
        }
        eraseRing
            .attr('cx', x(component.mean))
            .attr('cy', y(componentPdf(component, component.mean)))
            .attr('r', 13)
            .attr('fill', 'none')
            .attr('stroke', COLOR.red)
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '4 3')
            .attr('display', null);
    };

    capture
        .on('pointermove', (event: PointerEvent) => {
            if (currentTool === 'delete') {
                showEraseTarget(xFromEvent(event));
                return;
            }
            if (currentTool !== 'add') {
                preview.active = false;
                hidePreview();
                return;
            }
            // The cursor only sets the location when the lobe is first picked
            // up. Once the user starts adjusting parameters, moving the mouse
            // to a key must not drag the lobe back under the cursor.
            const value = xFromEvent(event);
            if (!preview.active || !preview.pinned) {
                preview.component = { ...preview.component, ...locationPatch(preview.component, value) };
            }
            preview.active = true;
            drawPreview();
        })
        .on('pointerleave', () => {
            preview.active = false;
            hidePreview();
            hideEraseTarget();
        })
        .on('click', (event: PointerEvent) => {
            // Shift is the parameter-editing modifier, but only while a lobe is
            // actually being edited — i.e. a lobe is selected. A pen preview is
            // never "editing" in the click sense: Shift+click must always plant,
            // whether the preview is plain or was shaped by a shortcut.
            //
            // (Gating on the shaped-preview state made the committing click a
            // no-op and forced a second click to plant.)
            const editing = isParamModifier(event) && getSelectedId() !== null;
            if (editing) return;
            const value = xFromEvent(event);
            if (currentTool === 'add') {
                // Plant the lobe exactly as previewed, then keep the pen armed
                // with the same shape so consecutive lobes match. The new lobe
                // follows the cursor again until it is adjusted.
                plantFromPreview(value);
                preview.pinned = false;
                preview.adjusted = false;
                preview.active = true;
                drawPreview();
                return;
            }
            const hit = hitTest(value);
            if (currentTool === 'delete') {
                if (hit !== null) deleteComponent(hit);
                hideEraseTarget();
            } else {
                select(hit);
            }
        });

    // Dragging a handle moves the mean. Plain pointer events are used rather
    // than d3.drag: the chart re-renders on ground-truth changes, and a
    // re-render would destroy the node d3's gesture is bound to. Here the
    // listeners live on `window`, so the gesture survives a rebuild.
    const pointerX = (event: PointerEvent): number => {
        const rect = capture.node()!.getBoundingClientRect();
        return event.clientX - rect.left;
    };
    let dragOrigin: { mean: number; px: number } | null = null;
    let dragId: number | null = null;

    const onPointerMove = (event: PointerEvent) => {
        if (!dragOrigin || dragId === null) return;
        const target = x(dragOrigin.mean) + (pointerX(event) - dragOrigin.px);
        if (!Number.isFinite(target)) return;
        const nextMean = Math.max(range.min, Math.min(range.max, x.invert(target)));
        moveComponent(dragId, nextMean);
        const cx = x(nextMean);
        truthLayer
            .selectAll<SVGCircleElement, { id: number }>('circle.vis-truth-handle')
            .filter((d) => d.id === dragId)
            .attr('cx', cx);
        truthLayer
            .selectAll<SVGLineElement, unknown>('line.vis-truth-stem')
            .filter(function () {
                return (this as SVGLineElement).dataset.id === String(dragId);
            })
            .attr('x1', cx)
            .attr('x2', cx);
    };

    const onPointerUp = () => {
        if (dragId === null) return;
        dragOrigin = null;
        dragId = null;
        draggingHandle = false;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        // Commit: a full rebuild rescales the axis and rebinds the handles.
        render();
    };

    const startHandleDrag = (event: PointerEvent, id: number) => {
        const current = getComponents().find((c) => c.id === id);
        if (!current) return;
        event.preventDefault();
        draggingHandle = true;
        dragId = id;
        dragOrigin = { mean: current.mean, px: pointerX(event) };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    };

    // A pointerdown on a handle selects it and begins a drag; the move and up
    // listeners live on `window` so they outlive any re-render.
    const bindHandles = () => {
        truthLayer
            .selectAll<SVGCircleElement, { id: number; mean: number; sigma: number; weight: number }>('circle.vis-truth-handle')
            .on('pointerdown', (event: PointerEvent, d) => {
                if (currentTool !== 'select') return;
                // Capture the drag origin before selecting: selecting triggers a
                // re-render, and the drag must start from the pre-render state.
                startHandleDrag(event, d.id);
                select(d.id);
            });
    };
    bindHandles();

    // The handles' interactivity and the capture cursor depend on the active
    // tool, so a tool change redraws them even when the geometry is unchanged.
    // Entering or leaving pen mode also changes the y-scale (the pending lobe
    // needs room), which requires a full re-render.
    chartSubscriptions.push(
        onToolChange(() => {
            const isPen = currentTool === 'add';
            if (isPen || wasPen) {
                wasPen = isPen;
                render();
                return;
            }
            drawGroundTruth();
            bindHandles();
            capture.attr('cursor', toolCursor(currentTool));
            hidePreview();
            hideEraseTarget();
        }),
    );

    // Any change to the drawn lobes rescales the y-axis, so the chart is
    // rebuilt: the scale must follow a lobe both up and back down again.
    // The rebuild is deferred to the next frame — doing it synchronously inside
    // the notification would dispose this chart while it is still being
    // notified, and the replacement would subscribe mid-notify.
    //
    // While a handle is being dragged the rebuild is suppressed: replacing the
    // chart would destroy the node the drag is attached to and the gesture
    // would stall. The drag redraws in place and the rebuild happens on release.
    let pendingRender = 0;
    const unsubscribe = onGroundTruthChange(() => {
        if (draggingHandle) return;
        if (pendingRender) return;
        pendingRender = requestAnimationFrame(() => {
            pendingRender = 0;
            render();
        });
    });
    chartSubscriptions.push(() => {
        if (pendingRender) cancelAnimationFrame(pendingRender);
        unsubscribe();
    });

    const gx = plot
        .append('g')
        .attr('transform', `translate(0,${ih})`)
        .call(
            d3
                .axisBottom(x)
                .tickValues(xTicks)
                .tickSize(0)
                .tickPadding(8)
                .tickFormat(range.wrap ? ((d) => `${d3.format('.2f')(Number(d))}π`) : d3.format('.1f')),
        );
    const gy = plot
        .append('g')
        .call(d3.axisLeft(y).tickValues(yTicks).tickSize(0).tickPadding(8).tickFormat(d3.format('.2f')));
    gx.select('.domain').remove();
    gy.select('.domain').remove();
    gx.selectAll('.tick text').attr('fill', COLOR.muted);
    gy.selectAll('.tick text').attr('fill', COLOR.muted);

    // Axis titles state the quantity and its support explicitly.
    const xTitle = range.wrap ? `θ (rad), on ${spec.label}` : `x, on ${spec.label}`;
    plot
        .append('text')
        .attr('x', iw / 2)
        .attr('y', ih + 34)
        .attr('text-anchor', 'middle')
        .attr('font-size', 11)
        .attr('fill', COLOR.muted)
        .text(xTitle);
    plot
        .append('text')
        .attr('transform', `translate(${-42},${ih / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle')
        .attr('font-size', 11)
        .attr('fill', COLOR.muted)
        .text('probability density p(x)');

    // Legend: the fitted curve and the drawn truth. The truth is drawn as a
    // solid ink line, so its swatch is solid too.
    const legend = plot.append('g').attr('transform', `translate(${iw - 150},${-16})`);
    const items: Array<[string, string, string, number]> = [
        ['fitted', COLOR.red, '', 2],
        ['ground truth', COLOR.ink, '', 1.8],
    ];
    items.forEach(([label, color, dash, width], i) => {
        const g = legend.append('g').attr('transform', `translate(${i * 82},0)`);
        g.append('line')
            .attr('x1', 0)
            .attr('x2', 16)
            .attr('y1', 0)
            .attr('y2', 0)
            .attr('stroke', color)
            .attr('stroke-width', width)
            .attr('stroke-dasharray', dash);
        g.append('text')
            .attr('x', 21)
            .attr('y', 4)
            .attr('font-size', 10.5)
            .attr('fill', COLOR.muted)
            .text(label);
    });
}

/* ---------------------------------------------------------------------------
 * 2D view: the domain's base, with an arcball camera
 * ------------------------------------------------------------------------- */

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rotate `v` about unit axis `k` by `angle` (Rodrigues). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const kv = cross(k, v);
    const kd = dot(k, v) * (1 - c);
    return [
        v[0] * c + kv[0] * s + k[0] * kd,
        v[1] * c + kv[1] * s + k[1] * kd,
        v[2] * c + kv[2] * s + k[2] * kd,
    ];
}

/** Camera orientation: the world direction that points "up" on screen. */
interface Camera {
    up: Vec3;
}

/**
 * Clamp the camera's elevation to [minUp, maxUp].
 *
 * The camera must stay clear of both poles: the drag axes are derived from
 * `cross(up, [0,0,1])`, which becomes numerically unstable as `up` approaches
 * ±z, and the resulting axis noise makes the model spin. Preserving the
 * azimuth (rather than rotating to the nearest point on the limit) keeps the
 * motion predictable.
 */
function clampCamera(cam: Camera, minUp: number, maxUp = 1): void {
    const up = normalize(cam.up);
    if (up[2] >= minUp && up[2] <= maxUp) {
        cam.up = up;
        return;
    }
    const target = up[2] < minUp ? minUp : maxUp;
    const horiz = Math.hypot(up[0], up[1]);
    if (horiz < 1e-6) {
        // Degenerate: directly over a pole with no heading to preserve.
        cam.up = [0, 0, 1];
        return;
    }
    // Keep the horizontal direction, rescale it to satisfy the elevation
    // limit, and rebuild the up vector from it.
    const r = Math.hypot(1 - target * target);
    const scale = r / horiz;
    cam.up = normalize([up[0] * scale, up[1] * scale, target]);
}

function cameraBasis(cam: Camera): { right: Vec3; fwd: Vec3; up: Vec3 } {
    const up = normalize(cam.up);
    const right = normalize(cross(up, [0, 0, 1]));
    const fwd = normalize(cross(right, up));
    return { right, fwd, up };
}

function project(p: Vec3, basis: { right: Vec3; fwd: Vec3; up: Vec3 }, scale: number, cx: number, cy: number) {
    return {
        x: cx + scale * dot(p, basis.right),
        y: cy - scale * dot(p, basis.up),
        depth: dot(p, basis.fwd),
    };
}

/** Placeholder density over the unit square: two bumps. */
function squareDensity(u: number, v: number): number {
    const bump = (u0: number, v0: number, s: number) =>
        Math.exp(-0.5 * (((u - u0) / s) ** 2 + ((v - v0) / s) ** 2));
    return 0.12 + 0.88 * (0.8 * bump(0.32, 0.62, 0.16) + 0.6 * bump(0.72, 0.3, 0.13));
}

/** Placeholder density on the upper hemisphere (S¹ as its boundary). */
function hemisphereDensity(theta: number, phi: number): number {
    const bump = (t0: number, p0: number, s: number) => {
        const dt = Math.atan2(Math.sin(theta - t0), Math.cos(theta - t0));
        return Math.exp(-0.5 * ((dt / s) ** 2 + ((phi - p0) / s) ** 2));
    };
    return 0.1 + 0.9 * (0.85 * bump(0.6, 0.85, 0.42) + 0.5 * bump(4.2, 0.5, 0.34));
}

/** Placeholder density on the sphere: two caps. */
function sphereDensity(theta: number, phi: number): number {
    const bump = (t0: number, p0: number, s: number) => {
        const dt = Math.atan2(Math.sin(theta - t0), Math.cos(theta - t0));
        return Math.exp(-0.5 * ((dt / s) ** 2 + ((phi - p0) / s) ** 2));
    };
    return 0.1 + 0.9 * (0.8 * bump(0.6, 0.75, 0.4) + 0.55 * bump(4.4, 0.5, 0.32));
}

type Projector = (p: Vec3) => { x: number; y: number; depth: number };

/**
 * Camera-independent geometry, built once per (domain, size).
 *
 * The expensive work — evaluating the density, sampling points, tessellating
 * surfaces — happens here. Per-frame work is limited to projecting these cached
 * 3D points, which is what keeps dragging interactive.
 */
interface Quad {
    /** The quad's four corners in world space. */
    corners: Vec3[];
    /** Average depth against the camera the scene was built for. */
    depth: number;
    shade: number;
}

/** A grid of quads over a parametric surface, painter-sorted back-to-front. */
function surfaceQuads(
    nu: number,
    nv: number,
    point: (u: number, v: number) => Vec3,
    shade: (u: number, v: number) => number,
    depthOf: (p: Vec3) => number,
): Quad[] {
    const grid: Vec3[][] = [];
    for (let i = 0; i <= nu; i++) {
        const row: Vec3[] = [];
        for (let j = 0; j <= nv; j++) row.push(point(i / nu, j / nv));
        grid.push(row);
    }
    const quads: Quad[] = [];
    for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
            const a = grid[i]![j]!;
            const b = grid[i + 1]![j]!;
            const c = grid[i + 1]![j + 1]!;
            const d = grid[i]![j + 1]!;
            quads.push({
                corners: [a, b, c, d],
                depth: (depthOf(a) + depthOf(b) + depthOf(c) + depthOf(d)) / 4,
                shade: shade(i / nu, j / nv),
            });
        }
    }
    return quads.sort((q1, q2) => q1.depth - q2.depth);
}

/** Project a quad's corners into a path string. */
function quadPath(q: Quad, P: Projector): string {
    const [a, b, c, d] = q.corners.map(P);
    return `M${a!.x},${a!.y}L${b!.x},${b!.y}L${c!.x},${c!.y}L${d!.x},${d!.y}Z`;
}

/** Screen-space polyline helper for a projected point sequence. */
function polyline(P: (p: Vec3) => { x: number; y: number }, pts: Vec3[], closed = false): string {
    const d = pts
        .map((p, i) => {
            const s = P(p);
            return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(2)},${s.y.toFixed(2)}`;
        })
        .join(' ');
    return closed ? `${d} Z` : d;
}

/** Points around the unit circle in the z = 0 plane. */
function circlePoints(r: number, n = 128): Vec3[] {
    return Array.from({ length: n + 1 }, (_, k) => {
        const a = (k / n) * Math.PI * 2;
        return [r * Math.cos(a), r * Math.sin(a), 0] as Vec3;
    });
}

/** Floor for the circular domains: disc, concentric rings and spokes. */
function drawPolarFloor(P: Projector, floorLayer: d3.Selection<SVGGElement, unknown, null, undefined>): void {
    const add = (pts: Vec3[], closed: boolean, stroke: string, fill = 'none') => {
        const path = floorLayer
            .append('path')
            .datum(pts)
            .attr('class', 'vis-line')
            .attr('d', polyline(P, pts, closed))
            .attr('fill', fill)
            .attr('stroke', stroke);
        if (closed) path.attr('data-closed', '1');
    };
    add(circlePoints(1), true, 'none', 'rgba(17, 17, 17, 0.02)');
    for (let i = 1; i <= 5; i++) {
        add(circlePoints(i / 5), false, i === 5 ? COLOR.gridStrong : COLOR.grid);
    }
    for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        add(
            [
                [0, 0, 0],
                [Math.cos(a), Math.sin(a), 0],
            ],
            false,
            COLOR.grid,
        );
    }
}

/**
 * S¹: a hemisphere. The circle is the boundary of the upper hemisphere, so the
 * density is a radial surface on the dome — the same construction as S², but
 * with the circle as its base. The disc below is the base of the domain.
 */
function drawHemisphere(
    P: Projector,
    surfaceLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
    pointsLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
    quality = 1,
): void {
    const q = (n: number) => Math.max(2, Math.round(n * quality));
    const domePoint = (theta: number, phi: number, r = 1): Vec3 => [
        r * Math.cos(theta) * Math.sin(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(phi),
    ];

    // ---- Base dome ----
    const base = surfaceQuads(
        q(64),
        q(16),
        (u, v) => domePoint(u * Math.PI * 2, v * (Math.PI / 2)),
        () => 1,
        (p) => p[2],
    );
    surfaceLayer
        .selectAll('path.dome-base')
        .data(base)
        .join('path')
        .attr('class', 'dome-base vis-line')
        .attr('d', (q) => quadPath(q, P))
        .attr('fill', 'rgba(17, 17, 17, 0.05)')
        .attr('stroke', 'rgba(17, 17, 17, 0.06)')
        .attr('stroke-width', 0.4);

    // ---- Graticule: meridians and parallels on the dome ----
    const graticule = surfaceLayer.append('g').attr('class', 'graticule');
    for (let m = 0; m < 12; m++) {
        const theta = (m / 12) * Math.PI * 2;
        const pts = Array.from({ length: 33 }, (_, k) => domePoint(theta, (k / 32) * (Math.PI / 2), 1.002));
        graticule
            .append('path')
            .datum(pts)
            .attr('class', 'vis-line')
            .attr('d', polyline(P, pts))
            .attr('fill', 'none')
            .attr('stroke', COLOR.grid)
            .attr('stroke-width', 0.8);
    }
    for (let p = 1; p < 4; p++) {
        const phi = (p / 4) * (Math.PI / 2);
        const pts = Array.from({ length: 97 }, (_, k) => domePoint((k / 96) * Math.PI * 2, phi, 1.002));
        graticule
            .append('path')
            .datum(pts)
            .attr('class', 'vis-line')
            .attr('d', polyline(P, pts))
            .attr('fill', 'none')
            .attr('stroke', COLOR.grid)
            .attr('stroke-width', 0.8);
    }

    // ---- Density surface: radial displacement of the dome ----
    const quads = surfaceQuads(
        q(96),
        q(24),
        (u, v) => {
            const theta = u * Math.PI * 2;
            const phi = v * (Math.PI / 2);
            return domePoint(theta, phi, 1 + hemisphereDensity(theta, phi) * 0.3);
        },
        (u, v) => hemisphereDensity(u * Math.PI * 2, v * (Math.PI / 2)),
        (p) => p[2],
    );
    surfaceLayer
        .selectAll('path.vis-quad')
        .data(quads)
        .join('path')
        .attr('class', 'vis-quad')
        .attr('d', (q) => quadPath(q, P))
        .attr('fill', 'url(#vis-surface)')
        .attr('fill-opacity', (q) => 0.2 + 0.65 * q.shade)
        .attr('stroke', 'rgba(255, 255, 255, 0.25)')
        .attr('stroke-width', 0.35);

    // ---- Samples on the dome ----
    pointsLayer
        .selectAll('circle')
        .data(
            Array.from({ length: q(500) }, () => {
                for (;;) {
                    const theta = Math.random() * Math.PI * 2;
                    // Clamp: rounding can push the argument just outside [-1, 1],
                    // which would make acos return NaN.
                    const phi = Math.acos(Math.min(1, Math.max(-1, 1 - Math.random())));
                    if (Math.random() < hemisphereDensity(theta, phi)) return domePoint(theta, phi, 1.01);
                }
            }),
        )
        .join('circle')
        .attr('cx', (p) => P(p).x)
        .attr('cy', (p) => P(p).y)
        .attr('r', 1.4)
        .attr('fill', COLOR.red)
        .attr('fill-opacity', 0.4);
}

/**
 * S²: a full sphere. The base sphere is drawn as a shaded, painter-sorted
 * surface; the density is a red radial surface on top of it, and the samples
 * sit on the sphere's surface.
 */
function drawSphere(
    P: Projector,
    surfaceLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
    pointsLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
    quality = 1,
): void {
    const q = (n: number) => Math.max(2, Math.round(n * quality));
    const spherePoint = (theta: number, phi: number, r = 1): Vec3 => [
        r * Math.cos(theta) * Math.sin(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(phi),
    ];

    // ---- Base sphere ----
    const base = surfaceQuads(
        q(64),
        q(32),
        (u, v) => spherePoint(u * Math.PI * 2, v * Math.PI),
        () => 1,
        (p) => p[2],
    );
    surfaceLayer
        .selectAll('path.base')
        .data(base)
        .join('path')
        .attr('class', 'base vis-line')
        .attr('d', (q) => quadPath(q, P))
        .attr('fill', 'rgba(17, 17, 17, 0.05)')
        .attr('stroke', 'rgba(17, 17, 17, 0.06)')
        .attr('stroke-width', 0.4);

    // ---- Graticule: meridians + parallels ----
    const graticule = surfaceLayer.append('g').attr('class', 'graticule');
    for (let m = 0; m < 12; m++) {
        const theta = (m / 12) * Math.PI * 2;
        const pts = Array.from({ length: 49 }, (_, k) => spherePoint(theta, (k / 48) * Math.PI, 1.002));
        graticule
            .append('path')
            .datum(pts)
            .attr('class', 'vis-line')
            .attr('d', polyline(P, pts))
            .attr('fill', 'none')
            .attr('stroke', COLOR.grid)
            .attr('stroke-width', 0.8);
    }
    for (let p = 1; p < 6; p++) {
        const phi = (p / 6) * Math.PI;
        const pts = Array.from({ length: 97 }, (_, k) => spherePoint((k / 96) * Math.PI * 2, phi, 1.002));
        graticule
            .append('path')
            .datum(pts)
            .attr('class', 'vis-line')
            .attr('d', polyline(P, pts))
            .attr('fill', 'none')
            .attr('stroke', p === 3 ? COLOR.gridStrong : COLOR.grid)
            .attr('stroke-width', 0.8);
    }

    // ---- Density surface: radial displacement of the sphere ----
    const quads = surfaceQuads(
        q(72),
        q(36),
        (u, v) => {
            const theta = u * Math.PI * 2;
            const phi = v * Math.PI;
            return spherePoint(theta, phi, 1 + sphereDensity(theta, phi) * 0.28);
        },
        (u, v) => sphereDensity(u * Math.PI * 2, v * Math.PI),
        (p) => p[2],
    );
    surfaceLayer
        .selectAll('path.vis-quad')
        .data(quads)
        .join('path')
        .attr('class', 'vis-quad')
        .attr('d', (q) => quadPath(q, P))
        .attr('fill', 'url(#vis-surface)')
        .attr('fill-opacity', (q) => 0.2 + 0.65 * q.shade)
        .attr('stroke', 'rgba(255, 255, 255, 0.25)')
        .attr('stroke-width', 0.35);

    // ---- Samples on the sphere ----
    pointsLayer
        .selectAll('circle')
        .data(
            Array.from({ length: q(700) }, () => {
                for (;;) {
                    const theta = Math.random() * Math.PI * 2;
                    // Clamp: rounding can push the argument just outside [-1, 1],
                    // which would make acos return NaN.
                    const phi = Math.acos(Math.min(1, Math.max(-1, 1 - 2 * Math.random())));
                    if (Math.random() < sphereDensity(theta, phi)) return spherePoint(theta, phi, 1.01);
                }
            }),
        )
        .join('circle')
        .attr('cx', (p) => P(p).x)
        .attr('cy', (p) => P(p).y)
        .attr('r', 1.4)
        .attr('fill', COLOR.red)
        .attr('fill-opacity', 0.4);
}

/** The cached SVG layers that `update` re-projects each frame. */
interface LayerFrame {
    floor: d3.Selection<SVGPathElement, Vec3[], SVGGElement, unknown>;
    /** Tessellated quads, re-projected from their world-space corners. */
    surface: d3.Selection<SVGPathElement, Quad, SVGGElement, unknown>;
    /** Graticule, base and other polyline paths bound to point arrays. */
    lines: d3.Selection<SVGPathElement, Vec3[], SVGGElement, unknown>;
    points: d3.Selection<SVGCircleElement, Vec3, SVGGElement, unknown>;
}

/** Format a domain bound without trailing zeros, e.g. 0 → "0", 1.5 → "1.5". */
function fmtBound(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** Midpoint of two world-space points. */
function mid(a: Vec3, b: Vec3): Vec3 {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function render2D(root: d3.Selection<SVGSVGElement, unknown, null, undefined>, width: number, height: number): void {
    const spec = getDomainSpec();
    const isSphere = spec.space === 'sphere';
    const isCircle = spec.space === 'circle';
    const isInterval = !isSphere && !isCircle && spec.min !== null && spec.max !== null;

    const cx = width / 2;
    const cy = height / 2 + (isSphere ? 0 : 10);
    const baseScale = Math.min(width, height) * (isSphere ? 0.32 : 0.36);
    let zoom = 1;

    const cam: Camera = { up: isSphere ? normalize([0.35, -0.55, 0.76]) : normalize([0.25, -0.45, 0.86]) };
    // Keep the camera clear of both poles, where the drag axes degenerate.
    const minUp = isSphere ? 0.35 : 0.45;
    const maxUp = 0.97;
    clampCamera(cam, minUp, maxUp);

    const defs = root.append('defs');
    const surfaceGradient = defs
        .append('linearGradient')
        .attr('id', 'vis-surface')
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '100%')
        .attr('y2', '100%');
    surfaceGradient.append('stop').attr('offset', '0%').attr('stop-color', '#F05A6E');
    surfaceGradient.append('stop').attr('offset', '100%').attr('stop-color', COLOR.redDark);

    const scene = root.append('g');
    const floorLayer = scene.append('g');
    const surfaceLayer = scene.append('g');
    const pointsLayer = scene.append('g');
    // Labels live outside the scene group so they are never sheared by the
    // projection; they are repositioned from projected points each frame.
    const labelsLayer = root.append('g').attr('class', 'vis-labels');

    const basis = () => cameraBasis(cam);
    const projector = (): Projector => {
        const b = basis();
        const scale = baseScale * zoom;
        return (p: Vec3) => project(p, b, scale, cx, cy);
    };

    // ---- Axis descriptors -------------------------------------------------
    // Each axis is a 3D segment plus one or more text runs. Every run is
    // anchored to its own world-space point, so a run placed at an axis end
    // stays glued to that end as the camera turns. Runs are re-projected every
    // frame so they track the camera.
    interface AxisText {
        text: string;
        /** World-space point the text is anchored to. */
        anchor: Vec3;
        /** Screen-space nudge so the text clears the axis line. */
        dx: number;
        dy: number;
        anchorMode: 'start' | 'middle' | 'end';
    }

    const axisLabels: AxisText[] = [];
    const axisLayer = scene.append('g').attr('class', 'vis-axes');

    const addAxis = (from: Vec3, to: Vec3, ...labels: AxisText[]) => {
        axisLayer
            .append('path')
            .datum([from, to])
            .attr('class', 'vis-line')
            .attr('d', polyline(projector(), [from, to]))
            .attr('fill', 'none')
            .attr('stroke', COLOR.ink)
            .attr('stroke-opacity', 0.45)
            .attr('stroke-width', 1.1);
        axisLabels.push(...labels);
    };

    const renderLabels = (P: Projector) => {
        labelsLayer.selectAll('*').remove();
        for (const l of axisLabels) {
            const s = P(l.anchor);
            labelsLayer
                .append('text')
                .attr('x', s.x + l.dx)
                .attr('y', s.y + l.dy)
                .attr('text-anchor', l.anchorMode)
                .attr('font-size', 11)
                .attr('fill', COLOR.muted)
                .text(l.text);
        }
    };

    /**
     * Per-frame update: re-project the cached geometry into `d`/`cx`/`cy`
     * attributes. No node creation, no re-sampling, no density evaluation —
     * this is what keeps dragging smooth.
     *
     * `showSamples` hides the sample points during interaction: a partial
     * scatter would be misleading, so they are either all shown or all hidden.
     */
    const update = (frame: LayerFrame, showSamples = true) => {
        const P = projector();
        frame.floor.each(function (points) {
            if (!Array.isArray(points)) return;
            const closed = (this as SVGPathElement).dataset.closed === '1';
            d3.select(this).attr('d', polyline(P, points, closed));
        });
        frame.surface.each(function (quad) {
            if (!quad || !Array.isArray(quad.corners)) return;
            d3.select(this).attr('d', quadPath(quad, P));
        });
        frame.lines.each(function (points) {
            if (!Array.isArray(points)) return;
            d3.select(this).attr('d', polyline(P, points));
        });
        pointsLayer.attr('display', showSamples ? null : 'none');
        frame.points.each(function (p) {
            const s = P(p);
            d3.select(this).attr('cx', s.x).attr('cy', s.y);
        });
        renderLabels(P);
    };

    /**
     * Build the scene geometry. `quality` scales tessellation and sample count:
     * 1 is the full-resolution view, lower values are used for the drag preview.
     */
    const build = (quality = 1): LayerFrame => {
        const P = projector();
        const linePath = (pts: Vec3[], closed = false) => polyline(P, pts, closed);
        const q = (n: number) => Math.max(2, Math.round(n * quality));

        const floor: Vec3[][] = [];
        const addLine = (pts: Vec3[], closed = false, stroke = COLOR.grid, fill = 'none') => {
            const path = floorLayer
                .append('path')
                .datum(pts)
                .attr('class', 'vis-line')
                .attr('d', linePath(pts, closed))
                .attr('fill', fill)
                .attr('stroke', stroke);
            if (closed) path.attr('data-closed', '1');
            floor.push(pts);
        };

        let quads: Quad[] = [];
        let samples: Vec3[] = [];

        if (isInterval) {
            // ---- Square floor, lifted density surface ----
            const half = 0.9;
            // Coarser grid lines in preview mode: fewer paths to re-project.
            const step = quality < 1 ? 0.3 : 0.1;
            addLine(
                [
                    [-half, -half, 0],
                    [half, -half, 0],
                    [half, half, 0],
                    [-half, half, 0],
                ],
                true,
                COLOR.gridStrong,
                'rgba(17, 17, 17, 0.015)',
            );
            for (let t = -half + step; t < half - 1e-9; t += step) {
                addLine([[-half, t, 0], [half, t, 0]]);
                addLine([[t, -half, 0], [t, half, 0]]);
            }

            // The drawn mixture is the surface; the placeholder only fills in
            // while nothing has been drawn yet.
            const drawn = hasComponents();
            const bounds = domainRange();
            const toWorld = (u: number, v: number): [number, number] => [
                bounds.min + u * (bounds.max - bounds.min),
                bounds.min + v * (bounds.max - bounds.min),
            ];
            const heightAt = (u: number, v: number): number => {
                if (!drawn) return squareDensity(u, v) * 0.75;
                const [dx, dy] = toWorld(u, v);
                return groundTruthPdf(dx, dy) * 0.75;
            };
            quads = surfaceQuads(
                q(56),
                q(56),
                (u, v) => {
                    const x = -half + 2 * half * u;
                    const y = -half + 2 * half * v;
                    return [x, y, heightAt(u, v)];
                },
                (u, v) => {
                    if (!drawn) return squareDensity(u, v);
                    const [dx, dy] = toWorld(u, v);
                    return groundTruthPdf(dx, dy) / 1.2;
                },
                (p) => p[2],
            );

            samples = Array.from({ length: q(600) }, () => {
                for (;;) {
                    const u = Math.random();
                    const v = Math.random();
                    if (Math.random() < squareDensity(u, v)) {
                        return [-half + 2 * half * u, -half + 2 * half * v, 0] as Vec3;
                    }
                }
            });
        } else if (spec.space === 'real') {
            // ---- Open plane: grid only, no walls ----
            const half = 1.25;
            const step = quality < 1 ? 0.625 : 0.25;
            for (let t = -half; t <= half + 1e-9; t += step) {
                const strong = Math.abs(t) < 1e-9;
                const stroke = strong ? COLOR.gridStrong : COLOR.grid;
                addLine([[-half, t, 0], [half, t, 0]], false, stroke);
                addLine([[t, -half, 0], [t, half, 0]], false, stroke);
            }

            const drawn = hasComponents();
            const bounds = domainRange();
            const toWorld = (u: number, v: number): [number, number] => [
                bounds.min + u * (bounds.max - bounds.min),
                bounds.min + v * (bounds.max - bounds.min),
            ];
            quads = surfaceQuads(
                q(48),
                q(48),
                (u, v) => {
                    const x = -half + 2 * half * u;
                    const y = -half + 2 * half * v;
                    const h = drawn
                        ? groundTruthPdf(toWorld(u, v)[0], toWorld(u, v)[1]) * 6
                        : fitPdf(x) * fitPdf(y) * 6;
                    return [x, y, h];
                },
                (u, v) => {
                    const h = drawn
                        ? groundTruthPdf(toWorld(u, v)[0], toWorld(u, v)[1]) * 6
                        : fitPdf(-half + 2 * half * u) * fitPdf(-half + 2 * half * v) * 6;
                    return h / 0.6;
                },
                (p) => p[2],
            );
        } else if (isCircle) {
            // ---- S¹: a hemisphere over the disc, density on the dome ----
            drawPolarFloor(P, floorLayer);
            drawHemisphere(P, surfaceLayer, pointsLayer, quality);
        } else {
            // ---- S²: the density is a radial surface on the sphere ----
            drawSphere(P, surfaceLayer, pointsLayer, quality);
        }

        if (quads.length) {
            surfaceLayer
                .selectAll('path.vis-quad')
                .data(quads)
                .join('path')
                .attr('class', 'vis-quad')
                .attr('d', (q) => quadPath(q, P))
                .attr('fill', 'url(#vis-surface)')
                .attr('fill-opacity', (q) => 0.25 + 0.6 * Math.min(1, q.shade))
                .attr('stroke', 'rgba(255, 255, 255, 0.35)')
                .attr('stroke-width', 0.4);
        }

        if (samples.length) {
            pointsLayer
                .selectAll('circle')
                .data(samples)
                .join('circle')
                .attr('cx', (p) => P(p).x)
                .attr('cy', (p) => P(p).y)
                .attr('r', 1.5)
                .attr('fill', COLOR.red)
                .attr('fill-opacity', 0.3);
        }

        // ---- Axes with descriptions ----
        if (isInterval || spec.space === 'real') {
            const half = isInterval ? 0.9 : 1.25;
            // The 2D base is a normalized unit square; the end labels report
            // the domain's actual bounds so a custom interval is described
            // honestly, while the axis name sits at the midpoint.
            const lo = isInterval && spec.min !== null ? fmtBound(spec.min) : null;
            const hi = isInterval && spec.max !== null ? fmtBound(spec.max) : null;
            // Both axes start at the same origin corner, so the lower bound is
            // labelled once there (on the x axis) rather than stacked twice.
            const bounds = (from: Vec3, to: Vec3, name: string, dy: number, showLow: boolean): AxisText[] => {
                if (lo === null || hi === null) {
                    return [{ text: `${name}  (${spec.label})`, anchor: mid(from, to), dx: 0, dy, anchorMode: 'middle' }];
                }
                const runs: AxisText[] = [];
                if (showLow) runs.push({ text: lo, anchor: from, dx: 0, dy, anchorMode: 'middle' });
                runs.push({ text: name, anchor: mid(from, to), dx: 0, dy, anchorMode: 'middle' });
                runs.push({ text: hi, anchor: to, dx: 0, dy, anchorMode: 'middle' });
                return runs;
            };

            const xFrom: Vec3 = [-half, -half, 0];
            const xTo: Vec3 = [half, -half, 0];
            addAxis(xFrom, xTo, ...bounds(xFrom, xTo, 'x', 16, true));

            const yFrom: Vec3 = [-half, -half, 0];
            const yTo: Vec3 = [-half, half, 0];
            addAxis(yFrom, yTo, ...bounds(yFrom, yTo, 'y', 4, false));

            addAxis([-half, -half, 0], [-half, -half, 1.05], {
                text: 'density p(x, y)',
                anchor: [-half, -half, 0.55],
                dx: 0,
                dy: -8,
                anchorMode: 'middle',
            });
        } else if (isCircle) {
            addAxis([0, 0, 0], [1.12, 0, 0], {
                text: 'θ = 0',
                anchor: [1.12, 0, 0],
                dx: 8,
                dy: 4,
                anchorMode: 'start',
            });
            addAxis([0, 0, 0], [-1.12, 0, 0], {
                text: 'θ = π',
                anchor: [-1.12, 0, 0],
                dx: -8,
                dy: 4,
                anchorMode: 'end',
            });
            addAxis([0, 0, 0], [0, 0, 1.12], {
                text: 'φ = 0 (pole)',
                anchor: [0, 0, 1.12],
                dx: 0,
                dy: -8,
                anchorMode: 'middle',
            });
            addAxis([0, 0, 0], [1.12, 0, 0], {
                text: 'φ = π/2 (rim)',
                anchor: [0, 0, 0],
                dx: 0,
                dy: 18,
                anchorMode: 'middle',
            });
        } else {
            addAxis([0, 0, 0], [1.12, 0, 0], {
                text: 'θ = 0',
                anchor: [1.12, 0, 0],
                dx: 8,
                dy: 4,
                anchorMode: 'start',
            });
            addAxis([0, 0, 0], [-1.12, 0, 0], {
                text: 'θ = π',
                anchor: [-1.12, 0, 0],
                dx: -8,
                dy: 4,
                anchorMode: 'end',
            });
            addAxis([0, 0, 0], [0, 0, 1.12], {
                text: 'φ = 0',
                anchor: [0, 0, 1.12],
                dx: 0,
                dy: -8,
                anchorMode: 'middle',
            });
            addAxis([0, 0, 0], [0, 0, -1.12], {
                text: 'φ = π',
                anchor: [0, 0, -1.12],
                dx: 0,
                dy: 14,
                anchorMode: 'middle',
            });
        }
        renderLabels(P);

        return {
            floor: floorLayer.selectAll<SVGPathElement, Vec3[]>('path'),
            // Only the tessellated quads carry Quad data; graticule and base
            // paths are re-projected from their own point arrays.
            surface: surfaceLayer.selectAll<SVGPathElement, Quad>('path.vis-quad'),
            lines: scene.selectAll<SVGPathElement, Vec3[]>('path.vis-line'),
            points: pointsLayer.selectAll<SVGCircleElement, Vec3>('circle'),
        };
    };

    let frame = build();

    // While dragging, render a coarse preview (25% of the full tessellation)
    // so the camera stays responsive; the full-quality scene is rebuilt on
    // release.
    const PREVIEW_QUALITY = 0.25;
    const rebuild = (quality: number): LayerFrame => {
        floorLayer.selectAll('*').remove();
        surfaceLayer.selectAll('*').remove();
        pointsLayer.selectAll('*').remove();
        axisLayer.selectAll('*').remove();
        axisLabels.length = 0;
        // A rebuild restores the full-quality scene, so the samples that were
        // hidden for the interaction preview come back.
        pointsLayer.attr('display', null);
        return build(quality);
    };

    // ---- Drawing in 2D ---------------------------------------------------
    // The same tools as 1D, acting on the domain's base. The cursor is mapped
    // back onto the base plane (or the hemisphere/sphere) by inverting the
    // projection, so a click lands where the user sees it.
    //
    // The capture rect sits above the scene and receives the pointer events,
    // so the arcball gesture must be started from here rather than on the root
    // (a drag handler on the root would swallow clicks meant for the tools).
    const baseHit = (event: PointerEvent): { x: number; y: number } | null => {
        const [px, py] = d3.pointer(event, root.node());
        const b = basis();
        const s = baseScale * zoom;
        // Screen offset from the projection centre, in world units along the
        // camera's right/up axes.
        const wx = (px - cx) / s;
        const wy = -(py - cy) / s;

        if (isSphere) {
            // The visible hemisphere: the point on the sphere that projects
            // here is `wx * right + wy * up + depth * fwd`.
            const r2 = wx * wx + wy * wy;
            if (r2 > 1) return null;
            const depth = Math.sqrt(Math.max(0, 1 - r2));
            const world: Vec3 = [
                wx * b.right[0] + wy * b.up[0] + depth * b.fwd[0],
                wx * b.right[1] + wy * b.up[1] + depth * b.fwd[1],
                wx * b.right[2] + wy * b.up[2] + depth * b.fwd[2],
            ];
            // Spherical coordinates: theta around z, phi from the pole.
            return { x: Math.atan2(world[1], world[0]), y: Math.acos(Math.max(-1, Math.min(1, world[2]))) };
        }

        if (isCircle) {
            // The disc is the z = 0 plane; solve for the point on it that
            // projects here: `wx * right + wy * up + t * fwd` with z = 0.
            const denom = b.fwd[2];
            if (Math.abs(denom) < 1e-6) return null;
            const t = -(wx * b.right[2] + wy * b.up[2]) / denom;
            const world: Vec3 = [
                wx * b.right[0] + wy * b.up[0] + t * b.fwd[0],
                wx * b.right[1] + wy * b.up[1] + t * b.fwd[1],
                0,
            ];
            const r = Math.hypot(world[0], world[1]);
            return r <= 1 ? { x: world[0], y: world[1] } : null;
        }

        // Planar bases: intersect the view ray with z = 0 in the same world
        // units as the grid.
        const denom = b.fwd[2];
        if (Math.abs(denom) < 1e-6) return null;
        const t = -(wx * b.right[2] + wy * b.up[2]) / denom;
        const worldX = wx * b.right[0] + wy * b.up[0] + t * b.fwd[0];
        const worldY = wx * b.right[1] + wy * b.up[1] + t * b.fwd[1];
        const half = isInterval ? 0.9 : 1.25;
        if (Math.abs(worldX) > half || Math.abs(worldY) > half) return null;
        return { x: worldX, y: worldY };
    };

    /** The domain value of a base point along x (and y in 2D). */
    const domainFromBase = (p: { x: number; y: number }): { x: number; y: number } => {
        if (isCircle) {
            return { x: Math.atan2(p.y, p.x), y: Math.hypot(p.x, p.y) };
        }
        if (isSphere) return p;
        // Planar bases are drawn in a normalized square spanning [-half, half],
        // while the domain may be any interval, so the base coordinates are
        // rescaled into the domain's bounds.
        const half = isInterval ? 0.9 : 1.25;
        const bounds = domainRange();
        return {
            x: bounds.min + ((p.x + half) / (2 * half)) * (bounds.max - bounds.min),
            y: bounds.min + ((p.y + half) / (2 * half)) * (bounds.max - bounds.min),
        };
    };

    /** The inverse of `domainFromBase`: a domain point in base coordinates. */
    const baseFromDomain = (x: number, y: number): { x: number; y: number } => {
        if (isCircle) return { x: Math.cos(x) * y, y: Math.sin(x) * y };
        if (isSphere) return { x, y };
        const half = isInterval ? 0.9 : 1.25;
        const bounds = domainRange();
        const width = Math.max(1e-9, bounds.max - bounds.min);
        return {
            x: -half + ((x - bounds.min) / width) * (2 * half),
            y: -half + ((y - bounds.min) / width) * (2 * half),
        };
    };

    const hitTest2D = (p: { x: number; y: number }): number | null => {
        const tolerance = HIT_RADIUS_PX / (baseScale * zoom);
        const target = domainFromBase(p);
        let best: number | null = null;
        let bestDistance = Infinity;
        for (const c of getComponents()) {
            // The y anchor is `meanY` for every family: `locationOf` only
            // resolves the x coordinate.
            const d = Math.hypot(locationOf(c) - target.x, c.meanY - target.y);
            if (d < bestDistance) {
                bestDistance = d;
                best = c.id;
            }
        }
        // The tolerance is expressed in base units, so compare it against a
        // distance measured in the same space.
        const scale = (2 * (isInterval ? 0.9 : 1.25)) / Math.max(1e-9, domainRange().max - domainRange().min);
        return best !== null && bestDistance * scale <= tolerance ? best : null;
    };

    // Markers for the drawn components: a dot at each lobe's anchor, filled
    // when selected, so the user can see what a click will pick.
    const markerLayer = root.append('g').attr('class', 'vis-2d-markers').attr('pointer-events', 'none');
    const drawMarkers = () => {
        markerLayer.selectAll('*').remove();
        const P = projector();
        const selected = getSelectedId();
        for (const c of getComponents()) {
            const gx = locationOf(c);
            const gy = c.meanY;
            const base = baseFromDomain(gx, gy);
            const at = isSphere
                ? [Math.sin(gy) * Math.cos(gx), Math.sin(gy) * Math.sin(gx), Math.cos(gy)]
                : [base.x, base.y, 0];
            const s = P(at as Vec3);
            const isSelected = c.id === selected;
            markerLayer
                .append('circle')
                .attr('cx', s.x)
                .attr('cy', s.y)
                .attr('r', isSelected ? 6 : 4.5)
                .attr('fill', isSelected ? COLOR.red : '#FFFFFF')
                .attr('stroke', isSelected ? COLOR.red : COLOR.ink)
                .attr('stroke-width', 1.6);
        }
    };

    let penGhost: Component | null = null;
    const ghostLayer = root.append('g').attr('class', 'vis-2d-ghost').attr('pointer-events', 'none');

    const drawGhost = () => {
        ghostLayer.selectAll('*').remove();
        if (!penGhost) return;
        const P = projector();
        // A small marker plus its footprint, so the pending lobe is visible
        // before it is committed.
        const gx = locationOf(penGhost);
        const gy = penGhost.meanY;
        const base = baseFromDomain(gx, gy);
        const at = isSphere ? [Math.sin(gy) * Math.cos(gx), Math.sin(gy) * Math.sin(gx), Math.cos(gy)] : [base.x, base.y, 0];
        const s = P(at as Vec3);
        ghostLayer
            .append('circle')
            .attr('cx', s.x)
            .attr('cy', s.y)
            .attr('r', 7)
            .attr('fill', 'none')
            .attr('stroke', COLOR.red)
            .attr('stroke-width', 1.6)
            .attr('stroke-dasharray', '3 3');
        ghostLayer
            .append('circle')
            .attr('cx', s.x)
            .attr('cy', s.y)
            .attr('r', 2.5)
            .attr('fill', COLOR.red);
    };

    const capture = root
        .append('rect')
        .attr('class', 'vis-truth-capture')
        .attr('width', width)
        .attr('height', height)
        .attr('fill', 'transparent')
        .attr('cursor', toolCursor(currentTool));

    capture
        .on('pointermove', (event: PointerEvent) => {
            if (currentTool !== 'add') {
                if (penGhost) {
                    penGhost = null;
                    drawGhost();
                }
                return;
            }
            const base = baseHit(event);
            if (!base) return;
            const d = domainFromBase(base);
            penGhost = { ...(penGhost ?? makeGhost(getCurrentFamily(), d.x, d.y)), ...locationPatch2D(penGhost ?? makeGhost(getCurrentFamily(), d.x, d.y), d.x, d.y) };
            drawGhost();
        })
        .on('pointerleave', () => {
            penGhost = null;
            drawGhost();
        })
        .on('click', (event: PointerEvent) => {
            const editing = isParamModifier(event) && getSelectedId() !== null;
            if (editing) return;
            const base = baseHit(event);
            if (currentTool === 'add') {
                if (!base) return;
                const d = domainFromBase(base);
                const ghost = penGhost ?? makeGhost(getCurrentFamily(), d.x, d.y);
                const id = addComponent(d.x, ghost.family, d.y);
                applyComponent(id, { ...ghost, ...locationPatch2D(ghost, d.x, d.y) });
                penGhost = null;
                drawGhost();
                return;
            }
            if (!base) {
                if (currentTool === 'select') select(null);
                return;
            }
            const hit = hitTest2D(base);
            if (currentTool === 'delete') {
                if (hit !== null) deleteComponent(hit);
            } else {
                select(hit);
            }
        });

    // Dragging a selected component's marker moves it across the base.
    let dragId: number | null = null;
    let dragOrigin: { px: number; py: number; x: number; y: number } | null = null;

    const onDragMove = (event: PointerEvent) => {
        if (dragId === null || !dragOrigin) return;
        // Re-use the same inverse projection as a click, so the lobe tracks the
        // cursor exactly wherever the camera is looking from.
        const base = baseHit(event);
        if (!base) return;
        const d = domainFromBase(base);
        moveComponent(dragId, d.x, d.y);
        // Redraw in place: a full render would destroy the gesture.
        frame = rebuild(PREVIEW_QUALITY);
        update(frame, false);
    };

    const onDragUp = () => {
        if (dragId === null) return;
        dragId = null;
        dragOrigin = null;
        draggingHandle = false;
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragUp);
        render();
    };

    capture.on('pointerdown', (event: PointerEvent) => {
        if (currentTool !== 'select') return;
        const base = baseHit(event);
        if (!base) return;
        const hit = hitTest2D(base);
        if (hit === null) return;
        event.preventDefault();
        event.stopPropagation();
        select(hit);
        const component = getComponents().find((c) => c.id === hit);
        if (!component) return;
        draggingHandle = true;
        dragId = hit;
        dragOrigin = { px: event.clientX, py: event.clientY, x: locationOf(component), y: component.meanY };
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragUp);
    });

    chartSubscriptions.push(() => {
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragUp);
    });

    drawMarkers();

    // ---- Arcball interaction ----
    // The camera gesture starts on the capture rect, which sits above the
    // scene. Attaching it to `root` would let it swallow the clicks that the
    // drawing tools need; the rect forwards a drag to the same handlers.
    root.style('cursor', 'grab');
    let dragging = false;
    let zoomTimer = 0;
    const drag = d3
        .drag<SVGRectElement, unknown>()
        .on('start', function () {
            d3.select(this).style('cursor', 'grabbing');
            dragging = true;
            frame = rebuild(PREVIEW_QUALITY);
        })
        .on('drag', (event) => {
            // The drag axes are derived from `up`. Near the pole
            // `cross(up, [0,0,1])` is ill-conditioned, so the axis direction
            // becomes noise and the camera spins. Clamp before deriving the
            // axes, and again after applying the delta.
            clampCamera(cam, minUp, maxUp);
            const b = basis();
            const s = baseScale * zoom;
            const dUp = -((event.dy / s) * 0.9);
            // Horizontal drag is inverted: dragging right rotates the scene
            // left (the model follows the cursor).
            const dRight = -((event.dx / s) * 0.9);

            // Reject motion that would push the camera past a limit instead
            // of letting it overshoot and snapping back.
            const nextUp = rotate(rotate(cam.up, b.right, dUp), b.fwd, dRight);
            const z = normalize(nextUp)[2];
            if (z >= minUp && z <= maxUp) {
                cam.up = nextUp;
            }
            clampCamera(cam, minUp, maxUp);
            update(frame, false);
        })
        .on('end', function () {
            d3.select(this).style('cursor', 'grab');
            if (!dragging) return;
            dragging = false;
            frame = rebuild(1);
        });
    capture.call(drag);

    root.on('wheel.arcball', (event: WheelEvent) => {
        event.preventDefault();
        const next = Math.max(0.6, Math.min(2.2, zoom * Math.exp(-event.deltaY * 0.001)));
        if (next === zoom) return;
        zoom = next;

        // Zooming uses the same coarse preview as dragging. Wheel events arrive
        // in bursts, so the preview is entered on the first tick and the
        // full-quality scene is restored once the burst ends.
        if (!dragging && !zoomTimer) frame = rebuild(PREVIEW_QUALITY);
        update(frame, false);

        if (dragging) return;
        clearTimeout(zoomTimer);
        zoomTimer = window.setTimeout(() => {
            zoomTimer = 0;
            frame = rebuild(1);
        }, 150);
    });
}

/* ---------------------------------------------------------------------------
 * Tool wheel, keyboard shortcuts and the reset confirmation
 * ------------------------------------------------------------------------- */

/** Resolve the reset confirmation dialog, if one is open. */
let pendingConfirm: ((confirmed: boolean) => void) | null = null;

/** Ask the user to confirm before wiping the drawn distribution. */
function confirmReset(): Promise<boolean> {
    return new Promise((resolve) => {
        const backdrop = document.getElementById('confirm-backdrop');
        const yes = document.getElementById('confirm-yes');
        const no = document.getElementById('confirm-no');
        if (!backdrop || !yes || !no) {
            resolve(false);
            return;
        }
        pendingConfirm = resolve;
        backdrop.hidden = false;
        no.focus();
    });
}

function settleConfirm(confirmed: boolean): void {
    const backdrop = document.getElementById('confirm-backdrop');
    if (backdrop) backdrop.hidden = true;
    const resolve = pendingConfirm;
    pendingConfirm = null;
    resolve?.(confirmed);
}

/** Prompt, then clear the drawn distribution if the user agrees. */
async function requestReset(): Promise<void> {
    if (!hasComponents()) return;
    if (await confirmReset()) resetGroundTruth();
}

/** Sync the wheel's active item and the toggle's expanded state. */
function syncToolWheel(): void {
    const menu = document.getElementById('tool-wheel-menu');
    const toggle = document.getElementById('tool-wheel-btn');
    const tool = getTool();
    menu?.querySelectorAll<HTMLElement>('.tool-wheel__item').forEach((item) => {
        const active = item.dataset.tool === tool;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-checked', String(active));
    });
    if (toggle) toggle.setAttribute('aria-expanded', String(menu?.classList.contains('is-open') ?? false));
}

function setWheelOpen(open: boolean): void {
    const menu = document.getElementById('tool-wheel-menu');
    const toggle = document.getElementById('tool-wheel-btn');
    menu?.classList.toggle('is-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

/** True when the event came from a field where typing should win. */
function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Let go of the focused control after it has been used.
 *
 * A focused `<select>` or `<input>` keeps swallowing keyboard input: a
 * `<select>` treats a letter key as "jump to the next option", so Shift+E would
 * change the distribution instead of cycling the parameter. Blurring the
 * control once the user is done with it returns the keyboard to the page, which
 * is where the shortcuts live.
 */
function releaseFocusOnCommit(target: EventTarget | null): void {
    const el = target as HTMLElement | null;
    if (!el) return;
    if (el.tagName === 'SELECT') el.blur();
}

function initDrawingTools(): void {
    const toggle = document.getElementById('tool-wheel-btn');
    const menu = document.getElementById('tool-wheel-menu');

    // Choosing an option finishes the interaction with the control, so the
    // keyboard goes back to the page (see `releaseFocusOnCommit`).
    document.addEventListener(
        'change',
        (event) => {
            if (isTypingTarget(event.target)) releaseFocusOnCommit(event.target);
        },
        true,
    );

    toggle?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWheelOpen(!menu?.classList.contains('is-open'));
    });

    menu?.querySelectorAll<HTMLElement>('.tool-wheel__item').forEach((item) => {
        item.addEventListener('click', () => {
            const tool = item.dataset.tool as Tool | undefined;
            setWheelOpen(false);
            if (tool === 'reset') {
                void requestReset();
            } else if (tool) {
                setTool(tool);
            }
        });
    });

    // Clicking elsewhere closes the wheel.
    document.addEventListener('click', () => setWheelOpen(false));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setWheelOpen(false);
    });

    document.getElementById('confirm-yes')?.addEventListener('click', () => settleConfirm(true));
    document.getElementById('confirm-no')?.addEventListener('click', () => settleConfirm(false));
    document.getElementById('confirm-backdrop')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) settleConfirm(false);
    });

    onToolChange(syncToolWheel);
    syncToolWheel();

    document.addEventListener('keydown', (event) => {
        if (isTypingTarget(event.target)) return;
        // Shift marks the parameter shortcuts; anything with Ctrl/Alt/Meta is
        // left to the browser.
        if (isParamModifier(event)) {
            if (handleParamShortcut(event)) event.preventDefault();
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

        switch (event.key.toLowerCase()) {
            case 'a':
                setTool('add');
                event.preventDefault();
                break;
            case 'd':
                setTool('delete');
                event.preventDefault();
                break;
            case 's':
                setTool('select');
                event.preventDefault();
                break;
            case 'r':
                void requestReset();
                event.preventDefault();
                break;
            default:
                break;
        }
    });

    // Shift+wheel over the chart nudges the selected parameter. Registered on
    // the container in the capture phase so it beats the camera's zoom handler.
    container?.addEventListener(
        'wheel',
        (event) => {
            if (!isParamModifier(event)) return;
            const direction = event.deltaY < 0 ? 1 : -1;
            if (getSelectedId() !== null) {
                event.preventDefault();
                event.stopPropagation();
                nudgeSelected(direction);
            } else if (getTool() === 'add' && previewNudge) {
                event.preventDefault();
                event.stopPropagation();
                previewNudge(direction);
            }
        },
        { capture: true, passive: false },
    );
}

/**
 * Whether the event carries the modifier used for parameter editing.
 *
 * Shift is the only modifier used. It is explicitly required: Ctrl/Alt/Meta
 * must all be absent, because those are claimed by the browser (Ctrl+W closes
 * a tab, Alt opens Firefox's menu bar) and a page cannot reliably intercept
 * them. `event.code` is matched against the physical key, so Shift+Q works the
 * same whether Caps Lock is on or not.
 */
function isParamModifier(event: KeyboardEvent | WheelEvent | PointerEvent | MouseEvent): boolean {
    if (!event.shiftKey) return false;
    return !event.ctrlKey && !event.altKey && !event.metaKey;
}

/**
 * Adjusts the pen's pending lobe while it is being previewed. Registered by
 * `render1D` so the shortcuts can size a lobe before it is planted, and cleared
 * when that chart is disposed.
 */
let previewNudge: ((direction: 1 | -1) => void) | null = null;
/** Cycles the pen's pending-lobe parameter, mirroring the selection shortcuts. */
let previewCycle: ((direction: 1 | -1) => void) | null = null;

/**
 * The pending lobe carried across a re-render. The preview is not part of the
 * ground-truth store, so a render triggered by a sigma change would otherwise
 * lose it; this hands the shape to the next chart.
 */
let pendingPreview: { component: Component; pinned: boolean; param: ParamKey } | null = null;

/** The ghost component the pen would plant, for the axis and the preview. */
function pendingGhost(): Component {
    return pendingPreview?.component ?? makeGhost(getCurrentFamily(), 0);
}

/**
 * True while a lobe handle is being dragged. Ground-truth changes are not
 * re-rendered during a drag, because replacing the chart would destroy the node
 * the gesture is attached to.
 */
let draggingHandle = false;

/**
 * Handle the parameter-editing shortcuts. Returns true when the event was
 * consumed.
 *
 * `event.code` identifies the physical key, so the binding is unaffected by
 * Caps Lock or by the layout's shifted characters.
 *
 * In pen mode with nothing selected, the shortcuts size the lobe currently
 * under the cursor instead of an existing component.
 */
function handleParamShortcut(event: KeyboardEvent): boolean {
    const hasSelection = getSelectedId() !== null;
    const penPreview = !hasSelection && getTool() === 'add' && previewNudge !== null;

    if (!hasSelection && !penPreview) return false;

    switch (event.code) {
        case 'KeyQ':
            if (hasSelection) cycleParam(-1);
            else previewCycle?.(-1);
            return true;
        case 'KeyE':
            if (hasSelection) cycleParam(1);
            else previewCycle?.(1);
            return true;
        case 'KeyW':
        case 'ArrowUp':
            if (hasSelection) nudgeSelected(1);
            else previewNudge?.(1);
            return true;
        case 'KeyS':
        case 'ArrowDown':
            if (hasSelection) nudgeSelected(-1);
            else previewNudge?.(-1);
            return true;
        default:
            return false;
    }
}

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

function chartSize(element: HTMLElement): { width: number; height: number } {
    const style = getComputedStyle(element);
    return {
        width: Math.max(200, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.max(200, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
    };
}

function render(): void {
    if (!container) return;
    // The container's padding reserves room for the floating toggle/toolbar, so
    // its content box is exactly the space available to the chart.
    const { width, height } = chartSize(container);

    // Only remove the chart we own — not the toolbar icons inside the container.
    disposeChart();
    d3.select(container).selectAll(':scope > svg.visualizer-chart').remove();
    const svg = d3
        .select(container)
        .append('svg')
        .attr('class', 'visualizer-chart')
        .attr('width', width)
        .attr('height', height)
        .attr('viewBox', `0 0 ${width} ${height}`)
        .attr('preserveAspectRatio', 'xMidYMid meet');

    if (currentDim === '2d') {
        render2D(svg, width, height);
    } else {
        render1D(svg, width, height);
    }
}

/** Mount the visualization and keep it in sync with the domain and dimension. */
export function initVisualizer(): void {
    container = document.getElementById('visualizer');
    if (!container) return;

    render();
    const size = chartSize(container);
    lastWidth = size.width;
    lastHeight = size.height;

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const width = Math.max(200, Math.round(entry.contentRect.width));
        const height = Math.max(200, Math.round(entry.contentRect.height));
        if (width === lastWidth && height === lastHeight) return;
        lastWidth = width;
        lastHeight = height;
        render();
    });
    resizeObserver.observe(container);

    onDimensionChange((dim) => {
        currentDim = dim;
        // The store needs to know which parameter set is in play, so the
        // shortcuts and the parameter list follow the dimension.
        setTwoDimensional(dim === '2d');
        render();
    });
    onDomainChange(() => render());
    onSamplingChange(() => render());

    initDrawingTools();
}
