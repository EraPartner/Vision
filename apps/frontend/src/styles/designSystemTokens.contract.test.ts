// @vitest-environment node
/**
 * ADR-178 design-system tokens: the label hierarchy keeps its contrast
 * floors in the base light and dark palettes, and every role token is both
 * declared in CSS and reachable from Tailwind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

function hslToRgb(components: string): [number, number, number] {
    const [h, s, l] = components.replace(/%/g, "").split(/\s+/).map(Number);
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) =>
        light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
}

function luminance([r, g, b]: [number, number, number]): number {
    const lin = (v: number) =>
        v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(
    fg: [number, number, number],
    bg: [number, number, number],
    alpha: number,
): number {
    const mixed = fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as [
        number,
        number,
        number,
    ];
    const [hi, lo] = [luminance(mixed), luminance(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe("label hierarchy contrast floors", () => {
    const light = block(":root");
    const dark = block(".dark");
    // .dark overrides every alpha below; only the primary alpha is shared.
    const palettes = { light, dark };

    for (const [mode, own] of Object.entries(palettes)) {
        const fg = hslToRgb(token(own, "foreground")!);
        const surfaces = ["background", "card", "muted"].map((name) => ({
            name,
            rgb: hslToRgb(token(own, name)!),
        }));
        const alpha = (level: string) =>
            Number(token(own, `label-${level}-alpha`));

        it(`keeps secondary text at AA (4.5:1) in ${mode}`, () => {
            for (const surface of surfaces) {
                expect(
                    contrast(fg, surface.rgb, alpha("secondary")),
                    `secondary on ${surface.name}`,
                ).toBeGreaterThanOrEqual(4.5);
            }
        });

        it(`keeps tertiary text at 3:1 in ${mode}`, () => {
            for (const surface of surfaces) {
                expect(
                    contrast(fg, surface.rgb, alpha("tertiary")),
                    `tertiary on ${surface.name}`,
                ).toBeGreaterThanOrEqual(3);
            }
        });

        it(`orders the levels strictly in ${mode}`, () => {
            const levels = ["secondary", "tertiary", "quaternary"].map(alpha);
            expect(levels.every((a) => a > 0 && a < 1)).toBe(true);
            expect([...levels].sort((x, y) => y - x)).toEqual(levels);
        });
    }
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
