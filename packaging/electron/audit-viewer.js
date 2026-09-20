"use strict";

const HASH = /^[0-9a-f]{64}$/;
const MAX_PAGE_SIZE = 500;
const MAX_EXPORT_BYTES = 2_000_000;

function isSequence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateReadOptions(options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => !["afterSequence", "limit"].includes(key),
    )
  ) {
    throw new Error("Invalid audit read options");
  }
  const afterSequence = options.afterSequence ?? 0;
  const limit = options.limit ?? 100;
  if (
    !isSequence(afterSequence) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new Error("Invalid audit read range");
  }
  return { afterSequence, limit };
}

function validateSnapshot(raw, options) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Audit snapshot is unavailable");
  }
  const verification = raw.verification;
  if (
    !verification ||
    !["verified", "partially_verified"].includes(verification.status) ||
    !isSequence(verification.sequence) ||
    !HASH.test(verification.hash) ||
    !isSequence(verification.anchoredThrough) ||
    verification.anchoredThrough > verification.sequence ||
    (verification.retentionThrough !== undefined &&
      (!isSequence(verification.retentionThrough) ||
        verification.retentionThrough < 1 ||
        verification.retentionThrough >= verification.anchoredThrough)) ||
    (verification.enrollmentSequence !== undefined &&
      (!isSequence(verification.enrollmentSequence) ||
        verification.enrollmentSequence > verification.anchoredThrough)) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > options.limit ||
    typeof raw.hasMore !== "boolean"
  ) {
    throw new Error("Audit history cannot be verified");
  }
  if (
    verification.status === "verified" &&
    verification.anchoredThrough !== verification.sequence
  ) {
    throw new Error("Audit status disagrees with anchored prefix");
  }
  let previous = Math.max(
    options.afterSequence,
    verification.retentionThrough ?? 0,
  );
  for (const entry of raw.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      entry.sequence !== previous + 1 ||
      entry.sequence > verification.sequence ||
      !HASH.test(entry.previousHash) ||
      !HASH.test(entry.hash) ||
      !Number.isSafeInteger(entry.version) ||
      !entry.payload ||
      typeof entry.payload !== "object" ||
      Array.isArray(entry.payload) ||
      typeof entry.createdAt !== "string" ||
      entry.anchorStatus !==
        (entry.sequence <= verification.anchoredThrough
          ? "anchored"
          : "pending_anchor")
    ) {
      throw new Error("Audit entry is malformed");
    }
    previous = entry.sequence;
  }
  if (
    raw.hasMore &&
    (raw.entries.length === 0 || previous >= verification.sequence)
  ) {
    throw new Error("Audit page is incomplete");
  }
  if (
    !raw.hasMore &&
    previous <= verification.sequence &&
    previous !== verification.sequence
  ) {
    throw new Error("Audit page does not reach the verified head");
  }
  return {
    verification,
    entries: raw.entries,
    hasMore: raw.hasMore,
  };
}

function buildExport(snapshot) {
  if (
    snapshot.hasMore ||
    snapshot.entries.length !==
      snapshot.verification.sequence -
        (snapshot.verification.retentionThrough ?? 0)
  ) {
    throw new Error("Audit history exceeds the 500 entry export limit");
  }
  const data = JSON.stringify(
    {
      format: "vision-audit-view-v1",
      exportedAt: new Date().toISOString(),
      warning:
        (snapshot.verification.retentionThrough
          ? `Entries through sequence ${snapshot.verification.retentionThrough} were pruned under the one-year retention policy. `
          : "") +
        (snapshot.verification.enrollmentSequence === undefined
          ? "This export is a snapshot verified against this installation's local receipt and Keychain checkpoint. It is not a signed report or remote attestation."
          : "This export is checked against this installation's receipt and Keychain checkpoint. Entries through the enrollment baseline were accepted at enrollment; their earlier authenticity cannot be proven. This is not a signed report or remote attestation."),
      verification: snapshot.verification,
      entries: snapshot.entries,
    },
    null,
    2,
  );
  if (Buffer.byteLength(data, "utf8") > MAX_EXPORT_BYTES) {
    throw new Error("Audit export exceeds the 2 MB limit");
  }
  return data + "\n";
}

module.exports = {
  MAX_PAGE_SIZE,
  validateReadOptions,
  validateSnapshot,
  buildExport,
};
