/**
 * Text functions with PostgreSQL semantics for Vision's C-locale database
 * (ADR-263): LIKE/ILIKE, POSIX-style regular expressions, pg_trgm
 * similarity, C-collation ordering and jsonb containment.
 *
 * Vision's PostgreSQL cluster was created with `--locale=C`, so case folding
 * and "is this a letter" tests were ASCII-only: `'É' ILIKE 'é'` was false and
 * pg_trgm treated an accented letter as a word separator. These functions
 * keep that behaviour so matches and scores do not change.
 */
import { jsonbContains, parseJsonb } from "./jsonb.ts";

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function textError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Characters that need a backslash to be literal in a `u`-flag RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * PostgreSQL's like_escape(): rewrite a pattern written with a custom
 * escape character (none when empty) into one that escapes with `\`.
 */
function likeEscape(pattern: string, escape: string): string {
  if (escape === "\\") return pattern;
  const esc = Array.from(escape);
  if (esc.length > 1) throw textError("invalid escape string", "22025");
  let out = "";
  if (esc.length === 0) {
    for (const c of pattern) out += c === "\\" ? "\\\\" : c;
    return out;
  }
  let afterEscape = false;
  for (const c of pattern) {
    if (c === esc[0] && !afterEscape) {
      out += "\\";
      afterEscape = true;
    } else if (c === "\\") {
      out += afterEscape ? "\\" : "\\\\";
      afterEscape = false;
    } else {
      out += c;
      afterEscape = false;
    }
  }
  return out;
}

const LIKE_TRUE = 1;
const LIKE_FALSE = 0;
const LIKE_ABORT = -1;

function endsWithEscape(): Error {
  return textError("LIKE pattern must not end with escape character", "22025");
}

/**
 * PostgreSQL's MatchText() (like_match.c) over code points: `%` any run,
 * `_` one character, `\` makes the next character literal. Like
 * PostgreSQL it reports a trailing escape only when matching reaches it.
 */
function matchText(t: readonly string[], ti: number, p: readonly string[], pi: number): number {
  if (p.length - pi === 1 && p[pi] === "%") return LIKE_TRUE;
  while (ti < t.length && pi < p.length) {
    const pc = p[pi];
    if (pc === "\\") {
      pi++;
      if (pi >= p.length) throw endsWithEscape();
      if (p[pi] !== t[ti]) return LIKE_FALSE;
    } else if (pc === "%") {
      pi++;
      while (pi < p.length) {
        if (p[pi] === "%") pi++;
        else if (p[pi] === "_") {
          if (ti >= t.length) return LIKE_ABORT;
          ti++;
          pi++;
        } else break;
      }
      if (pi >= p.length) return LIKE_TRUE;
      let first: string | undefined;
      if (p[pi] === "\\") {
        if (p.length - pi < 2) throw endsWithEscape();
        first = p[pi + 1];
      } else {
        first = p[pi];
      }
      while (ti < t.length) {
        if (t[ti] === first) {
          const matched = matchText(t, ti, p, pi);
          if (matched !== LIKE_FALSE) return matched;
        }
        ti++;
      }
      return LIKE_ABORT;
    } else if (pc === "_") {
      ti++;
      pi++;
      continue;
    } else if (pc !== t[ti]) {
      return LIKE_FALSE;
    }
    ti++;
    pi++;
  }
  if (ti < t.length) return LIKE_FALSE;
  while (pi < p.length && p[pi] === "%") pi++;
  return pi >= p.length ? LIKE_TRUE : LIKE_ABORT;
}

/** PostgreSQL `value LIKE pattern [ESCAPE escape]` (case-sensitive). */
export function like(value: string, pattern: string, escape = "\\"): boolean {
  const p = Array.from(likeEscape(pattern, escape));
  return matchText(Array.from(value), 0, p, 0) === LIKE_TRUE;
}

/**
 * PostgreSQL `value ILIKE pattern [ESCAPE escape]` in the C locale: the
 * escape is resolved first, then pattern and value are folded with ASCII
 * lower() and matched.
 */
export function ilike(value: string, pattern: string, escape = "\\"): boolean {
  const p = Array.from(asciiLower(likeEscape(pattern, escape)));
  return matchText(Array.from(asciiLower(value)), 0, p, 0) === LIKE_TRUE;
}

// ---------------------------------------------------------------------------
// POSIX regular expressions (PostgreSQL ARE, C locale)
// ---------------------------------------------------------------------------

/** Bracket-expression bodies of the POSIX classes in the C locale. */
const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  word: "A-Za-z0-9_",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\v\\f\\r",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: " -~",
  graph: "!-~",
};

const SPACE = " \\t\\n\\v\\f\\r";

function regexError(pattern: string, detail: string): Error {
  return textError(`invalid regular expression: ${detail} in "${pattern}"`, "2201B");
}

function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function otherCase(c: string): string {
  return c >= "a" && c <= "z" ? c.toUpperCase() : c.toLowerCase();
}

/** A literal character inside a JavaScript `u`-flag character class. */
function classLiteral(c: string): string {
  return /[\\\][^-]/.test(c) ? `\\${c}` : c;
}

/** The JavaScript form of an ARE escape `\x` outside or inside brackets. */
function escapeToJs(
  pattern: string,
  chars: string[],
  i: number,
  inBracket: boolean,
): { js: string; next: number; literal?: string } {
  const e = chars[i + 1];
  if (e === undefined) throw regexError(pattern, "trailing backslash");
  const literal = (ch: string) => ({ js: inBracket ? classLiteral(ch) : escapeRegExp(ch), next: i + 2, literal: ch });
  switch (e) {
    case "d":
      return { js: inBracket ? "0-9" : "[0-9]", next: i + 2 };
    case "w":
      return { js: inBracket ? "A-Za-z0-9_" : "[A-Za-z0-9_]", next: i + 2 };
    case "s":
      return { js: inBracket ? SPACE : `[${SPACE}]`, next: i + 2 };
    case "D":
    case "W":
    case "S": {
      if (inBracket) throw regexError(pattern, `\\${e} inside a bracket expression`);
      const body = e === "D" ? "0-9" : e === "W" ? "A-Za-z0-9_" : SPACE;
      return { js: `[^${body}]`, next: i + 2 };
    }
    case "n":
      return literal("\n");
    case "t":
      return literal("\t");
    case "r":
      return literal("\r");
    case "f":
      return literal("\f");
    case "v":
      return literal("\v");
    case "a":
      return literal("\x07");
    case "b":
      return literal("\b");
    case "e":
      return literal("\x1b");
    case "x":
    case "u":
    case "U": {
      const max = e === "u" ? 4 : e === "U" ? 8 : 8;
      let j = i + 2;
      let hex = "";
      while (hex.length < max && j < chars.length && /^[0-9A-Fa-f]$/.test(chars[j] ?? "")) {
        hex += chars[j];
        j++;
      }
      if (hex.length === 0 || (e === "u" && hex.length !== 4) || (e === "U" && hex.length !== 8)) {
        throw regexError(pattern, `invalid \\${e} escape`);
      }
      const ch = String.fromCodePoint(Number.parseInt(hex, 16));
      return { js: inBracket ? classLiteral(ch) : escapeRegExp(ch), next: j, literal: ch };
    }
    default:
      break;
  }
  if (!inBracket) {
    switch (e) {
      case "y":
        return { js: "\\b", next: i + 2 };
      case "Y":
        return { js: "\\B", next: i + 2 };
      case "m":
        return { js: "\\b(?=[A-Za-z0-9_])", next: i + 2 };
      case "M":
        return { js: "\\b(?<=[A-Za-z0-9_])", next: i + 2 };
      case "A":
        return { js: "^", next: i + 2 };
      case "Z":
        return { js: "$", next: i + 2 };
      default:
        break;
    }
    if (e >= "1" && e <= "9") {
      let j = i + 1;
      let digits = "";
      while (j < chars.length && /^[0-9]$/.test(chars[j] ?? "")) {
        digits += chars[j];
        j++;
      }
      return { js: `\\${digits}`, next: j };
    }
  }
  if (/^[A-Za-z0-9]$/.test(e)) throw regexError(pattern, `invalid escape \\${e}`);
  return literal(e);
}

/**
 * Translate a PostgreSQL ARE into a JavaScript RegExp source (flags `su`):
 * POSIX classes and `\d \s \w` become ASCII classes, `.` matches a newline,
 * `\y \Y \m \M \A \Z` map to boundaries, and case-insensitive matching
 * folds ASCII letters only (each letter becomes `[xX]`) instead of using the
 * `i` flag, which would also fold `é` and `É`.
 */
function translateRegex(pattern: string, insensitive: boolean): string {
  const chars = Array.from(pattern);
  let ci = insensitive;
  let i = 0;
  // Embedded options at the start, e.g. `(?i)`.
  if (chars[0] === "(" && chars[1] === "?") {
    let j = 2;
    let flags = "";
    while (j < chars.length && /^[a-z]$/.test(chars[j] ?? "")) {
      flags += chars[j];
      j++;
    }
    if (chars[j] === ")" && flags.length > 0) {
      for (const f of flags) {
        if (f === "i") ci = true;
        else if (f === "c") ci = false;
        else throw regexError(pattern, `unsupported embedded option ${f}`);
      }
      i = j + 1;
    }
  }
  let out = "";
  while (i < chars.length) {
    const c = chars[i] ?? "";
    if (c === "\\") {
      const t = escapeToJs(pattern, chars, i, false);
      out += t.literal !== undefined && ci && isAsciiLetter(t.literal) ? `[${t.literal}${otherCase(t.literal)}]` : t.js;
      i = t.next;
    } else if (c === "[") {
      const t = translateBracket(pattern, chars, i, ci);
      out += t.js;
      i = t.next;
    } else if (ci && isAsciiLetter(c)) {
      out += `[${c}${otherCase(c)}]`;
      i++;
    } else if (c === "{") {
      // A bound such as {2,4} is copied; any other brace is literal.
      const end = chars.indexOf("}", i);
      const bound = end < 0 ? "" : chars.slice(i, end + 1).join("");
      if (/^\{\d+(,\d*)?\}$/.test(bound)) {
        out += bound;
        i = end + 1;
      } else {
        out += "\\{";
        i++;
      }
    } else if (c === "}" || c === "]") {
      out += `\\${c}`;
      i++;
    } else if (c === "(" && chars[i + 1] === "?") {
      // Non-capturing group and lookaround keep their JavaScript spelling.
      const kind = chars[i + 2] === "<" ? `<${chars[i + 3] ?? ""}` : (chars[i + 2] ?? "");
      if (kind !== ":" && kind !== "=" && kind !== "!" && kind !== "<=" && kind !== "<!") {
        throw regexError(pattern, "unsupported (? group");
      }
      out += `(?${kind}`;
      i += 2 + kind.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function translateBracket(pattern: string, chars: string[], start: number, ci: boolean): { js: string; next: number } {
  let i = start + 1;
  let negate = false;
  if (chars[i] === "^") {
    negate = true;
    i++;
  }
  const items: string[] = [];
  const letters = new Set<string>();
  let first = true;
  const addLetterCases = (lo: string, hi: string) => {
    if (!ci) return;
    for (let code = lo.codePointAt(0) ?? 0; code <= (hi.codePointAt(0) ?? -1) && code < 128; code++) {
      const ch = String.fromCharCode(code);
      if (isAsciiLetter(ch)) letters.add(otherCase(ch));
    }
  };
  /** One bracket element: a literal character, or null for a class expansion. */
  const readElement = (): string | null => {
    const c = chars[i];
    if (c === undefined) throw regexError(pattern, "unterminated bracket expression");
    if (c === "[" && chars[i + 1] === ":") {
      const end = chars.indexOf(":", i + 2);
      if (end < 0 || chars[end + 1] !== "]") throw regexError(pattern, "invalid character class");
      let name = chars.slice(i + 2, end).join("");
      if (ci && (name === "upper" || name === "lower")) name = "alpha";
      const body = POSIX_CLASSES[name];
      if (body === undefined) throw regexError(pattern, `invalid character class ${name}`);
      items.push(body);
      i = end + 2;
      return null;
    }
    if (c === "[" && (chars[i + 1] === "." || chars[i + 1] === "=")) {
      const mark = chars[i + 1] ?? "";
      const end = chars.indexOf(mark, i + 2);
      if (end < 0 || chars[end + 1] !== "]" || end !== i + 3) throw regexError(pattern, "unsupported collating element");
      i = end + 2;
      return chars[i - 3] ?? "";
    }
    if (c === "\\") {
      const t = escapeToJs(pattern, chars, i, true);
      i = t.next;
      if (t.literal !== undefined) return t.literal;
      items.push(t.js);
      return null;
    }
    i++;
    return c;
  };
  for (;;) {
    const c = chars[i];
    if (c === undefined) throw regexError(pattern, "unterminated bracket expression");
    if (c === "]" && !first) {
      i++;
      break;
    }
    first = false;
    const lo = readElement();
    if (lo === null) continue;
    if (chars[i] === "-" && chars[i + 1] !== undefined && chars[i + 1] !== "]") {
      i++;
      const hi = readElement();
      if (hi === null) throw regexError(pattern, "invalid range end");
      if ((lo.codePointAt(0) ?? 0) > (hi.codePointAt(0) ?? 0)) throw regexError(pattern, "invalid character range");
      items.push(`${classLiteral(lo)}-${classLiteral(hi)}`);
      addLetterCases(lo, hi);
    } else {
      items.push(classLiteral(lo));
      addLetterCases(lo, lo);
    }
  }
  for (const l of letters) items.push(l);
  return { js: `[${negate ? "^" : ""}${items.join("")}]`, next: i };
}

const regexCache = new Map<string, RegExp>();

/**
 * PostgreSQL `value ~ pattern`, or `~*` with flags `"i"`, in the C locale.
 * An invalid pattern raises SQLSTATE 2201B.
 */
export function regexpMatch(pattern: string, value: string, flags = ""): boolean {
  const insensitive = flags.includes("i");
  const key = `${insensitive ? "i" : "s"}:${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    const source = translateRegex(pattern, insensitive);
    try {
      re = new RegExp(source, "su");
    } catch (err) {
      throw regexError(pattern, err instanceof Error ? err.message : String(err));
    }
    if (regexCache.size > 2000) regexCache.clear();
    regexCache.set(key, re);
  }
  return re.test(value);
}

// ---------------------------------------------------------------------------
// C-collation ordering
// ---------------------------------------------------------------------------

/**
 * Compare two strings by Unicode code point, which is UTF-8 byte order and
 * so PostgreSQL's C collation (and SQLite's BINARY). JavaScript's `<`
 * compares UTF-16 code units, which sorts U+E000-U+FFFF after astral
 * characters.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// pg_trgm
// ---------------------------------------------------------------------------

/** pg_trgm's ISWORDCHR under the C locale: an ASCII letter or digit. */
function isWordChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return (
    c.length === 1 &&
    ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))
  );
}

/** pg_trgm's trigram set of a string (show_trgm without the formatting). */
export function trigrams(input: string): Set<string> {
  const out = new Set<string>();
  const lowered = asciiLower(input);
  const chars = Array.from(lowered);
  let word: string[] = [];
  const flush = () => {
    if (word.length === 0) return;
    const padded = [" ", " ", ...word, " "];
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.add(`${padded[i]}${padded[i + 1]}${padded[i + 2]}`);
    }
    word = [];
  };
  for (const c of chars) {
    if (isWordChar(c)) word.push(c);
    else flush();
  }
  flush();
  return out;
}

/** pg_trgm `show_trgm(s)`: the trigrams in PostgreSQL's byte order. */
export function showTrgm(input: string): string[] {
  return [...trigrams(input)].sort(compareCodePoints);
}

/** Shortest decimal text that reads back as the same float4 (PostgreSQL float4out). */
export function float4Value(x: number): number {
  const f = Math.fround(x);
  if (f === 0 || !Number.isFinite(f)) return f;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(f.toPrecision(digits));
    if (Math.fround(candidate) === f) return candidate;
  }
  return f;
}

/** pg_trgm `similarity(a, b)`: shared trigrams over the union, as a float4. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const union = ta.size + tb.size - common;
  return float4Value(common / union);
}

// ---------------------------------------------------------------------------
// jsonb containment
// ---------------------------------------------------------------------------

/** PostgreSQL `a @> b` on jsonb, from JSON text (numbers compared exactly). */
export function jsonContains(aText: string, bText: string): boolean {
  return jsonbContains(parseJsonb(aText), parseJsonb(bText));
}
