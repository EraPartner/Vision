import { describe, expect, it } from "vitest";
import {
    normalizeResearchSymbol,
    parseResearchSymbols,
} from "./researchCompareUrlState";

describe("research compare URL symbols", () => {
    it("accepts common provider symbol forms", () => {
        for (const symbol of [
            "AAPL",
            "BRK.B",
            "BTC-USD",
            "^GSPC",
            "EURUSD=X",
            "GC=F",
        ]) {
            expect(normalizeResearchSymbol(symbol)).toBe(symbol);
        }
    });

    it("rejects malformed and overlong symbols, then deduplicates and caps", () => {
        const params = new URLSearchParams();
        for (const symbol of [
            " aapl ",
            "AAPL",
            "bad symbol",
            "A".repeat(33),
            "MSFT",
            "ASML.AS",
            "BTC-USD",
            "^GSPC",
            "EURUSD=X",
            "EXTRA",
        ]) {
            params.append("symbol", symbol);
        }

        expect(parseResearchSymbols(params)).toEqual([
            "AAPL",
            "MSFT",
            "ASML.AS",
            "BTC-USD",
            "^GSPC",
            "EURUSD=X",
        ]);
    });
});
