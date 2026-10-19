// @vitest-environment node
/**
 * ADR-178 design-system tokens: the label hierarchy and the focus ring keep
 * their contrast floors in every theme variant and mode (computed from the
 * palettes the app applies, `themes.ts`).
 */
import { describe, expect, it } from "vitest";
import { THEME_VARIANTS, themes, type ThemeTokens } from "./themes";

type Rgb = [number, number, number];

function hslToRgb(components: string): Rgb {
    const [h, s, l] = components.replace(/%/g, "").split(/\s+/).map(Number);
    if (h === undefined || s === undefined || l === undefined) {
        throw new Error(`Malformed HSL components: ${components}`);
    }
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) =>
        light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
}

function luminance([r, g, b]: Rgb): number {
    const lin = (v: number) =>
        v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast of `fg` composited onto `bg` at `alpha`, against `bg`. */
function contrast(fg: Rgb, bg: Rgb, alpha: number): number {
    const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
    const mixed: Rgb = [
        mix(fg[0], bg[0]),
        mix(fg[1], bg[1]),
        mix(fg[2], bg[2]),
    ];
    const hi = Math.max(luminance(mixed), luminance(bg));
    const lo = Math.min(luminance(mixed), luminance(bg));
    return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["background", "card", "muted"] as const;
const LEVELS = ["secondary", "tertiary", "quaternary"] as const;

function alphaOf(palette: ThemeTokens, level: (typeof LEVELS)[number]) {
    return Number(palette[`label-${level}-alpha`]);
}

describe("label hierarchy contrast floors", () => {
    for (const variant of THEME_VARIANTS) {
        for (const mode of ["light", "dark"] as const) {
            const palette = themes[variant][mode];
            const fg = hslToRgb(palette.foreground);
            const surfaces = SURFACES.map((name) => ({
                name,
                rgb: hslToRgb(palette[name]),
            }));
            // Solarized light's full foreground reads 4.4:1 on its card, so AA
            // is out of reach for any secondary alpha; it is held to 4:1.
            const secondaryFloor =
                variant === "solarized" && mode === "light" ? 4 : 4.5;

            it(`keeps secondary text at ${secondaryFloor}:1 in ${variant}/${mode}`, () => {
                for (const surface of surfaces) {
                    expect(
                        contrast(
                            fg,
                            surface.rgb,
                            alphaOf(palette, "secondary"),
                        ),
                        `secondary on ${surface.name}`,
                    ).toBeGreaterThanOrEqual(secondaryFloor);
                }
            });

            it(`keeps tertiary text at 3:1 in ${variant}/${mode}`, () => {
                for (const surface of surfaces) {
                    expect(
                        contrast(fg, surface.rgb, alphaOf(palette, "tertiary")),
                        `tertiary on ${surface.name}`,
                    ).toBeGreaterThanOrEqual(3);
                }
            });

            it(`orders the levels strictly in ${variant}/${mode}`, () => {
                const levels = LEVELS.map((level) => alphaOf(palette, level));
                expect(levels.every((a) => a > 0 && a < 1)).toBe(true);
                expect([...levels].sort((x, y) => y - x)).toEqual(levels);
            });
        }
    }
});

describe("focus ring contrast", () => {
    // WCAG 1.4.11: a focus indicator needs 3:1 against adjacent colours. The
    // ring is --ring at --focus-ring-alpha, drawn 1px outside the control, so
    // the adjacent colour is whatever surface the control sits on.
    for (const variant of THEME_VARIANTS) {
        for (const mode of ["light", "dark"] as const) {
            it(`keeps the ring at 3:1 on every surface in ${variant}/${mode}`, () => {
                const palette = themes[variant][mode];
                const alpha = Number(palette["focus-ring-alpha"]);
                expect(alpha).toBeGreaterThan(0);
                expect(alpha).toBeLessThanOrEqual(1);
                const ring = hslToRgb(palette.ring);
                for (const name of SURFACES) {
                    expect(
                        contrast(ring, hslToRgb(palette[name]), alpha),
                        `ring on ${name}`,
                    ).toBeGreaterThanOrEqual(3);
                }
            });
        }
    }
});
