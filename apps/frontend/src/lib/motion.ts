/**
 * Vision Motion Tokens
 *
 * Shared springs and easings for Framer Motion.
 *
 * `styles/tokens.css` owns the curve table; this file mirrors it because
 * Framer needs the raw control points rather than a `cubic-bezier(...)`
 * string. The mirroring is enforced, not promised:
 * `lib/__tests__/motionTokenParity.test.ts` parses tokens.css and asserts the
 * two tables are identical — same names, same numbers, in both directions —
 * so neither layer can be edited alone. Add or rename a curve here and the
 * test fails until tokens.css agrees, and vice versa.
 *
 * Historical note: this docstring used to claim it "mirrors" tokens.css while
 * the two layers in fact defined different curves under the same names —
 * CSS shipped Apple's sheet curve as both `--ease-out-expo` and
 * `--ease-out-quint`, while Framer ran the real out-expo. That is the drift
 * the parity test now makes impossible.
 *
 * All consumers honor `prefers-reduced-motion` via useReducedMotion().
 */

import type { Transition } from "framer-motion";

// ---------- Easings ----------

/**
 * Choose by role, not by feel:
 * - `glide`      — an on-screen element moving between two resting states
 *                  (hover, colour/size/position changes).
 * - `outExpo`    — an element ARRIVING (page/section entrances, chart draws).
 * - `inOutQuart` — ambient loops that ease at both ends.
 */
export const easings = {
    glide: [0.32, 0.72, 0, 1] as const,
    outExpo: [0.16, 1, 0.3, 1] as const,
    inOutQuart: [0.77, 0, 0.175, 1] as const,
} as const;

// ---------- Durations (seconds for Framer) ----------

export const durations = {
    fast: 0.15,
    normal: 0.26,
    slow: 0.42,
    page: 0.52,
} as const;

// ---------- Springs ----------

export const springs = {
    soft: {
        type: "spring",
        stiffness: 240,
        damping: 28,
        mass: 0.9,
    },
    snappy: {
        type: "spring",
        stiffness: 420,
        damping: 32,
        mass: 0.7,
    },
    bouncy: {
        type: "spring",
        stiffness: 260,
        damping: 20,
        mass: 0.8,
    },
    dialog: {
        type: "spring",
        stiffness: 300,
        damping: 30,
        mass: 0.85,
    },
} satisfies Record<string, Transition>;
