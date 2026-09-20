import { createHash } from "node:crypto";

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_SEGMENT_ENTRIES = 10_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Encode JSON data with sorted object keys. Numeric payloads are restricted to
 * safe integers: callers must use decimal strings for money and other precise
 * values. This avoids different representations of the same floating value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalAuditPayload(value) {
  const seen = new WeakSet();
  let nodes = 0;

  /** @param {unknown} item @param {number} depth */
  function encode(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new RangeError("Audit payload exceeds structural limits");
    }
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string"
    ) {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) {
        throw new TypeError(
          "Audit payload numbers must be safe integers; use strings for decimals",
        );
      }
      return String(item);
    }
    if (typeof item !== "object") {
      throw new TypeError("Audit payload must contain JSON values only");
    }
    if (seen.has(item)) throw new TypeError("Audit payload must be a tree");
    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError("Audit payload must contain plain objects only");
    }
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Audit payload must not contain symbol keys");
    }
    if (
      Array.isArray(item) &&
      (item.length > MAX_NODES ||
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9]\d*)$/.test(key) ||
              Number(key) >= item.length),
        ))
    ) {
      throw new TypeError(
        "Audit payload arrays must contain indexed JSON values only",
      );
    }
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        !Object.hasOwn(descriptor, "value") ||
        (key !== "length" && !descriptor.enumerable)
      ) {
        throw new TypeError(
          "Audit payload must contain enumerable data values only",
        );
      }
    }
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      result =
        "[" +
        Array.from({ length: item.length }, (_, index) => {
          if (!Object.hasOwn(item, index))
            throw new TypeError("Audit payload arrays must not be sparse");
          return encode(item[index], depth + 1);
        }).join(",") +
        "]";
    } else {
      result =
        "{" +
        Object.keys(item)
          .sort()
          .map((key) => {
            return JSON.stringify(key) + ":" + encode(item[key], depth + 1);
          })
          .join(",") +
        "}";
    }
    seen.delete(item);
    return result;
  }

  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError("Audit payload exceeds byte limit");
  }
  return encoded;
}

/**
 * @param {{sequence: number, previousHash: string, payload: unknown}} input
 */
function hashAuditEntry({ sequence, previousHash, payload }) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Audit sequence must be a positive safe integer");
  }
  if (typeof previousHash !== "string" || !HASH_PATTERN.test(previousHash)) {
    throw new TypeError("Previous audit hash must be lowercase SHA-256 hex");
  }
  const canonicalPayload = canonicalAuditPayload(payload);
  const encodedEntry = `["vision.audit.entry",${AUDIT_CHAIN_VERSION},${sequence},"${previousHash}",${canonicalPayload}]`;
  return createHash("sha256").update(encodedEntry, "utf8").digest("hex");
}

/**
 * The caller supplies a trusted previous hash. For a new chain, pass
 * AUDIT_CHAIN_GENESIS_HASH explicitly. For a retained segment, pass its
 * externally verified predecessor checkpoint.
 *
 * @param {{sequence: number, previousHash: string, payload: unknown}} input
 */
export function createAuditEntry({ sequence, previousHash, payload }) {
  return {
    version: AUDIT_CHAIN_VERSION,
    sequence,
    previousHash,
    payload,
    hash: hashAuditEntry({ sequence, previousHash, payload }),
  };
}

export { hashAuditEntry as __hashAuditEntry };

/**
 * Verify one bounded segment against a trusted predecessor. Supply the
 * expected final sequence and head hash from an independent checkpoint to
 * detect a removed suffix or a wholly rewritten database-local chain.
 * Database-local hashes alone provide no independent tamper evidence.
 *
 * @param {unknown[]} entries
 * @param {{firstSequence: number, previousHash: string, expectedLastSequence?: number, expectedHeadHash?: string}} checkpoint
 * @returns {{ok: true, lastSequence: number, headHash: string} | {ok: false, code: string, position: number}}
 */
export function verifyAuditChain(entries, checkpoint) {
  if (!Array.isArray(entries))
    throw new TypeError("Audit entries must be an array");
  if (entries.length > MAX_SEGMENT_ENTRIES)
    throw new RangeError("Audit segment exceeds entry limit");
  if (
    !checkpoint ||
    !Number.isSafeInteger(checkpoint.firstSequence) ||
    checkpoint.firstSequence < 1
  ) {
    throw new RangeError(
      "First audit sequence must be a positive safe integer",
    );
  }
  if (entries.length > Number.MAX_SAFE_INTEGER - checkpoint.firstSequence + 1) {
    throw new RangeError("Audit segment sequence exceeds safe integer range");
  }
  if (
    typeof checkpoint.previousHash !== "string" ||
    !HASH_PATTERN.test(checkpoint.previousHash)
  ) {
    throw new TypeError(
      "Checkpoint previous hash must be lowercase SHA-256 hex",
    );
  }
  if (
    checkpoint.expectedLastSequence !== undefined &&
    (!Number.isSafeInteger(checkpoint.expectedLastSequence) ||
      checkpoint.expectedLastSequence < checkpoint.firstSequence - 1)
  ) {
    throw new RangeError("Invalid expected last audit sequence");
  }
  if (
    checkpoint.expectedHeadHash !== undefined &&
    (typeof checkpoint.expectedHeadHash !== "string" ||
      !HASH_PATTERN.test(checkpoint.expectedHeadHash))
  ) {
    throw new TypeError("Expected audit head must be lowercase SHA-256 hex");
  }

  let previousHash = checkpoint.previousHash;
  let sequence = checkpoint.firstSequence;
  for (let position = 0; position < entries.length; position++) {
    const rawEntry = entries[position];
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return { ok: false, code: "invalid_entry", position };
    }
    const entry =
      /** @type {{version:number, sequence:number, previousHash:string, hash:string, payload:unknown}} */ (
        rawEntry
      );
    if (entry.version !== AUDIT_CHAIN_VERSION)
      return { ok: false, code: "version", position };
    if (entry.sequence !== sequence)
      return { ok: false, code: "sequence", position };
    if (entry.previousHash !== previousHash)
      return { ok: false, code: "previous_hash", position };
    if (typeof entry.hash !== "string" || !HASH_PATTERN.test(entry.hash)) {
      return { ok: false, code: "hash_format", position };
    }
    let calculated;
    try {
      calculated = hashAuditEntry(entry);
    } catch {
      return { ok: false, code: "invalid_payload", position };
    }
    if (entry.hash !== calculated) return { ok: false, code: "hash", position };
    previousHash = calculated;
    sequence++;
  }

  const lastSequence = sequence - 1;
  if (
    checkpoint.expectedLastSequence !== undefined &&
    checkpoint.expectedLastSequence !== lastSequence
  ) {
    return { ok: false, code: "length", position: entries.length };
  }
  if (
    checkpoint.expectedHeadHash !== undefined &&
    checkpoint.expectedHeadHash !== previousHash
  ) {
    return { ok: false, code: "head", position: entries.length };
  }
  return { ok: true, lastSequence, headHash: previousHash };
}
