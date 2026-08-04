// @vitest-environment node
/**
 * Motion token parity: `styles/tokens.css` and `lib/motion.ts` must describe
 * the SAME curve table.
 *
 * This exists because they once did not. CSS shipped Apple's sheet curve
 * `cubic-bezier(0.32, 0.72, 0, 1)` under BOTH `--ease-out-expo` and
 * `--ease-out-quint` (so the two "different" tokens were one curve), while
 * `lib/motion.ts` — under a docstring claiming it mirrored the CSS — defined
 * the real out-expo `[0.16, 1, 0.3, 1]`. A hover styled in Tailwind and a
 * chart draw-in animated by Framer therefore decelerated on different curves
 * while claiming one design system.
 *
 * The assertions below are deliberately TOTAL and BIDIRECTIONAL: every
 * `--ease-*` token in tokens.css must have a matching `easings` entry and
 * vice versa, with identical control points. Adding, renaming, or retuning a
 * curve in one layer fails this test until the other layer agrees.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { durations, easings } from "@/lib/motion";

const tokensCss = readFileSync(
    join(process.cwd(), "src/styles/tokens.css"),
    "utf8",
);

/** `--ease-in-out-quart` -> `inOutQuart` */
function tokenNameToKey(cssName: string): string {
    return cssName
        .replace(/^--ease-/, "")
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseCssEasings(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const re =
        /(--ease-[a-z-]+)\s*:\s*cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g;
    for (const m of tokensCss.matchAll(re)) {
        out[tokenNameToKey(m[1])] = [
            Number(m[2]),
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
        ];
    }
    return out;
}

function parseCssDurations(): Record<string, number> {
    const out: Record<string, number> = {};
    const re = /--duration-([a-z]+)\s*:\s*(\d+)ms/g;
    for (const m of tokensCss.matchAll(re)) {
        // CSS declares ms; Framer takes seconds.
        out[m[1]] = Number(m[2]) / 1000;
    }
    return out;
}

describe("motion token parity (tokens.css <-> lib/motion.ts)", () => {
    it("finds the curve table in tokens.css at all", () => {
        // Guards against the parser silently matching nothing (which would
        // make every set-equality assertion below vacuously pass).
        expect(Object.keys(parseCssEasings()).length).toBeGreaterThan(0);
        expect(Object.keys(parseCssDurations()).length).toBeGreaterThan(0);
    });

    it("declares exactly the same easing names in both layers", () => {
        expect(Object.keys(parseCssEasings()).sort()).toEqual(
            Object.keys(easings).sort(),
        );
    });

    it("declares the same control points for every easing", () => {
        const css = parseCssEasings();
        for (const [key, tuple] of Object.entries(easings)) {
            expect(css[key], `--ease-* token for easings.${key}`).toEqual([
                ...tuple,
            ]);
        }
    });

    it("has no two easings sharing one curve (that is what made the old names a facade)", () => {
        const seen = new Map<string, string>();
        for (const [key, tuple] of Object.entries(easings)) {
            const sig = tuple.join(",");
            const prior = seen.get(sig);
            expect(
                prior,
                `easings.${key} duplicates easings.${prior} (${sig}) — one curve must have one name`,
            ).toBeUndefined();
            seen.set(sig, key);
        }
    });

    it("has no reference to a motion token that tokens.css does not declare", () => {
        // Renaming a token is only half the job: `tailwind.config.ts` and the
        // utility rules in `index.css` also spell tokens by name, and a
        // `var(--gone)` with no fallback silently degrades to the property's
        // initial value rather than failing loudly. Retiring `--ease-out-quint`
        // left exactly such a dangling reference behind in the Tailwind
        // `dialog-out` animation, which nothing caught. This catches it.
        const declared = new Set<string>();
        for (const m of tokensCss.matchAll(
            /(--(?:ease|duration)-[a-z-]+)\s*:/g,
        )) {
            declared.add(m[1]);
        }

        const roots = [join(process.cwd(), "src")];
        const files: string[] = [join(process.cwd(), "tailwind.config.ts")];
        while (roots.length) {
            const dir = roots.pop()!;
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) {
                    if (entry !== "node_modules") roots.push(full);
                } else if (/\.(css|ts|tsx)$/.test(entry)) {
                    files.push(full);
                }
            }
        }

        const dangling: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, "utf8");
            for (const m of src.matchAll(
                /var\(\s*(--(?:ease|duration)-[a-z-]+)\s*[,)]/g,
            )) {
                if (!declared.has(m[1])) {
                    dangling.push(`${file.replace(process.cwd(), ".")}: ${m[1]}`);
                }
            }
        }
        expect(dangling).toEqual([]);
    });

    it("keeps the shared durations in step (CSS ms <-> Framer seconds)", () => {
        const css = parseCssDurations();
        for (const key of Object.keys(css)) {
            expect(durations[key as keyof typeof durations], `--duration-${key}`)
                .toBeCloseTo(css[key], 5);
        }
        // `page` is Framer-only: the route entrance has no CSS counterpart
        // now that PageTransition solely owns the page-level move.
        const framerOnly = Object.keys(durations).filter((k) => !(k in css));
        expect(framerOnly).toEqual(["page"]);
    });
});
