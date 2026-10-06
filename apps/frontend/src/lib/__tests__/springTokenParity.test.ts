// @vitest-environment node
/**
 * Spring parity: every `springs.<name>` in lib/motion.ts has a CSS twin in
 * styles/tokens.css — a `linear()` easing sampled from the same damped
 * spring plus its settle time. This test re-simulates each spring from its
 * Framer parameters and fails if the CSS samples or duration drift, so a
 * spring cannot be retuned in one layer only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { springs } from "@/lib/motion";

const tokensCss = readFileSync(
    join(process.cwd(), "src/styles/tokens.css"),
    "utf8",
);

/** Underdamped spring released from 0 towards 1 with zero initial velocity. */
function position(
    stiffness: number,
    damping: number,
    mass: number,
    t: number,
): number {
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
        1 -
        Math.exp(-zeta * w0 * t) *
            (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
}

function cssSpring(name: string): { points: number[]; durationMs: number } {
    const easing = tokensCss.match(
        new RegExp(`--spring-${name}:\\s*linear\\(([^)]*)\\)`),
    );
    const duration = tokensCss.match(
        new RegExp(`--spring-${name}-duration:\\s*(\\d+)ms`),
    );
    expect(easing, `--spring-${name} in tokens.css`).not.toBeNull();
    expect(duration, `--spring-${name}-duration in tokens.css`).not.toBeNull();
    return {
        points: easing![1].split(",").map((p) => Number(p.trim())),
        durationMs: Number(duration![1]),
    };
}

describe("spring token parity (tokens.css <-> lib/motion.ts)", () => {
    it("declares exactly the same spring names in both layers", () => {
        const cssNames = [
            ...tokensCss.matchAll(/--spring-([a-z]+):\s*linear\(/g),
        ].map((m) => m[1]);
        expect(cssNames.sort()).toEqual(Object.keys(springs).sort());
    });

    for (const [name, spring] of Object.entries(springs)) {
        it(`samples springs.${name} faithfully`, () => {
            const { stiffness, damping, mass } = spring;
            const { points, durationMs } = cssSpring(name);
            expect(points).toHaveLength(41);
            expect(points[0]).toBe(0);
            expect(points[points.length - 1]).toBe(1);

            // The duration is where the spring stays within 0.1% of rest.
            const settled = position(
                stiffness,
                damping,
                mass,
                durationMs / 1000,
            );
            expect(Math.abs(1 - settled)).toBeLessThan(0.002);

            const last = points.length - 1;
            points.forEach((sample, i) => {
                const t = ((durationMs / 1000) * i) / last;
                expect(
                    Math.abs(sample - position(stiffness, damping, mass, t)),
                    `springs.${name} sample ${i}`,
                ).toBeLessThan(0.002);
            });
        });
    }
});
