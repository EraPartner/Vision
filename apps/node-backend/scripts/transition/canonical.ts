/**
 * Canonical row serialization for the table checksums.
 *
 * A row is the list of its stored values in column-name order, each one
 *   null                  SQL NULL
 *   "i:<decimal>"         INTEGER storage (exact, any 64-bit value)
 *   "r:<16 hex digits>"   REAL storage, the IEEE-754 binary64 bits, big-endian
 *   "t:<text>"            TEXT storage
 * The row digest is SHA-256 of JSON.stringify(list) as UTF-8; the table
 * checksum is SHA-256 of the row digests concatenated in primary-key order
 * (SQLite's order: integers numerically, text by UTF-8 bytes). A table
 * without a primary key orders its row digests bytewise instead.
 */
import { createHash } from "node:crypto";
import type { SqliteValue } from "./typeMapping.ts";

export type CanonicalValue = string | null;

const floatBuffer = Buffer.alloc(8);

export function canonicalValue(value: SqliteValue): CanonicalValue {
  if (value === null) return null;
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (typeof value === "number") {
    floatBuffer.writeDoubleBE(value);
    return `r:${floatBuffer.toString("hex")}`;
  }
  return `t:${value}`;
}

export function rowDigest(values: readonly CanonicalValue[]): Buffer {
  return createHash("sha256").update(JSON.stringify(values), "utf8").digest();
}

/** Compare strings by UTF-8 bytes (SQLite BINARY collation) without encoding them. */
export function compareUtf8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // UTF-16 puts surrogates (astral code points) below U+E000-U+FFFF; UTF-8 above.
    x = x >= 0xd800 && x < 0xe000 ? x + 0x2000 : x >= 0xe000 ? x - 0x800 : x;
    y = y >= 0xd800 && y < 0xe000 ? y + 0x2000 : y >= 0xe000 ? y - 0x800 : y;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function storageClass(value: SqliteValue): number {
  if (value === null) return 0;
  if (typeof value === "bigint" || typeof value === "number") return 1;
  return 2;
}

/** SQLite's ORDER BY for one value: NULL < numbers < text (BINARY). */
export function compareSqliteValues(a: SqliteValue, b: SqliteValue): number {
  const ca = storageClass(a);
  const cb = storageClass(b);
  if (ca !== cb) return ca - cb;
  if (a === null || b === null) return 0;
  if (typeof a === "string" && typeof b === "string") return compareUtf8(a, b);
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  // Mixed integer/real keys never occur in Vision's keys; compare exactly anyway.
  const x = typeof a === "bigint" ? Number(a) : (a as number);
  const y = typeof b === "bigint" ? Number(b) : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function compareKeys(a: readonly SqliteValue[], b: readonly SqliteValue[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const c = compareSqliteValues(a[i] ?? null, b[i] ?? null);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

const DIGEST_BYTES = 32;

/**
 * Row digests of one table, kept compactly (one buffer for all digests, the
 * keys beside it) and ordered only when the checksum is taken.
 */
export class DigestCollector {
  private digests: Buffer;
  private readonly keys: Array<SqliteValue | SqliteValue[]> = [];
  private count = 0;
  private readonly keyWidth: number;

  constructor(capacity: number, keyWidth: number) {
    this.digests = Buffer.alloc(Math.max(1, capacity) * DIGEST_BYTES);
    this.keyWidth = keyWidth;
  }

  add(key: readonly SqliteValue[], digest: Buffer): void {
    if ((this.count + 1) * DIGEST_BYTES > this.digests.length) {
      const bigger = Buffer.alloc(this.digests.length * 2);
      this.digests.copy(bigger);
      this.digests = bigger;
    }
    digest.copy(this.digests, this.count * DIGEST_BYTES);
    if (this.keyWidth === 1) this.keys.push(key[0] ?? null);
    else if (this.keyWidth > 1) this.keys.push([...key]);
    this.count++;
  }

  private digestAt(i: number): Buffer {
    return this.digests.subarray(i * DIGEST_BYTES, (i + 1) * DIGEST_BYTES);
  }

  private singleKey(i: number): SqliteValue {
    const key = this.keys[i] ?? null;
    return Array.isArray(key) ? (key[0] ?? null) : key;
  }

  private keyAt(i: number): SqliteValue[] {
    const key = this.keys[i] ?? null;
    return Array.isArray(key) ? key : [key];
  }

  /** SHA-256 over the digests in key order (bytewise digest order without a key). */
  checksum(): string {
    const order = Array.from({ length: this.count }, (_, i) => i);
    if (this.keyWidth === 1) {
      order.sort((a, b) => compareSqliteValues(this.singleKey(a), this.singleKey(b)));
    } else if (this.keyWidth > 1) {
      order.sort((a, b) => compareKeys(this.keyAt(a), this.keyAt(b)));
    } else {
      order.sort((a, b) => Buffer.compare(this.digestAt(a), this.digestAt(b)));
    }
    const hash = createHash("sha256");
    for (const i of order) hash.update(this.digestAt(i));
    return hash.digest("hex");
  }
}

/** `col=value` pairs of a primary key, for messages. */
export function describeKey(columns: readonly string[], key: readonly SqliteValue[]): string {
  if (columns.length === 0) return "(table has no primary key)";
  return columns
    .map((c, i) => {
      const v = key[i] ?? null;
      return `${c}=${v === null ? "NULL" : typeof v === "string" ? JSON.stringify(v) : String(v)}`;
    })
    .join(", ");
}
