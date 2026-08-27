// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import {
    evaluateArithmetic,
    parseFxQuery,
    parseTickerQuery,
    pushPaletteRecent,
    readPaletteRecents,
} from "@/lib/commandPalette";

class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string) { return this.store.get(key) ?? null; }
    setItem(key: string, value: string) { this.store.set(key, value); }
    removeItem(key: string) { this.store.delete(key); }
    clear() { this.store.clear(); }
    get length() { return this.store.size; }
    key(index: number) { return [...this.store.keys()][index] ?? null; }
}

beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("command palette inline helpers", () => {
    it("parses locale decimals and optional FX targets without trimming the input", () => {
        expect(parseFxQuery("12.5 usd")).toEqual({ amount: 12.5, from: "USD", to: undefined });
        expect(parseFxQuery("12,5 eur naar gbp")).toEqual({ amount: 12.5, from: "EUR", to: "GBP" });
        expect(parseFxQuery("3 EUR to USD")).toEqual({ amount: 3, from: "EUR", to: "USD" });
        expect(parseFxQuery(" 3 EUR ")).toBeNull();
        expect(parseFxQuery("EUR 3")).toBeNull();
    });

    it("evaluates only guarded finite arithmetic expressions", () => {
        expect(evaluateArithmetic("2 * (3 + 4)")).toBe(14);
        expect(evaluateArithmetic("1,5 + 2")).toBe(3.5);
        expect(evaluateArithmetic("2**3")).toBe(8);
        expect(evaluateArithmetic("42")).toBeNull();
        expect(evaluateArithmetic("process.exit()")).toBeNull();
        expect(evaluateArithmetic("2 +")).toBeNull();
        expect(evaluateArithmetic("1 / 0")).toBeNull();
    });

    it("parses explicit cashtags and uppercase-bearing ticker shapes", () => {
        expect(parseTickerQuery("$aapl")).toBe("AAPL");
        expect(parseTickerQuery("BRK-B")).toBe("BRK-B");
        expect(parseTickerQuery("ASML.AS")).toBe("ASML.AS");
        expect(parseTickerQuery("food")).toBeNull();
        expect(parseTickerQuery("TOO-LONG-SYMBOL")).toBeNull();
    });

    it("reads only string recents and tolerates malformed or unavailable storage", () => {
        localStorage.setItem(LOCAL_STORAGE_KEYS.PALETTE_RECENTS, JSON.stringify(["/one", 2, "/one", "/two"]));
        expect(readPaletteRecents()).toEqual(["/one", "/one", "/two"]);

        localStorage.setItem(LOCAL_STORAGE_KEYS.PALETTE_RECENTS, "not-json");
        expect(readPaletteRecents()).toEqual([]);

        vi.stubGlobal("localStorage", {
            getItem: () => { throw new Error("storage unavailable"); },
            setItem: () => { throw new Error("storage unavailable"); },
        });
        expect(readPaletteRecents()).toEqual([]);
    });

    it("pushes exact-string-deduplicated recents newest first with a five-item cap", () => {
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.PALETTE_RECENTS,
            JSON.stringify(["/two", "/one", "/three", "/four", "/five"]),
        );

        pushPaletteRecent("/one");
        expect(readPaletteRecents()).toEqual(["/one", "/two", "/three", "/four", "/five"]);

        pushPaletteRecent("/six");
        expect(readPaletteRecents()).toEqual(["/six", "/one", "/two", "/three", "/four"]);
    });
});
