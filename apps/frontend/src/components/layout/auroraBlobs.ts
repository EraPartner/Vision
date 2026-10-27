/**
 * Geometry and drift of the two aurora blobs, for the WebGL path.
 *
 * index.css draws the blobs as `.liquid-canvas::before/::after` radial
 * gradients. While the WebGL aurora is live it draws them itself, in the same
 * frame as its noise (one animator instead of two out-of-step ones), so this
 * module mirrors the CSS exactly. Keep the two in sync:
 *
 * - emerald (`::before`): a max(55vw, 34rem) square at top -18% / left -12%;
 * - champagne (`::after`): a max(48vw, 30rem) square at bottom -22% /
 *   right -10%;
 * - each gradient runs from the colour at the centre to transparent at 72%
 *   of the half side (`closest-side ... transparent 72%`), linear in alpha;
 * - the full-effects drift: aurora-drift-a/-b in index.css, 64s/76s,
 *   alternate, along --ease-in-out-quart (cubic-bezier(0.77, 0, 0.175, 1)).
 *   Without the drift (no full effects on enhanced, static atmosphere,
 *   reduced motion) the CSS blobs run `animation: none`, i.e. no transform.
 *
 * Pure: unit-tested directly, since the canvas cannot run in jsdom.
 */

export interface Viewport {
    /** CSS pixels. */
    width: number;
    height: number;
    /** Root font size in CSS pixels (for the rem minimums). */
    rem: number;
}

export interface BlobCircle {
    /** Centre and fade-out radius, CSS pixels from the viewport's top left. */
    x: number;
    y: number;
    radius: number;
}

const FADE_END = 0.72;

// cubic-bezier(0.77, 0, 0.175, 1): --ease-in-out-quart in tokens.css.
const P1X = 0.77;
const P1Y = 0;
const P2X = 0.175;
const P2Y = 1;

function bezierAxis(t: number, p1: number, p2: number): number {
    const u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierSlope(t: number, p1: number, p2: number): number {
    const u = 1 - t;
    return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** The --ease-in-out-quart curve: progress in [0, 1] to eased value. */
export function easeInOutQuart(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton on x(t) = x, then bisection if the slope is flat.
    let t = x;
    for (let i = 0; i < 8; i++) {
        const err = bezierAxis(t, P1X, P2X) - x;
        if (Math.abs(err) < 1e-6) return bezierAxis(t, P1Y, P2Y);
        const slope = bezierSlope(t, P1X, P2X);
        if (Math.abs(slope) < 1e-6) break;
        t -= err / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
        const v = bezierAxis(t, P1X, P2X);
        if (Math.abs(v - x) < 1e-6) break;
        if (v < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
    }
    return bezierAxis(t, P1Y, P2Y);
}

/** Eased progress of an `alternate` animation of `durationSec` at `timeSec`. */
export function alternateProgress(timeSec: number, durationSec: number): number {
    const cycles = Math.max(0, timeSec) / durationSec;
    const whole = Math.floor(cycles);
    const frac = cycles - whole;
    return easeInOutQuart(whole % 2 === 0 ? frac : 1 - frac);
}

/**
 * Both blob circles at `timeSec` of the drift, or at rest when `drift` is
 * false (the CSS `animation: none` state).
 */
export function auroraBlobs(
    viewport: Viewport,
    timeSec: number,
    drift: boolean,
): { a: BlobCircle; b: BlobCircle } {
    const { width: w, height: h, rem } = viewport;
    const vw = w / 100;
    const vh = h / 100;

    const sideA = Math.max(55 * vw, 34 * rem);
    const sideB = Math.max(48 * vw, 30 * rem);

    const ea = drift ? alternateProgress(timeSec, 64) : 0;
    const eb = drift ? alternateProgress(timeSec, 76) : 0;
    // At rest the CSS blobs have no transform at all, so b's scale is 1
    // there, not the 1.12 its keyframes start from.
    const scaleA = drift ? 1 + 0.18 * ea : 1;
    const scaleB = drift ? 1.12 - 0.16 * eb : 1;

    return {
        a: {
            x: -0.12 * w + sideA / 2 + 14 * vw * ea,
            y: -0.18 * h + sideA / 2 + 9 * vh * ea,
            radius: (sideA / 2) * FADE_END * scaleA,
        },
        b: {
            x: 1.1 * w - sideB / 2 - 11 * vw * eb,
            y: 1.22 * h - sideB / 2 - 7 * vh * eb,
            radius: (sideB / 2) * FADE_END * scaleB,
        },
    };
}
