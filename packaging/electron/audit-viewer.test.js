"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  validateReadOptions,
  validateSnapshot,
  buildExport,
} = require("./audit-viewer");

const hash = "a".repeat(64);
const entry = (sequence, anchorStatus) => ({
  sequence,
  version: 1,
  previousHash: hash,
  hash,
  payload: { action: "test" },
  createdAt: "2026-09-20T00:00:00.000Z",
  anchorStatus,
});
const snapshot = (status = "partially_verified") => ({
  verification: { status, sequence: 2, hash, anchoredThrough: 1 },
  entries: [entry(1, "anchored"), entry(2, "pending_anchor")],
  hasMore: false,
});

test("read ranges are bounded and reject unexpected fields", () => {
  assert.deepEqual(validateReadOptions(), { afterSequence: 0, limit: 100 });
  assert.throws(
    () => validateReadOptions({ limit: 501 }),
    /Invalid audit read range/,
  );
  assert.throws(
    () => validateReadOptions({ trustedCheckpoint: { sequence: 1, hash } }),
    /Invalid audit read options/,
  );
});

test("partially verified page distinguishes anchored prefix and pending tail", () => {
  assert.deepEqual(
    validateSnapshot(snapshot(), { afterSequence: 0, limit: 100 }).entries.map(
      (item) => item.anchorStatus,
    ),
    ["anchored", "pending_anchor"],
  );
});

test("viewer rejects unavailable, gaps, false anchor labels, and truncated pages", () => {
  assert.throws(
    () =>
      validateSnapshot(
        {
          verification: { status: "unavailable" },
          entries: [],
          hasMore: false,
        },
        { afterSequence: 0, limit: 100 },
      ),
    /cannot be verified/,
  );
  const gap = snapshot();
  gap.entries[1].sequence = 3;
  assert.throws(
    () => validateSnapshot(gap, { afterSequence: 0, limit: 100 }),
    /malformed/,
  );
  const falseAnchor = snapshot();
  falseAnchor.entries[1].anchorStatus = "anchored";
  assert.throws(
    () => validateSnapshot(falseAnchor, { afterSequence: 0, limit: 100 }),
    /malformed/,
  );
  const truncated = snapshot();
  truncated.entries.pop();
  assert.throws(
    () => validateSnapshot(truncated, { afterSequence: 0, limit: 100 }),
    /does not reach/,
  );
});

test("export includes provenance warning and rejects an incomplete page", () => {
  const data = buildExport(
    validateSnapshot(snapshot(), { afterSequence: 0, limit: 500 }),
  );
  assert.match(data, /not a signed report or remote attestation/);
  assert.match(data, /pending_anchor/);
  const incomplete = snapshot();
  incomplete.hasMore = true;
  incomplete.verification.sequence = 3;
  assert.throws(
    () =>
      buildExport(
        validateSnapshot(incomplete, { afterSequence: 0, limit: 500 }),
      ),
    /500 entry export limit/,
  );
});

test("enrolled export preserves the limitation on pre-enrollment history", () => {
  const enrolled = snapshot();
  enrolled.verification.enrollmentSequence = 1;
  const data = buildExport(
    validateSnapshot(enrolled, { afterSequence: 0, limit: 500 }),
  );
  assert.match(data, /earlier authenticity cannot be proven/);
  assert.match(data, /"enrollmentSequence": 1/);
  enrolled.verification.enrollmentSequence = 2;
  assert.throws(
    () => validateSnapshot(enrolled, { afterSequence: 0, limit: 500 }),
    /cannot be verified/,
  );
});

test("retained audit export starts after the protected pruning boundary", () => {
  const retained = {
    verification: {
      status: "verified",
      sequence: 3,
      hash,
      anchoredThrough: 3,
      retentionThrough: 1,
    },
    entries: [entry(2, "anchored"), entry(3, "anchored")],
    hasMore: false,
  };
  const checked = validateSnapshot(retained, { afterSequence: 0, limit: 500 });
  assert.match(buildExport(checked), /Entries through sequence 1 were pruned/);
  const gap = structuredClone(retained);
  gap.entries[0].sequence = 1;
  assert.throws(
    () => validateSnapshot(gap, { afterSequence: 0, limit: 500 }),
    /malformed/,
  );
});
