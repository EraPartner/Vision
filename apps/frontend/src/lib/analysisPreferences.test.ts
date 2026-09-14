import { describe, expect, it } from "vitest";
import {
    PRODUCT_ANALYSIS_PREFERENCES,
    resolveAnalysisPreferences,
} from "@/lib/analysisPreferences";

describe("resolveAnalysisPreferences", () => {
    it("applies run, saved, application, then product precedence per field", () => {
        expect(
            resolveAnalysisPreferences({
                run: { currency: "USD" },
                saved: {
                    currency: "GBP",
                    answerDepth: "detailed",
                    benchmark: "vwce.de",
                },
                appSettings: { language: "nl", defaultCurrency: "CHF" },
            }),
        ).toEqual({
            currency: "USD",
            benchmark: "VWCE.DE",
            answerDepth: "detailed",
            language: "nl",
        });
    });

    it("falls back without inferring a benchmark or risk preference", () => {
        expect(
            resolveAnalysisPreferences({
                run: { currency: "invalid", benchmark: "not a symbol!" },
                appSettings: {},
            }),
        ).toEqual(PRODUCT_ANALYSIS_PREFERENCES);
    });

    it("exposes application defaults after saved values are deleted", () => {
        expect(
            resolveAnalysisPreferences({
                saved: {},
                appSettings: {
                    defaultCurrency: "CAD",
                    language: "nl",
                    aiAnswerDepth: "detailed",
                    analysisBenchmark: "SPY",
                },
            }),
        ).toMatchObject({
            currency: "CAD",
            language: "nl",
            answerDepth: "detailed",
            benchmark: "SPY",
        });
    });

    it("lets an explicit null benchmark override lower-precedence defaults", () => {
        expect(
            resolveAnalysisPreferences({
                run: { benchmark: null },
                saved: { benchmark: "VWCE.DE" },
                appSettings: { analysisBenchmark: "SPY" },
            }).benchmark,
        ).toBeNull();
    });
});
