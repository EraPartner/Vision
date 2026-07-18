/**
 * Vision Motion Tokens
 *
 * Shared springs, easings, and variants for Framer Motion.
 * Mirrors CSS duration/easing tokens in styles/tokens.css.
 * All consumers honor `prefers-reduced-motion` via useReducedMotion().
 */

import type { Transition } from "framer-motion";

// ---------- Easings ----------

export const easings = {
    outExpo: [0.16, 1, 0.3, 1] as const,
    outQuint: [0.22, 1, 0.36, 1] as const,
    inOutQuart: [0.77, 0, 0.175, 1] as const,
    standard: [0.4, 0, 0.2, 1] as const,
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
