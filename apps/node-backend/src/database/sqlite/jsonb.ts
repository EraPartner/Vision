/**
 * PostgreSQL jsonb text semantics for SQLite (ADR-263).
 *
 * jsonb columns are stored as PostgreSQL's canonical jsonb output, so equal
 * documents are equal text. `JSON.parse` cannot produce that form: it turns
 * `1.50` into 1.5 and `12345678901234567890` into a rounded float. This
 * module parses JSON with its own tokenizer, keeps every number as an exact
 * decimal (numeric.ts) and prints the result as `jsonb_out` does:
 *
 *   - duplicate object keys keep the last value;
 *   - keys are ordered by UTF-8 byte length, then bytewise;
 *   - separators are `", "` and `": "`;
 *   - numbers print as PostgreSQL `numeric` (1.50 stays 1.50, 1e2 is 100,
 *     -0 is 0);
 *   - strings escape `"`, `\`, \b \f \n \r \t and other control characters
 *     as `\u00XX`; everything else, `/` included, is written as is.
 *
 * Invalid JSON raises SQLSTATE 22P02, a `\u0000` escape 22P05 and a number
 * outside the numeric range 22003, as PostgreSQL's jsonb input does.
 */
import { NumericError, cmp, formatDec, parseDecimalText } from "./numeric.ts";
import type { Dec } from "./numeric.ts";

export type JsonbValue =
  | { readonly type: "null" }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "number"; readonly value: Dec }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "array"; readonly items: readonly JsonbValue[] }
  /** Entries in canonical key order, duplicates removed. */
  | { readonly type: "object"; readonly entries: readonly (readonly [string, JsonbValue])[] };

export class JsonbError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "JsonbError";
    this.code = code;
  }
}

function invalid(detail: string): JsonbError {
  return new JsonbError(`invalid input syntax for type json: ${detail}`, "22P02");
}

const encoder = new TextEncoder();

/** jsonb key order: shorter UTF-8 first, then bytewise. */
export function compareJsonbKeys(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Nesting limit, so a hostile document cannot exhaust the stack. */
const MAX_DEPTH = 6400;

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): JsonbValue {
    this.skipSpace();
    const value = this.parseValue(0);
    this.skipSpace();
    if (this.pos < this.text.length) throw invalid(`unexpected text at offset ${this.pos}`);
    return value;
  }

  private skipSpace(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(depth: number): JsonbValue {
    if (depth > MAX_DEPTH) throw new JsonbError("jsonb nesting is too deep", "54001");
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return { type: "string", value: this.parseString() };
      case "t":
        return this.literal("true", { type: "bool", value: true });
      case "f":
        return this.literal("false", { type: "bool", value: false });
      case "n":
        return this.literal("null", { type: "null" });
      default:
        return this.parseNumber();
    }
  }

  private literal(word: string, value: JsonbValue): JsonbValue {
    if (!this.text.startsWith(word, this.pos)) throw invalid(`unexpected token at offset ${this.pos}`);
    this.pos += word.length;
    // A literal must not run into letters or digits ("truex", "nullnull").
    const next = this.text[this.pos];
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) throw invalid(`unexpected token at offset ${this.pos}`);
    return value;
  }

  private parseNumber(): JsonbValue {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.text);
    if (m === null || m[0].length === 0) throw invalid(`unexpected token at offset ${this.pos}`);
    this.pos += m[0].length;
    const next = this.text[this.pos];
    if (next !== undefined && /[A-Za-z0-9_.]/.test(next)) throw invalid(`unexpected token at offset ${this.pos}`);
    try {
      return { type: "number", value: parseDecimalText(m[0]) };
    } catch (err) {
      if (err instanceof NumericError) throw new JsonbError(err.message, err.code);
      throw err;
    }
  }

  private parseString(): string {
    const t = this.text;
    this.pos++; // opening quote
    let out = "";
    let runStart = this.pos;
    for (;;) {
      if (this.pos >= t.length) throw invalid("unterminated string");
      const c = t.charCodeAt(this.pos);
      if (c === 0x22) {
        out += t.slice(runStart, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) throw invalid("control character in string");
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += t.slice(runStart, this.pos);
      const e = t[this.pos + 1];
      this.pos += 2;
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const code = this.hex4();
          if (code === 0) throw new JsonbError("unsupported Unicode escape sequence", "22P05");
          if (code >= 0xd800 && code <= 0xdbff) {
            if (t[this.pos] !== "\\" || t[this.pos + 1] !== "u") {
              throw invalid("Unicode high surrogate must not follow a high surrogate");
            }
            this.pos += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) throw invalid("Unicode low surrogate must follow a high surrogate");
            out += String.fromCharCode(code, low);
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw invalid("Unicode low surrogate must follow a high surrogate");
          } else {
            out += String.fromCharCode(code);
          }
          break;
        }
        default:
          throw invalid("invalid escape sequence");
      }
      runStart = this.pos;
    }
  }

  private hex4(): number {
    const digits = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) throw invalid('"\\u" must be followed by four hexadecimal digits');
    this.pos += 4;
    return Number.parseInt(digits, 16);
  }

  private parseArray(depth: number): JsonbValue {
    this.pos++;
    const items: JsonbValue[] = [];
    this.skipSpace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return { type: "array", items };
    }
    for (;;) {
      this.skipSpace();
      items.push(this.parseValue(depth + 1));
      this.skipSpace();
      const c = this.text[this.pos];
      this.pos++;
      if (c === "]") return { type: "array", items };
      if (c !== ",") throw invalid(`expected "," or "]" at offset ${this.pos - 1}`);
    }
  }

  private parseObject(depth: number): JsonbValue {
    this.pos++;
    const map = new Map<string, JsonbValue>();
    this.skipSpace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return { type: "object", entries: [] };
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.pos] !== '"') throw invalid(`expected string at offset ${this.pos}`);
      const key = this.parseString();
      this.skipSpace();
      if (this.text[this.pos] !== ":") throw invalid(`expected ":" at offset ${this.pos}`);
      this.pos++;
      this.skipSpace();
      const value = this.parseValue(depth + 1);
      // The last duplicate wins, as in jsonb.
      map.delete(key);
      map.set(key, value);
      this.skipSpace();
      const c = this.text[this.pos];
      this.pos++;
      if (c === "}") break;
      if (c !== ",") throw invalid(`expected "," or "}" at offset ${this.pos - 1}`);
    }
    const entries = [...map.entries()].sort((a, b) => compareJsonbKeys(a[0], b[0]));
    return { type: "object", entries };
  }
}

/** Parse JSON text into a jsonb value with exact numbers and canonical key order. */
export function parseJsonb(text: string): JsonbValue {
  return new Parser(text).parseDocument();
}

/** PostgreSQL's escape_json(). */
export function quoteJsonbString(s: string): string {
  let out = '"';
  let runStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c !== 0x22 && c !== 0x5c) continue;
    out += s.slice(runStart, i);
    runStart = i + 1;
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      default:
        out += `\\u${c.toString(16).padStart(4, "0")}`;
    }
  }
  return `${out}${s.slice(runStart)}"`;
}

/** jsonb_out(): the canonical text of a jsonb value. */
export function formatJsonb(value: JsonbValue): string {
  switch (value.type) {
    case "null":
      return "null";
    case "bool":
      return value.value ? "true" : "false";
    case "number":
      return formatDec(value.value);
    case "string":
      return quoteJsonbString(value.value);
    case "array":
      return `[${value.items.map(formatJsonb).join(", ")}]`;
    case "object":
      return `{${value.entries.map(([k, v]) => `${quoteJsonbString(k)}: ${formatJsonb(v)}`).join(", ")}}`;
  }
}

/** PostgreSQL `x::jsonb::text`; invalid JSON throws a JsonbError (22P02). */
export function canonicalJsonbText(text: string): string {
  return formatJsonb(parseJsonb(text));
}

/** True when `text` is already PostgreSQL's canonical jsonb text. */
export function isCanonicalJsonbText(text: string): boolean {
  try {
    return canonicalJsonbText(text) === text;
  } catch {
    return false;
  }
}

function scalarEqual(a: JsonbValue, b: JsonbValue): boolean {
  switch (a.type) {
    case "null":
      return b.type === "null";
    case "bool":
      return b.type === "bool" && a.value === b.value;
    case "number":
      return b.type === "number" && cmp(a.value, b.value) === 0;
    case "string":
      return b.type === "string" && a.value === b.value;
    default:
      return false;
  }
}

function isContainer(v: JsonbValue): v is Extract<JsonbValue, { type: "array" | "object" }> {
  return v.type === "array" || v.type === "object";
}

/** PostgreSQL's JsonbDeepContains() below the top level. */
function deepContains(a: JsonbValue, b: JsonbValue): boolean {
  if (a.type === "object") {
    if (b.type !== "object") return false;
    for (const [key, want] of b.entries) {
      const have = a.entries.find(([k]) => k === key)?.[1];
      if (have === undefined) return false;
      if (isContainer(want)) {
        if (have.type !== want.type || !deepContains(have, want)) return false;
      } else if (!scalarEqual(have, want)) {
        return false;
      }
    }
    return true;
  }
  if (a.type === "array") {
    if (b.type !== "array") return false;
    return b.items.every((want) =>
      isContainer(want)
        ? a.items.some((have) => have.type === want.type && deepContains(have, want))
        : a.items.some((have) => !isContainer(have) && scalarEqual(have, want)),
    );
  }
  return !isContainer(b) && scalarEqual(a, b);
}

/**
 * PostgreSQL `a @> b` on jsonb. At the top level an array also contains a
 * bare scalar it holds (`'[1,2]' @> '1'`), while a scalar never contains an
 * array.
 */
export function jsonbContains(a: JsonbValue, b: JsonbValue): boolean {
  if (a.type === "array" && !isContainer(b)) {
    return a.items.some((have) => !isContainer(have) && scalarEqual(have, b));
  }
  return deepContains(a, b);
}
