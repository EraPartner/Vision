/**
 * PostgreSQL COPY text format, as pg_dump writes table data (ADR-263).
 *
 * A row is one line; fields are separated by a tab. A field that is exactly
 * `\N` (before de-escaping) is NULL. Backslash sequences decode exactly as
 * PostgreSQL's CopyReadAttributesText does:
 *
 *   \b \f \n \r \t \v  the control character
 *   \ooo               1-3 octal digits: one byte (value & 0xff)
 *   \xh, \xhh          1-2 hex digits: one byte
 *   \<anything else>   that character itself (\\ is a backslash)
 *
 * Octal and hex escapes produce bytes, so the field is decoded to bytes first
 * and then read as UTF-8 (the dump's client_encoding); an invalid byte
 * sequence or a NUL byte is refused, as PostgreSQL refuses it. Characters
 * below 0x20 other than the six above are written raw by COPY TO and are
 * kept as they are.
 *
 * A backslash also escapes the line end: `\` followed by a newline is a
 * literal newline inside the field (PostgreSQL's CopyReadLineText skips the
 * character after a backslash). pg_dump never writes that form, but the
 * line reader joins such lines so the decoding stays exact.
 */
import { TransitionError } from "./errors.ts";

const TAB = 0x09;
const BACKSLASH = 0x5c;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isOctal(b: number | undefined): b is number {
  return b !== undefined && b >= 0x30 && b <= 0x37;
}

function hexValue(b: number | undefined): number {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

const SIMPLE_ESCAPES: Record<number, number> = {
  0x62: 0x08, // \b
  0x66: 0x0c, // \f
  0x6e: 0x0a, // \n
  0x72: 0x0d, // \r
  0x74: 0x09, // \t
  0x76: 0x0b, // \v
};

/** Thrown for a field PostgreSQL itself would not accept. */
export class CopyDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyDecodeError";
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new CopyDecodeError("invalid byte sequence for encoding \"UTF8\": 0x00");
  try {
    return utf8.decode(bytes);
  } catch {
    throw new CopyDecodeError("invalid byte sequence for encoding \"UTF8\"");
  }
}

/**
 * Decode one raw field (the bytes between tabs, escapes intact). Returns
 * null for `\N`.
 */
export function decodeCopyField(raw: Uint8Array): string | null {
  if (raw.length === 2 && raw[0] === BACKSLASH && raw[1] === 0x4e) return null;
  if (!raw.includes(BACKSLASH)) return decodeUtf8(raw);
  const out = new Uint8Array(raw.length);
  let o = 0;
  let i = 0;
  while (i < raw.length) {
    const b = raw[i] ?? 0;
    if (b !== BACKSLASH) {
      out[o++] = b;
      i++;
      continue;
    }
    i++;
    if (i >= raw.length) {
      // A trailing backslash: PostgreSQL stops the field there.
      break;
    }
    const c = raw[i] ?? 0;
    i++;
    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) {
      out[o++] = simple;
    } else if (isOctal(c)) {
      let value = c - 0x30;
      if (isOctal(raw[i])) {
        value = (value << 3) + ((raw[i] ?? 0x30) - 0x30);
        i++;
        if (isOctal(raw[i])) {
          value = (value << 3) + ((raw[i] ?? 0x30) - 0x30);
          i++;
        }
      }
      out[o++] = value & 0xff;
    } else if (c === 0x78 /* x */ && hexValue(raw[i]) >= 0) {
      let value = hexValue(raw[i]);
      i++;
      const second = hexValue(raw[i]);
      if (second >= 0) {
        value = (value << 4) + second;
        i++;
      }
      out[o++] = value & 0xff;
    } else if (c === 0x2e /* . */) {
      throw new CopyDecodeError("end-of-copy marker \\. inside a row");
    } else {
      out[o++] = c;
    }
  }
  return decodeUtf8(out.subarray(0, o));
}

/**
 * Split one COPY line into raw fields at unescaped tabs. The line excludes
 * its terminating newline.
 */
export function splitCopyLine(line: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  let i = 0;
  // Fast path: no backslash means every tab is a separator.
  if (!line.includes(BACKSLASH)) {
    for (;;) {
      const tab = line.indexOf(TAB, start);
      if (tab < 0) break;
      fields.push(line.subarray(start, tab));
      start = tab + 1;
    }
    fields.push(line.subarray(start));
    return fields;
  }
  while (i < line.length) {
    const b = line[i] ?? 0;
    if (b === BACKSLASH) {
      i += 2;
      continue;
    }
    if (b === TAB) {
      fields.push(line.subarray(start, i));
      start = i + 1;
    }
    i++;
  }
  fields.push(line.subarray(start, Math.min(i, line.length)));
  return fields;
}

/** Decode a whole COPY line. */
export function decodeCopyLine(line: Uint8Array): Array<string | null> {
  return splitCopyLine(line).map(decodeCopyField);
}

/**
 * True when a raw line ends in an odd run of backslashes, i.e. its newline
 * was escaped and the row continues on the next line.
 */
export function endsWithEscapedNewline(line: Uint8Array): boolean {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === BACKSLASH; i--) n++;
  return n % 2 === 1;
}

// ---------------------------------------------------------------------------
// COPY statement header
// ---------------------------------------------------------------------------

export interface CopyHeader {
  schema: string;
  table: string;
  columns: string[];
}

/**
 * Parse an SQL identifier at `pos` (quoted or not). Unquoted identifiers are
 * folded to lower case, as PostgreSQL folds them.
 */
function readIdentifier(text: string, pos: number): { value: string; end: number } | null {
  if (text[pos] === '"') {
    let value = "";
    let i = pos + 1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q < 0) return null;
      value += text.slice(i, q);
      if (text[q + 1] === '"') {
        value += '"';
        i = q + 2;
        continue;
      }
      return { value, end: q + 1 };
    }
  }
  const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(text.slice(pos));
  if (!m) return null;
  return { value: m[0].toLowerCase(), end: pos + m[0].length };
}

/** Parse a possibly schema-qualified name. */
export function parseQualifiedName(text: string, pos = 0): { schema: string; name: string; end: number } | null {
  const first = readIdentifier(text, pos);
  if (!first) return null;
  if (text[first.end] === ".") {
    const second = readIdentifier(text, first.end + 1);
    if (!second) return null;
    return { schema: first.value, name: second.value, end: second.end };
  }
  return { schema: "public", name: first.value, end: first.end };
}

/** Parse `COPY schema.table (col, ...) FROM stdin;`. Returns null for other lines. */
export function parseCopyHeader(line: string): CopyHeader | null {
  if (!line.startsWith("COPY ")) return null;
  const name = parseQualifiedName(line, 5);
  if (!name) return null;
  let pos = name.end;
  const columns: string[] = [];
  if (line.startsWith(" (", pos)) {
    pos += 2;
    for (;;) {
      while (line[pos] === " ") pos++;
      const id = readIdentifier(line, pos);
      if (!id) return null;
      columns.push(id.value);
      pos = id.end;
      if (line[pos] === ",") {
        pos++;
        continue;
      }
      if (line[pos] === ")") {
        pos++;
        break;
      }
      return null;
    }
  }
  if (line.slice(pos) !== " FROM stdin;") return null;
  return { schema: name.schema, table: name.name, columns };
}

/** Throw a TransitionError for a COPY decoding failure. */
export function copyDecodeFailure(err: unknown, table: string, line: number): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new TransitionError(`db.sql could not be decoded: ${message}`, {
    location: { table, line },
    hint: "The backup's database dump is damaged. Make a new backup in Vision 2.0 and run the transition on it.",
    cause: err,
  });
}
