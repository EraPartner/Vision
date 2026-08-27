import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

const FX_QUERY = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{3})(?:\s+(?:in|to|naar)\s+([a-zA-Z]{3}))?$/;
const CALC_QUERY = /^[\d\s+\-*/().,]+$/;
const CASHTAG_QUERY = /^\$([A-Za-z][A-Za-z0-9.-]{0,9})$/;
const BARE_TICKER_QUERY = /^[A-Za-z]{2,5}(?:[.-][A-Za-z0-9]{1,4})?$/;
const RECENTS_KEY = LOCAL_STORAGE_KEYS.PALETTE_RECENTS;
const MAX_RECENTS = 5;

export interface ParsedFxQuery {
    amount: number;
    from: string;
    to?: string;
}

export function parseFxQuery(query: string): ParsedFxQuery | null {
    const match = query.match(FX_QUERY);
    if (!match) return null;
    const amount = Number(match[1].replace(",", "."));
    if (!Number.isFinite(amount)) return null;
    return { amount, from: match[2].toUpperCase(), to: match[3]?.toUpperCase() };
}

export function evaluateArithmetic(query: string): number | null {
    if (!CALC_QUERY.test(query)) return null;
    if (!/[+\-*/]/.test(query) || !/\d/.test(query)) return null;
    if (/^\s*[\d.,]+\s*$/.test(query)) return null;
    try {
        const result = new Function(`"use strict"; return (${query.replace(/,/g, ".")});`)() as unknown;
        return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
        return null;
    }
}

export function parseTickerQuery(query: string): string | null {
    const cashtag = query.match(CASHTAG_QUERY);
    if (cashtag) return cashtag[1].toUpperCase();
    if (/[A-Z]/.test(query) && BARE_TICKER_QUERY.test(query)) return query.toUpperCase();
    return null;
}

export function readPaletteRecents(): string[] {
    try {
        const raw = localStorage.getItem(RECENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string")
            : [];
    } catch {
        return [];
    }
}

export function pushPaletteRecent(url: string): void {
    try {
        const next = [url, ...readPaletteRecents().filter((entry) => entry !== url)].slice(0, MAX_RECENTS);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
        // localStorage is unavailable.
    }
}
