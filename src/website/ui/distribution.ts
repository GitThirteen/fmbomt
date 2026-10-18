import * as d3 from 'd3';

/* ---------------------------------------------------------------------------
 * Distribution-shaped boundaries between blocks.
 *
 * Each boundary is a flat line with a number of Gaussian "lobes" sitting on
 * it (1 above the About section, 2 above Core, 3 above Code). The lobes are
 * draggable (mean) and resizable (peak height and width) via mouse drags, and
 * overlapping lobes mix by summing their densities.
 *
 * The block above is clipped so it fills *down to* the curve; the block below
 * is clipped so it fills *up from* the curve. Because the two blocks overlap
 * by the curve's height, their clipped backgrounds tile the seam exactly.
 * ------------------------------------------------------------------------- */

interface Gaussian {
    mean: number;
    std: number;
    amplitude: number;
}

/** Geometry constants (hopefully kept in sync with the --curve-height CSS variable!) */
const BASELINE_FRACTION = 0.82; // flat line sits near the bottom of the band
const MAX_RISE_FRACTION = 0.62; // max distance a peak rises above the baseline
const MIN_Y_FRACTION = 0.12;    // highest the curve may reach (top of band)
const HEADROOM_FRACTION = 1.0;  // extra space above the band for lobe overflow
const MIN_STD = 0.03;
const MAX_STD = 0.5;
const WIDTH_HANDLE_STD = 2.6;   // width handles sit at mean +/- std * this

type BoundaryState = Gaussian[];

/** Read the curve band height from the CSS variable so it stays in sync. */
function curveBandHeight(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--curve-height').trim();
    const px = parseFloat(raw);
    
    return Number.isFinite(px) ? px : 90;
}

/** Build the initial gaussian state for a boundary with `count` lobes. */
function makeInitialGaussians(count: number): Gaussian[] {
    const gaussians: Gaussian[] = [];

    for (let i = 0; i < count; i++) {
        gaussians.push({
            mean: Math.random(),
            std: 0.04 + Math.random() * 0.08,
            amplitude: 0.4 + Math.random() * 0.6,
        });
    }
    
    return gaussians;
}

/**
 * Compute the raw (unclamped) boundary curve: flat baseline + sum of gaussian
 * bumps. Points may go above the band (y < minY) when gaussians sum to exceed
 * the available height. Callers clamp as needed.
 */
function rawBoundaryCurve(
    width: number,
    bandHeight: number,
    gaussians: Gaussian[],
): Array<{ x: number; y: number }> {
    const baseline = bandHeight * BASELINE_FRACTION;
    const maxRise = bandHeight * MAX_RISE_FRACTION;

    const N = 140;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= N; i++) {
        const u = i / N;
        let rise = 0;

        for (const g of gaussians) {
            const z = (u - g.mean) / g.std;
            rise += g.amplitude * Math.exp(-0.5 * z * z);
        }

        points.push({ x: u * width, y: baseline - rise * maxRise });
    }

    return points;
}

/** Clamp a curve to the band (y >= minY). */
function clampCurve(
    points: Array<{ x: number; y: number }>,
    bandHeight: number,
): Array<{ x: number; y: number }> {
    const minY = bandHeight * MIN_Y_FRACTION;
    return points.map((p) => ({ x: p.x, y: Math.max(minY, p.y) }));
}

/**
 * Build a path "d" string for the overflow region: the parts of the raw curve
 * that rise above the band's clamp (y < minY). These are drawn dashed and
 * faded above the cut. Points are offset by `headroom` so they render in the
 * headroom above the band (not clamped, so lobes protrude into the prior
 * section).
 */
function overflowPath(
    raw: Array<{ x: number; y: number }>,
    bandHeight: number,
    headroom: number,
): string {
    const minY = bandHeight * MIN_Y_FRACTION;
    const parts: string[] = [];

    let inSegment = false;
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (!p) continue;

        const above = p.y < minY - 0.01;
        if (above) {
            const y = Math.max(2, p.y + headroom);
            if (!inSegment) {
                parts.push(`M${p.x},${y}`);
                inSegment = true;
            } else {
                parts.push(`L${p.x},${y}`);
            }
        } else {
            inSegment = false;
        }
    }

    return parts.join(' ');
}

/**
 * Build a path "d" string for the solid boundary stroke: only the parts of the
 * raw curve at or below the clamp (y >= minY). Where a lobe overflows (y <
 * minY), the solid line is interrupted so it does not render under the dashed
 * overflow. Points are offset by `headroom`.
 */
function solidStrokePath(
    raw: Array<{ x: number; y: number }>,
    bandHeight: number,
    headroom: number,
): string {
    const minY = bandHeight * MIN_Y_FRACTION;
    const parts: string[] = [];

    let inSegment = false;
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (!p) continue;

        const below = p.y >= minY - 0.01;
        if (below) {
            const y = p.y + headroom;
            if (!inSegment) {
                parts.push(`M${p.x},${y}`);
                inSegment = true;
            } else {
                parts.push(`L${p.x},${y}`);
            }
        } else {
            inSegment = false;
        }
    }

    return parts.join(' ');
}

/**
 * Compute the clamped boundary curve (flat baseline + sum of gaussian bumps),
 * clipped at the top of the band.
 */
function boundaryCurve(
    width: number,
    bandHeight: number,
    gaussians: Gaussian[],
): Array<{ x: number; y: number }> {
    return clampCurve(rawBoundaryCurve(width, bandHeight, gaussians), bandHeight);
}

/** Build a smooth SVG path "d" string from sampled points. */
function pointsToPath(points: Array<{ x: number; y: number }>): string {
    return d3.line<{ x: number; y: number }>()
        .x((d) => d.x)
        .y((d) => d.y)
        .curve(d3.curveBasis)(points) ?? '';
}

/**
 * Build a filled path for a single gaussian lobe (from its peak down to the
 * baseline). Used as a transparent hover target so hovering a lobe subtly
 * reveals that lobe's handles.
 */
function lobeHoverPath(width: number, bandHeight: number, headroom: number, g: Gaussian): string {
    const baseline = bandHeight * BASELINE_FRACTION + headroom;
    const maxRise = bandHeight * MAX_RISE_FRACTION;

    const N = 40;
    const pts: Array<{ x: number; y: number }> = [];
    const span = 4 * g.std;
    const lo = Math.max(0, g.mean - span);
    const hi = Math.min(1, g.mean + span);

    for (let i = 0; i <= N; i++) {
        const u = lo + (hi - lo) * (i / N);
        const z = (u - g.mean) / g.std;
        pts.push({ 
            x: u * width, 
            y: baseline - g.amplitude * maxRise * Math.exp(-0.5 * z * z) 
        });
    }

    return `${pointsToPath(pts)} L${hi * width},${baseline} L${lo * width},${baseline} Z`;
}

/**
 * Build the clip-path (silhouette) for a block, in the block's own box space.
 */
function blockClipPath(
    width: number,
    height: number,
    bandHeight: number,
    topCurve: Array<{ x: number; y: number }> | null,
    bottomCurve: Array<{ x: number; y: number }> | null,
): string {
    const parts: string[] = [];

    if (topCurve) {
        parts.push(pointsToPath(topCurve));
        parts.push(`L${width},${height - bandHeight}`);
    } else {
        parts.push(`M0,0 L${width},0 L${width},${height - bandHeight}`);
    }

    if (bottomCurve) {
        const offset = height - bandHeight;
        const shifted = [...bottomCurve].reverse().map((p) => ({ x: p.x, y: p.y + offset }));
        const first = shifted[0];

        if (first) {
            parts.push(`L${first.x},${first.y}`);
            parts.push(pointsToPath(shifted).replace(/^M[^LC]*/, ''));
        } else {
            parts.push(`L0,${height}`);
        }
    } else {
        parts.push(`L0,${height}`);
    }

    parts.push('Z');
    return parts.join(' ');
}

/* -----------------------------------
 * State + views
 * --------------------------------- */

let blocks: HTMLElement[] = [];
let boundaryStates: BoundaryState[] = [];
let resizeObserver: ResizeObserver | null = null;

/** Live references to each boundary's SVG sub-elements, for in-place updates. */
interface BoundaryView {
    svg: SVGSVGElement;
    curvePath: SVGPathElement;
    overflowPath: SVGPathElement;
    hoverZones: SVGPathElement[];
    peakHandles: SVGCircleElement[];
    widthHandles: SVGRectElement[];
}

let boundaryViews: BoundaryView[] = [];

/** Current geometry (updated on render/resize). */
let currentWidth = 0;
let currentBandHeight = 0;

function baselineY(bandHeight: number): number {
    return bandHeight * BASELINE_FRACTION;
}

/**
 * Set block clip-paths from their top/bottom boundary curves. When
 * `boundaryIndex` is given, only the two blocks adjacent to that boundary are
 * updated (the others are unaffected), which keeps drags cheap.
 */
function updateClipPaths(boundaryIndex?: number): void {
    const bandHeight = currentBandHeight;
    const width = currentWidth;

    const curveFor = (i: number) => {
        const g = boundaryStates[i];
        return g ? boundaryCurve(width, bandHeight, g) : null;
    };

    const indices: number[] = [];
    if (boundaryIndex === undefined) {
        for (let i = 0; i < blocks.length; i++) indices.push(i);
    } else {
        // Boundary `boundaryIndex` is the bottom edge of block `boundaryIndex`
        // and the top edge of block `boundaryIndex + 1`.
        indices.push(boundaryIndex, boundaryIndex + 1);
    }

    indices.forEach((i) => {
        const block = blocks[i];
        if (!block) return;

        const height = block.clientHeight;
        const topCurve = i > 0 ? curveFor(i - 1) : null;
        const bottomCurve = i < blocks.length - 1 ? curveFor(i) : null;
        block.style.setProperty('--block-clip', `path('${blockClipPath(width, height, bandHeight, topCurve, bottomCurve)}')`);
    });
}

/** Update one boundary's curve + overflow + handle positions in place. */
function updateBoundaryView(view: BoundaryView, gaussians: Gaussian[]): void {
    const width = currentWidth;
    const bandHeight = currentBandHeight;
    const headroom = bandHeight * HEADROOM_FRACTION;
    const baseline = baselineY(bandHeight);

    const raw = rawBoundaryCurve(width, bandHeight, gaussians);
    view.curvePath.setAttribute('d', solidStrokePath(raw, bandHeight, headroom));
    view.overflowPath.setAttribute('d', overflowPath(raw, bandHeight, headroom));

    gaussians.forEach((g, gi) => {
        view.hoverZones[gi]?.setAttribute('d', lobeHoverPath(width, bandHeight, headroom, g));

        const peak = view.peakHandles[gi];
        if (peak) {
            peak.setAttribute('cx', String(g.mean * width));
            peak.setAttribute('cy', String(baseline - g.amplitude * bandHeight * MAX_RISE_FRACTION + headroom));
        }

        [-1, 1].forEach((side, si) => {
            const handle = view.widthHandles[gi * 2 + si];
            if (handle) {
                const hx = (g.mean + side * g.std * WIDTH_HANDLE_STD) * width;
                handle.setAttribute('x', String(hx - 7.5));
            }
        });
    });
}

/** Absolute page coordinates of an element's top edge. */
function pageTop(el: HTMLElement): number {
    return el.getBoundingClientRect().top + window.scrollY;
}

/** Absolute page coordinates of an element's bottom edge. */
function pageBottom(el: HTMLElement): number {
    return el.getBoundingClientRect().bottom + window.scrollY;
}

/** Full (re)build of all boundary overlays. Called on init and resize. */
function buildOverlays(): void {
    // Remove previous overlay container.
    document.querySelectorAll('.curve-overlay').forEach((n) => n.remove());
    boundaryViews = [];

    const bandHeight = currentBandHeight;
    const headroom = bandHeight * HEADROOM_FRACTION;
    const width = currentWidth;
    const baseline = baselineY(bandHeight);

    const main = blocks[0]?.parentElement;
    if (!main) return;

    // A single top-level overlay that sits above all blocks, so the gaussian
    // lobes are never hidden behind a section's content or stacking context.
    const overlay = d3.select(main)
        .append('div')
        .attr('class', 'curve-overlay');

    // Bands of content that curves must not be drawn over (e.g. the CC0 note
    // between the core and code sections).
    const protectedRanges = Array.from(
        main.querySelectorAll<HTMLElement>('[data-curve-clear]'),
    ).map((el) => ({ top: pageTop(el), bottom: pageBottom(el) }));

    blocks.forEach((block, i) => {
        if (i >= blocks.length - 1) return; // last block has no bottom boundary

        const gaussians = boundaryStates[i];
        if (!gaussians) return;

        // Absolute position of this boundary within `main`. The SVG is taller
        // than the band (it includes `headroom` above) so overflowing lobes can
        // protrude upward into the prior section.
        const top = block.offsetTop + block.clientHeight - bandHeight - headroom;

        const svg = overlay.append('svg')
            .attr('class', 'curve-stroke')
            .style('top', `${top}px`)
            .attr('viewBox', `0 0 ${width} ${bandHeight + headroom}`)
            .attr('preserveAspectRatio', 'none');

        const raw = rawBoundaryCurve(width, bandHeight, gaussians);

        // Only the parts of the curve that stay outside the protected ranges.
        const visible = raw.filter((p) => {
            const y = pageTop(main) + top + p.y + headroom;
            return !protectedRanges.some((r) => y >= r.top && y <= r.bottom);
        });

        // Solid boundary stroke: only where the curve is at/below the clamp.
        const curvePath = svg.append('path')
            .attr('d', solidStrokePath(visible, bandHeight, headroom))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(215, 38, 61, 0.55)')
            .attr('stroke-width', 1.5)
            .node() as SVGPathElement;

        // Overflow: the part of the distribution that exceeds the band, drawn
        // dashed and faded above the cut (protruding into the prior section).
        const overflow = svg.append('path')
            .attr('d', overflowPath(visible, bandHeight, headroom))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(215, 38, 61, 0.30)')
            .attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '6 4')
            .attr('pointer-events', 'none')
            .node() as SVGPathElement;

        // Handles are kept in the DOM for interaction but hidden visually so
        // only the distribution line shows as the border.
        const peakHandles: SVGCircleElement[] = [];
        const widthHandles: SVGRectElement[] = [];
        const hoverZones: SVGPathElement[] = [];

        gaussians.forEach((g, gi) => {
            // Transparent hover target shaped like this lobe, so hovering a
            // lobe subtly reveals only that lobe's handles.
            const hoverZone = svg.append('path')
                .attr('class', `lobe-hover lobe-hover-${gi}`)
                .attr('d', lobeHoverPath(width, bandHeight, headroom, g))
                .attr('fill', '#D7263D')
                .attr('pointer-events', 'all')
                .node() as SVGPathElement;
            hoverZones.push(hoverZone);

            const peak = svg.append('circle')
                .attr('class', `gauss-handle gauss-handle--peak lobe-${gi}`)
                .attr('cx', g.mean * width)
                .attr('cy', baseline - g.amplitude * bandHeight * MAX_RISE_FRACTION + headroom)
                .attr('r', 12)
                .attr('fill', '#D7263D')
                .attr('stroke', '#FFFFFF')
                .attr('stroke-width', 2)
                .style('cursor', 'move')
                .node() as SVGCircleElement;
            attachPeakDrag(peak, i, gi);
            peakHandles.push(peak);

            const widthNodes: SVGRectElement[] = [];
            [-1, 1].forEach((side) => {
                const hx = (g.mean + side * g.std * WIDTH_HANDLE_STD) * width;
                const handle = svg.append('rect')
                    .attr('class', `gauss-handle gauss-handle--width lobe-${gi}`)
                    .attr('x', hx - 7.5).attr('y', baseline + headroom - 7.5)
                    .attr('width', 15).attr('height', 15)
                    .attr('rx', 2.5)
                    .attr('fill', '#D7263D')
                    .attr('stroke', '#FFFFFF')
                    .attr('stroke-width', 2)
                    .style('cursor', 'ew-resize')
                    .node() as SVGRectElement;
                attachWidthDrag(handle, i, gi);
                widthHandles.push(handle);
                widthNodes.push(handle);
            });

            // Reveal this lobe's handles and tint the lobe red while hovering
            // the lobe itself or any of its handles. On leave we defer a frame
            // and re-check :hover so moving between the lobe and its handles
            // doesn't flicker the tint off.
            const lobeNodes = [peak, ...widthNodes];
            const reveal = () => {
                hoverZone.classList.add('is-revealed');
                lobeNodes.forEach((n) => n.classList.add('is-revealed'));
            };
            const hide = () => {
                requestAnimationFrame(() => {
                    const stillHovered =
                        hoverZone.matches(':hover') || lobeNodes.some((n) => n.matches(':hover'));
                    if (!stillHovered) {
                        hoverZone.classList.remove('is-revealed');
                        lobeNodes.forEach((n) => n.classList.remove('is-revealed'));
                    }
                });
            };

            hoverZone.addEventListener('pointerenter', reveal);
            hoverZone.addEventListener('pointerleave', hide);
            lobeNodes.forEach((n) => {
                n.addEventListener('pointerenter', reveal);
                n.addEventListener('pointerleave', hide);
            });
        });

        boundaryViews.push({
            svg: svg.node() as SVGSVGElement,
            curvePath,
            overflowPath: overflow,
            hoverZones,
            peakHandles,
            widthHandles,
        });
    });
}

/** Convert a pointer event to band coordinates (y in 0..bandHeight). */
function eventToBand(svg: SVGSVGElement, e: PointerEvent, bandHeight: number): { u: number; y: number } {
    const rect = svg.getBoundingClientRect();
    const headroom = bandHeight * HEADROOM_FRACTION;
    const u = (e.clientX - rect.left) / rect.width;
    // The SVG viewBox is (bandHeight + headroom) tall with the band at the
    // bottom, so subtract headroom to get band coordinates.
    const y = ((e.clientY - rect.top) / rect.height) * (bandHeight + headroom) - headroom;
    return { u, y };
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

/** Drag the peak handle: horizontal = mean, vertical = amplitude. */
function attachPeakDrag(node: SVGCircleElement, boundaryIndex: number, gi: number): void {
    const svg = node.ownerSVGElement;
    if (!svg) return;
    const bandHeight = currentBandHeight;
    const baseline = baselineY(bandHeight);
    const maxRise = bandHeight * MAX_RISE_FRACTION;

    let dragging = false;
    let pending = false;

    node.addEventListener('pointerdown', (e) => {
        dragging = true;
        node.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    node.addEventListener('pointermove', (e) => {
        if (!dragging) return;

        const { u, y } = eventToBand(svg, e, bandHeight);
        const g = boundaryStates[boundaryIndex]?.[gi];
        if (!g) return;

        g.mean = clamp(u, 0, 1);
        g.amplitude = clamp((baseline - y) / maxRise, 0.05, 1);
        if (pending) return;

        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            const view = boundaryViews[boundaryIndex];
            const state = boundaryStates[boundaryIndex];
            if (view && state) {
                updateBoundaryView(view, state);
                updateClipPaths(boundaryIndex);
            }
        });
    });

    const end = () => { dragging = false; };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
}

/** Drag a width handle: changes std based on horizontal distance from mean. */
function attachWidthDrag(node: SVGRectElement, boundaryIndex: number, gi: number): void {
    const svg = node.ownerSVGElement;
    if (!svg) return;

    const bandHeight = currentBandHeight;
    let dragging = false;
    let pending = false;

    node.addEventListener('pointerdown', (e) => {
        dragging = true;
        node.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    node.addEventListener('pointermove', (e) => {
        if (!dragging) return;

        const { u } = eventToBand(svg, e, bandHeight);
        const g = boundaryStates[boundaryIndex]?.[gi];
        if (!g) return;

        g.std = clamp(Math.abs(u - g.mean) / WIDTH_HANDLE_STD, MIN_STD, MAX_STD);

        if (pending) return;

        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            const view = boundaryViews[boundaryIndex];
            const state = boundaryStates[boundaryIndex];

            if (view && state) {
                updateBoundaryView(view, state);
                updateClipPaths(boundaryIndex);
            }
        });
    });

    const end = () => { dragging = false; };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
}

/**
 * Initialize the distribution-shaped boundaries for the blocks that are direct
 * children of `<main>` (sections and the footer). Re-renders whenever any block
 * changes size.
 */
export function initDistributionCurves(): void {
    blocks = Array.from(document.querySelectorAll<HTMLElement>('main > section, main > footer'));
    if (blocks.length === 0) return;

    currentBandHeight = curveBandHeight();
    currentWidth = blocks[0]?.clientWidth || 1320;

    boundaryStates = [];
    for (let i = 0; i < blocks.length - 1; i++) {
        boundaryStates.push(makeInitialGaussians(i + 1));
    }

    buildOverlays();
    updateClipPaths();

    resizeObserver = new ResizeObserver(() => {
        currentBandHeight = curveBandHeight();
        currentWidth = blocks[0]?.clientWidth || 1320;
        buildOverlays();
        updateClipPaths();
    });

    blocks.forEach((block) => resizeObserver!.observe(block));
}
