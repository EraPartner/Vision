// Phase F5 — property-based fuzz tests for unwrapEnvelope.
//
// ADR-026 envelope: { ok: true, data: T } / { ok: false, error: { ... } }.
// unwrapEnvelope tolerates non-envelope payloads during migration. These
// properties pin the contract:
//
//   - For any object { ok: true, data: X }, unwrap returns X.
//   - For non-envelope objects (no 'ok'), unwrap returns the body as-is.
//   - Never throws.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { unwrapEnvelope } from "@/lib/api/client";

describe("Phase F5 — unwrapEnvelope properties", () => {
    it("ok=true envelope returns data unchanged for any payload", () => {
        fc.assert(
            fc.property(
                fc.anything(),
                (data) => {
                    const out = unwrapEnvelope({ ok: true, data });
                    return Object.is(out, data);
                },
            ),
        );
    });

    it("non-envelope object passes through unchanged", () => {
        fc.assert(
            fc.property(
                fc.dictionary(
                    fc.string({ minLength: 1, maxLength: 10 }).filter((k) => k !== "ok"),
                    fc.anything(),
                ),
                (obj) => {
                    const out = unwrapEnvelope(obj);
                    return Object.is(out, obj);
                },
            ),
        );
    });

    it("primitives pass through unchanged", () => {
        fc.assert(
            fc.property(
                fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constantFrom(null, undefined)),
                (v) => {
                    const out = unwrapEnvelope(v);
                    return Object.is(out, v);
                },
            ),
        );
    });

    it("never throws on arbitrary input", () => {
        fc.assert(
            fc.property(fc.anything(), (input) => {
                expect(() => unwrapEnvelope(input)).not.toThrow();
            }),
        );
    });
});
