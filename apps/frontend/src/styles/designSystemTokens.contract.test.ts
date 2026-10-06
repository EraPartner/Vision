// @vitest-environment node
/**
 * ADR-178 design-system tokens: the label hierarchy and the focus ring keep
 * their contrast floors in every theme variant and mode, and every role token
 * is both declared in CSS and reachable from Tailwind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_VARIANTS, themes, type ThemeTokens } from "./themes";

const tokensCss = readFileSync(
    join(process.cwd(), "src/styles/tokens.css"),
    "utf8",
);
const indexCss = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
// Read as text: importing the config into the app tsconfig trips its
// Tailwind v3-era `darkMode` typing.
const tailwindConfig = readFileSync(
    join(process.cwd(), "tailwind.config.ts"),
    "utf8",
);

function block(selector: ":root" | ".dark"): string {
    const start = tokensCss.indexOf(`${selector} {`);
    expect(start, `${selector} block in tokens.css`).toBeGreaterThan(-1);
    return tokensCss.slice(start, tokensCss.indexOf("\n    }", start));
}

function token(css: string, name: string): string | undefined {
    return css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
}

type Rgb = [number, number, number];

function hslToRgb(components: string): Rgb {
    const [h, s, l] = components.replace(/%/g, "").split(/\s+/).map(Number);
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
    const mixed = fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
    const [hi, lo] = [luminance(mixed), luminance(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["background", "card", "muted"] as const;
const LEVELS = ["secondary", "tertiary", "quaternary"] as const;

function alphaOf(palette: ThemeTokens, level: (typeof LEVELS)[number]) {
    return Number(palette[`label-${level}-alpha`]);
}

describe("tokens.css mirrors the default palette", () => {
    // themes.ts is what the app applies at boot; tokens.css is what renders
    // before it runs and in tests. The two must agree for the default theme.
    for (const [selector, mode] of [
        [":root", "light"],
        [".dark", "dark"],
    ] as const) {
        it(`keeps the ${mode} label alphas identical in both files`, () => {
            const css = block(selector);
            for (const level of LEVELS) {
                expect(
                    Number(token(css, `label-${level}-alpha`)),
                    `${level} in ${selector}`,
                ).toBe(alphaOf(themes.default[mode], level));
            }
        });
    }
});

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
    for (const [selector, mode] of [
        [":root", "light"],
        [".dark", "dark"],
    ] as const) {
        it(`keeps the ${mode} focus-ring alpha identical in both files`, () => {
            expect(Number(token(block(selector), "focus-ring-alpha"))).toBe(
                Number(themes.default[mode]["focus-ring-alpha"]),
            );
        });
    }

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

    it("draws the focus-ring utility from the alpha token", () => {
        expect(indexCss).toMatch(
            /@utility focus-ring \{[^}]*hsl\(var\(--ring\) \/ var\(--focus-ring-alpha\)\)/,
        );
    });
});

describe("role tokens are declared and exposed", () => {
    it("exposes the label colours through Tailwind", () => {
        for (const level of [
            "primary",
            "secondary",
            "tertiary",
            "quaternary",
        ]) {
            expect(tailwindConfig).toContain(
                `${level}: "hsl(var(--foreground) / var(--label-${level}-alpha))"`,
            );
        }
    });

    it("declares every corner role used by Tailwind", () => {
        for (const role of ["chip", "control", "card", "sheet"]) {
            expect(token(tokensCss, `radius-${role}`), role).toBeDefined();
            expect(tailwindConfig).toContain(
                `${role}: "var(--radius-${role})"`,
            );
        }
    });

    it("declares four elevation levels in light and dark", () => {
        for (const level of [1, 2, 3, 4]) {
            expect(
                tokensCss.match(new RegExp(`--elevation-${level}:`, "g")),
            ).toHaveLength(2);
            expect(tailwindConfig).toContain(
                `"elevation-${level}": "var(--elevation-${level})"`,
            );
        }
    });

    it("defines the type ramp, focus ring and continuous corners as utilities", () => {
        for (const role of [
            "large-title",
            "title-1",
            "title-2",
            "title-3",
            "headline",
            "body",
            "callout",
            "footnote",
            "caption",
        ]) {
            expect(indexCss, role).toMatch(
                new RegExp(`@utility type-${role} \\{`),
            );
        }
        expect(indexCss).toMatch(/@utility focus-ring \{/);
        expect(indexCss).toMatch(/@utility corner-continuous \{/);
    });
});
