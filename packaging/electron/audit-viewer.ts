const HASH = /^[0-9a-f]{64}$/;
export const MAX_PAGE_SIZE = 500;
const MAX_EXPORT_BYTES = 2_000_000;

export interface AuditReadRange {
  afterSequence: number;
  limit: number;
}

export interface AuditVerification {
  status: "verified" | "partially_verified";
  sequence: number;
  hash: string;
  anchoredThrough: number;
  retentionThrough?: number;
  enrollmentSequence?: number;
  readonly [field: string]: unknown;
}

export interface AuditEntry {
  sequence: number;
  previousHash: string;
  hash: string;
  version: number;
  payload: Record<string, unknown>;
  createdAt: string;
  anchorStatus: "anchored" | "pending_anchor";
  readonly [field: string]: unknown;
}

export interface AuditSnapshot {
  verification: AuditVerification;
  entries: AuditEntry[];
  hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSequence(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function validateReadOptions(options: unknown = {}): AuditReadRange {
  if (
    !isRecord(options) ||
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
    !isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new Error("Invalid audit read range");
  }
  return { afterSequence, limit };
}

function isVerification(value: unknown): value is AuditVerification {
  return (
    isRecord(value) &&
    (value.status === "verified" || value.status === "partially_verified") &&
    isSequence(value.sequence) &&
    isHash(value.hash) &&
    isSequence(value.anchoredThrough) &&
    value.anchoredThrough <= value.sequence &&
    (value.retentionThrough === undefined ||
      (isSequence(value.retentionThrough) &&
        value.retentionThrough >= 1 &&
        value.retentionThrough < value.anchoredThrough)) &&
    (value.enrollmentSequence === undefined ||
      (isSequence(value.enrollmentSequence) &&
        value.enrollmentSequence <= value.anchoredThrough))
  );
}

function isEntry(
  entry: unknown,
  expectedSequence: number,
  verification: AuditVerification,
): entry is AuditEntry {
  return (
    isRecord(entry) &&
    entry.sequence === expectedSequence &&
    expectedSequence <= verification.sequence &&
    isHash(entry.previousHash) &&
    isHash(entry.hash) &&
    isSafeInteger(entry.version) &&
    isRecord(entry.payload) &&
    !Array.isArray(entry.payload) &&
    typeof entry.createdAt === "string" &&
    entry.anchorStatus ===
      (expectedSequence <= verification.anchoredThrough
        ? "anchored"
        : "pending_anchor")
  );
}

export function validateSnapshot(
  raw: unknown,
  options: AuditReadRange,
): AuditSnapshot {
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new Error("Audit snapshot is unavailable");
  }
  const { verification, entries: rawEntries, hasMore } = raw;
  if (
    !isVerification(verification) ||
    !Array.isArray(rawEntries) ||
    rawEntries.length > options.limit ||
    typeof hasMore !== "boolean"
  ) {
    throw new Error("Audit history cannot be verified");
  }
  if (
    verification.status === "verified" &&
    verification.anchoredThrough !== verification.sequence
  ) {
    throw new Error("Audit status disagrees with anchored prefix");
  }
  const candidates: readonly unknown[] = rawEntries;
  let previous = Math.max(
    options.afterSequence,
    verification.retentionThrough ?? 0,
  );
  const entries: AuditEntry[] = [];
  for (const entry of candidates) {
    if (!isEntry(entry, previous + 1, verification)) {
      throw new Error("Audit entry is malformed");
    }
    entries.push(entry);
    previous = entry.sequence;
  }
  if (hasMore && (entries.length === 0 || previous >= verification.sequence)) {
    throw new Error("Audit page is incomplete");
  }
  if (
    !hasMore &&
    previous <= verification.sequence &&
    previous !== verification.sequence
  ) {
    throw new Error("Audit page does not reach the verified head");
  }
  return {
    verification,
    entries,
    hasMore,
  };
}

export function buildExport(snapshot: AuditSnapshot): string {
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
