/**
 * PostgreSQL one-dimensional array literals, as `array_out` prints them
 * (ADR-263: `text[]` and `integer[]` become JSON array text in SQLite).
 *
 * array_out writes `{a,"b c",NULL,"x\"y"}`: elements separated by commas,
 * NULL unquoted, and an element quoted when it is empty, equals NULL in any
 * case, or contains `"`, `\`, `{`, `}`, `,` or white space; inside quotes `"`
 * and `\` are escaped with a backslash.
 *
 * The parser refuses what JSON cannot hold without loss (non-default lower
 * bounds such as `[0:1]={a,b}`, more than one dimension) and then proves it
 * lost nothing: printing the parsed elements with array_out's rules must give
 * back the input text exactly.
 */

import { at } from "./util.ts";

export class ArrayLiteralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArrayLiteralError";
  }
}

/** array_isspace(): the characters array_out quotes and array_in trims. */
function isArraySpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
}

/** pg_strcasecmp(x, "NULL") == 0: ASCII case folding only. */
const NULL_WORD = /^null$/i;

function needsQuotes(element: string): boolean {
  if (element === "" || NULL_WORD.test(element)) return true;
  for (const c of element) {
    if (c === '"' || c === "\\" || c === "{" || c === "}" || c === "," || isArraySpace(c)) return true;
  }
  return false;
}

/** Print a one-dimensional text array the way PostgreSQL's array_out does. */
export function formatPgTextArray(elements: ReadonlyArray<string | null>): string {
  const parts = elements.map((element) => {
    if (element === null) return "NULL";
    if (!needsQuotes(element)) return element;
    return `"${element.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  });
  return `{${parts.join(",")}}`;
}

/** Parse a one-dimensional array literal into its elements (text). */
export function parsePgTextArray(literal: string): Array<string | null> {
  if (literal.startsWith("[")) {
    throw new ArrayLiteralError("arrays with explicit bounds (e.g. [0:1]={...}) cannot be stored as JSON");
  }
  if (!literal.startsWith("{") || !literal.endsWith("}")) {
    throw new ArrayLiteralError("an array literal must start with { and end with }");
  }
  const body = literal.slice(1, -1);
  const elements: Array<string | null> = [];
  if (body.length === 0) return elements;
  let i = 0;
  for (;;) {
    if (i >= body.length) throw new ArrayLiteralError("empty array element");
    const c = at(body, i);
    if (c === "{" || c === "}") {
      throw new ArrayLiteralError("multi-dimensional arrays cannot be stored as a JSON list");
    }
    if (c === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= body.length) throw new ArrayLiteralError("unterminated quoted array element");
        const d = at(body, i);
        if (d === "\\") {
          if (i + 1 >= body.length) throw new ArrayLiteralError("dangling backslash in array element");
          value += at(body, i + 1);
          i += 2;
          continue;
        }
        if (d === '"') {
          i++;
          break;
        }
        value += d;
        i++;
      }
      elements.push(value);
    } else {
      let raw = "";
      while (i < body.length && body[i] !== ",") {
        const d = at(body, i);
        if (d === '"' || d === "{" || d === "}") throw new ArrayLiteralError(`unexpected ${d} in array element`);
        if (d === "\\") {
          if (i + 1 >= body.length) throw new ArrayLiteralError("dangling backslash in array element");
          raw += at(body, i + 1);
          i += 2;
          continue;
        }
        raw += d;
        i++;
      }
      elements.push(NULL_WORD.test(raw) ? null : raw);
    }
    if (i === body.length) break;
    if (body[i] !== ",") throw new ArrayLiteralError(`expected , after array element, found ${at(body, i)}`);
    i++;
  }
  if (formatPgTextArray(elements) !== literal) {
    throw new ArrayLiteralError("array literal is not in PostgreSQL's output form; refusing to guess");
  }
  return elements;
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * Parse an `integer[]`/`bigint[]`/`smallint[]` literal into JSON numbers.
 * Values beyond 2^53 would lose digits in JavaScript and are refused.
 */
export function parsePgIntegerArray(literal: string): Array<number | null> {
  return parsePgTextArray(literal).map((element) => {
    if (element === null) return null;
    if (!INTEGER.test(element)) throw new ArrayLiteralError(`array element ${element} is not an integer`);
    const value = Number(element);
    if (!Number.isSafeInteger(value)) {
      throw new ArrayLiteralError(`array element ${element} is outside the exact JSON number range`);
    }
    return value;
  });
}
