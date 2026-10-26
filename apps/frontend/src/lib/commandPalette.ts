import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { parseLocaleNumber, type NumberFormat } from "@/utils/currency";

const FX_QUERY =
    /^([\d.,'’]+)\s*([a-zA-Z]{3})(?:\s+(?:in|to|naar)\s+([a-zA-Z]{3}))?$/;
const CALC_QUERY = /^[\d\s+\-*/().,'’]+$/;
const CASHTAG_QUERY = /^\$([A-Za-z][A-Za-z0-9.-]{0,9})$/;
const BARE_TICKER_QUERY = /^[A-Za-z]{2,5}(?:[.-][A-Za-z0-9]{1,4})?$/;
const RECENTS_KEY = LOCAL_STORAGE_KEYS.PALETTE_RECENTS;
const MAX_RECENTS = 5;

export interface ParsedFxQuery {
    amount: number;
    from: string;
    to?: string | undefined;
}

export function parseFxQuery(
    query: string,
    numberFormat: NumberFormat,
): ParsedFxQuery | null {
    const [, rawAmount, from, to] = query.match(FX_QUERY) ?? [];
    if (rawAmount === undefined || from === undefined) return null;
    const amount = parseLocaleNumber(rawAmount, numberFormat);
    if (!Number.isFinite(amount)) return null;
    return {
        amount,
        from: from.toUpperCase(),
        to: to?.toUpperCase(),
    };
}

const EXPRESSION_TOKEN =
    /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|(\*\*|[-+*/()]))/iy;

/**
 * Evaluates a normalized arithmetic expression (numbers, `+ - * / **`, unary
 * signs and parentheses) with JavaScript operator semantics. Returns null for
 * anything that is not a valid expression. This is a plain recursive-descent
 * parser so no user text is ever executed as code.
 */
function evaluateExpression(source: string): number | null {
    // JavaScript reads adjacent `++` / `--` as update operators, never as two
    // unary signs, so those are syntax errors rather than a double sign.
    if (/\+\+|--/.test(source)) return null;
    const tokens: (number | string)[] = [];
    EXPRESSION_TOKEN.lastIndex = 0;
    let consumed = 0;
    while (consumed < source.length) {
        const match = EXPRESSION_TOKEN.exec(source);
        if (match === null) {
            if (source.slice(consumed).trim() === "") break;
            return null;
        }
        tokens.push(match[1] !== undefined ? Number(match[1]) : match[2] ?? "");
        consumed = EXPRESSION_TOKEN.lastIndex;
    }
    let position = 0;
    const isOperator = (operators: readonly string[]) => {
        const token = tokens[position];
        return typeof token === "string" && operators.includes(token);
    };
    const fail = (): never => {
        throw new SyntaxError("Invalid arithmetic expression");
    };
    const parsePrimary = (): number => {
        const token = tokens[position];
        if (typeof token === "number") {
            position += 1;
            return token;
        }
        if (token === "(") {
            position += 1;
            const value = parseSum();
            if (tokens[position] !== ")") return fail();
            position += 1;
            return value;
        }
        return fail();
    };
    const parseSigned = (): number => {
        if (isOperator(["+", "-"])) {
            const sign = tokens[position] === "-" ? -1 : 1;
            position += 1;
            return sign * parseSigned();
        }
        return parsePrimary();
    };
    const parsePower = (): number => {
        if (isOperator(["+", "-"])) {
            // A signed operand cannot be the base of `**` without parentheses.
            const value = parseSigned();
            return isOperator(["**"]) ? fail() : value;
        }
        const base = parsePrimary();
        if (!isOperator(["**"])) return base;
        position += 1;
        return base ** parsePower();
    };
    const parseProduct = (): number => {
        let value = parsePower();
        while (isOperator(["*", "/"])) {
            const operator = tokens[position];
            position += 1;
            const right = parsePower();
            value = operator === "*" ? value * right : value / right;
        }
        return value;
    };
    function parseSum(): number {
        let value = parseProduct();
        while (isOperator(["+", "-"])) {
            const operator = tokens[position];
            position += 1;
            const right = parseProduct();
            value = operator === "+" ? value + right : value - right;
        }
        return value;
    }
    try {
        const value = parseSum();
        return position === tokens.length ? value : null;
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

export function evaluateArithmetic(
    query: string,
    numberFormat: NumberFormat,
): number | null {
    if (!CALC_QUERY.test(query)) return null;
    if (!/[+\-*/]/.test(query) || !/\d/.test(query)) return null;
    if (/^\s*[\d.,]+\s*$/.test(query)) return null;
    try {
        const normalized = query.replace(/[\d][\d.,'’]*/g, (token) => {
            const value = parseLocaleNumber(token, numberFormat);
            if (!Number.isFinite(value)) {
                return "NaN";
            }
            return String(value);
        });
        // The query only holds digits and operators, so "NaN" marks a bad token.
        if (normalized.includes("NaN")) return null;
        const result = evaluateExpression(normalized);
        return result !== null && Number.isFinite(result) ? result : null;
    } catch {
        return null;
    }
}

export function parseTickerQuery(query: string): string | null {
    const cashtag = query.match(CASHTAG_QUERY)?.[1];
    if (cashtag !== undefined) return cashtag.toUpperCase();
    if (/[A-Z]/.test(query) && BARE_TICKER_QUERY.test(query))
        return query.toUpperCase();
    return null;
}

export function readPaletteRecents(): string[] {
    try {
        const raw = localStorage.getItem(RECENTS_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [];
    } catch {
        return [];
    }
}

export function pushPaletteRecent(url: string): void {
    try {
        const next = [
            url,
            ...readPaletteRecents().filter((entry) => entry !== url),
        ].slice(0, MAX_RECENTS);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
        // localStorage is unavailable.
    }
}
