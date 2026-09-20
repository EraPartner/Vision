import { describe, expect, it } from "vitest";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  canonicalAuditPayload,
  createAuditEntry,
  __hashAuditEntry as hashAuditEntry,
  verifyAuditChain,
} from "../src/lib/auditChainCore.js";

function segment() {
  const first = createAuditEntry({
    sequence: 1,
    previousHash: AUDIT_CHAIN_GENESIS_HASH,
    payload: { event: "edit", table: "transactions", id: 42 },
  });
  const second = createAuditEntry({
    sequence: 2,
    previousHash: first.hash,
    payload: { event: "delete", table: "transactions", id: 43 },
  });
  const third = createAuditEntry({
    sequence: 3,
    previousHash: second.hash,
    payload: { event: "update", table: "transactions", id: 44 },
  });
  return {
    entries: [first, second, third],
    checkpoint: {
      firstSequence: 1,
      previousHash: AUDIT_CHAIN_GENESIS_HASH,
      expectedLastSequence: 3,
      expectedHeadHash: third.hash,
    },
  };
}

describe("audit chain core", () => {
  it("encodes object key order independently and binds version, sequence and predecessor", () => {
    const one = { nested: { z: 3, a: "é" }, action: "edit" };
    const two = { action: "edit", nested: { a: "é", z: 3 } };
    expect(canonicalAuditPayload(one)).toBe(canonicalAuditPayload(two));
    expect(
      hashAuditEntry({
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        payload: one,
      }),
    ).toBe(
      hashAuditEntry({
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        payload: two,
      }),
    );
    expect(
      hashAuditEntry({
        sequence: 2,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        payload: one,
      }),
    ).not.toBe(
      hashAuditEntry({
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        payload: one,
      }),
    );
  });

  it("rejects ambiguous numbers, non-JSON values, cycles and oversized data", () => {
    for (const value of [
      1.2,
      -0,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
      1n,
      new Date(),
      [undefined],
      new Array(1),
    ]) {
      expect(() => canonicalAuditPayload(value)).toThrow();
    }
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => canonicalAuditPayload(cyclic)).toThrow();
    expect(() =>
      canonicalAuditPayload({ [Symbol("hidden")]: "value" }),
    ).toThrow();
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "surprise",
    });
    expect(() => canonicalAuditPayload(accessor)).toThrow();
    const arrayWithExtra = [1];
    arrayWithExtra.extra = 2;
    expect(() => canonicalAuditPayload(arrayWithExtra)).toThrow();
    expect(() => canonicalAuditPayload("x".repeat(1_048_577))).toThrow(
      RangeError,
    );
  });

  it("accepts a valid segment with an explicit trusted predecessor and head", () => {
    const { entries, checkpoint } = segment();
    expect(verifyAuditChain(entries, checkpoint)).toEqual({
      ok: true,
      lastSequence: 3,
      headHash: entries[2].hash,
    });
    expect(
      verifyAuditChain(entries.slice(1), {
        firstSequence: 2,
        previousHash: entries[0].hash,
        expectedLastSequence: 3,
        expectedHeadHash: entries[2].hash,
      }).ok,
    ).toBe(true);
  });

  it("detects alteration, deletion, insertion and reordering", () => {
    const { entries, checkpoint } = segment();
    const altered = entries.map((entry) => ({ ...entry }));
    altered[1].payload = { ...altered[1].payload, id: 999 };
    expect(verifyAuditChain(altered, checkpoint)).toMatchObject({
      ok: false,
      code: "hash",
    });
    expect(
      verifyAuditChain([entries[0], entries[2]], checkpoint),
    ).toMatchObject({ ok: false, code: "sequence" });
    expect(
      verifyAuditChain(
        [entries[0], { ...entries[1], sequence: 2 }, ...entries.slice(1)],
        checkpoint,
      ),
    ).toMatchObject({ ok: false });
    expect(
      verifyAuditChain([entries[1], entries[0], entries[2]], checkpoint),
    ).toMatchObject({ ok: false, code: "sequence" });
  });

  it("detects removed tail and rewritten head only with an independent expected checkpoint", () => {
    const { entries, checkpoint } = segment();
    expect(verifyAuditChain(entries.slice(0, 2), checkpoint)).toMatchObject({
      ok: false,
      code: "length",
    });
    const rewritten = [entries[0]];
    rewritten.push(
      createAuditEntry({
        sequence: 2,
        previousHash: rewritten[0].hash,
        payload: { event: "other" },
      }),
    );
    rewritten.push(
      createAuditEntry({
        sequence: 3,
        previousHash: rewritten[1].hash,
        payload: entries[2].payload,
      }),
    );
    expect(verifyAuditChain(rewritten, checkpoint)).toMatchObject({
      ok: false,
      code: "head",
    });
    expect(
      verifyAuditChain(rewritten, {
        firstSequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
      }).ok,
    ).toBe(true);
  });
});
