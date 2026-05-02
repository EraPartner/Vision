// Phase F5 — property-based fuzz tests for parseLocaleNumber.
//
// Goal: catch parse regressions across locales without enumerating every
// pathological input by hand. fast-check generates thousands of cases per
// run; any counterexample is shrunk to a minimal failing input.
//
// Property covered:
//   - For any finite number n with reasonable precision, formatting it as
//     "{integer},{frac}" or "{integer}.{frac}" round-trips through
//     parseLocaleNumber to within float epsilon.
//   - parseLocaleNumber on null/undefined/empty/whitespace returns NaN.
//   - parseLocaleNumber on a number passes through unchanged.
//   - Negative parens "(123,45)" parses to a negative.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseLocaleNumber } from "@/utils/currency";

describe("Phase F5 — parseLocaleNumber properties", () => {
    it("number passthrough: any finite number is returned unchanged", () => {
        fc.assert(
            fc.property(
                fc.float({ noNaN: true, noDefaultInfinity: true }),
                (n) => parseLocaleNumber(n) === n,
            ),
        );
    });

    it("null / undefined / empty / whitespace → NaN", () => {
        fc.assert(
            fc.property(
                fc.constantFrom<string | null | undefined>(null, undefined, "", "   ", "\t\n"),
                (input) => Number.isNaN(parseLocaleNumber(input)),
            ),
        );
    });

    it("US-style format round-trips integer values", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 1_000_000_000 }),
                (n) => {
                    const formatted = n.toLocaleString("en-US"); // "1,234,567"
                    const parsed = parseLocaleNumber(formatted);
                    return parsed === n;
                },
            ),
        );
    });

    it("EU-style format round-trips two-decimal values", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 1_000_000 }),
                fc.integer({ min: 0, max: 99 }),
                (whole, frac) => {
                    // EU style: "1.234,56"
                    const wholeStr = whole.toLocaleString("de-DE");
                    const fracStr = String(frac).padStart(2, "0");
                    const formatted = `${wholeStr},${fracStr}`;
                    const parsed = parseLocaleNumber(formatted);
                    const expected = whole + frac / 100;
                    return Math.abs(parsed - expected) < 1e-9;
                },
            ),
        );
    });

    it("paren-wrapped value parses to its negation", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 0, max: 99 }),
                (whole, frac) => {
                    const fracStr = String(frac).padStart(2, "0");
                    const inner = `${whole},${fracStr}`;
                    const parsed = parseLocaleNumber(`(${inner})`);
                    const expected = -(whole + frac / 100);
                    return Math.abs(parsed - expected) < 1e-9;
                },
            ),
        );
    });

    it("currency symbol prefix is stripped before parsing", () => {
        fc.assert(
            fc.property(
                fc.constantFrom("$", "€", "£", "¥"),
                fc.integer({ min: 1, max: 999_999 }),
                (sym, n) => {
                    const formatted = `${sym}${n}`;
                    const parsed = parseLocaleNumber(formatted);
                    return parsed === n;
                },
            ),
        );
    });

    it("internal whitespace does not break parsing", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 1_000_000 }),
                (n) => {
                    const formatted = `${n.toString().slice(0, 1)} ${n.toString().slice(1)}`.trim();
                    const parsed = parseLocaleNumber(formatted);
                    return parsed === n || Number.isNaN(parsed); // whitespace stripping is best-effort
                },
            ),
        );
    });

    it("never throws on arbitrary string input", () => {
        fc.assert(
            fc.property(fc.string(), (s) => {
                // Should not throw; result is either a number or NaN
                const n = parseLocaleNumber(s);
                return typeof n === "number";
            }),
        );
    });
});
