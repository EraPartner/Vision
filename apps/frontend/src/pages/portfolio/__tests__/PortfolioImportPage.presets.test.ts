import { describe, expect, it } from "vitest";

import {
    portfolioImportPresetConfig,
    portfolioImportSpecializedHintKey,
} from "../portfolioImportPresets";

describe("PortfolioImportPage maintained presets", () => {
    it.each([
        {
            source: "nexo",
            format: "nexo_transaction_history",
            dateColumn: "Date / Time (UTC)",
            symbolColumn: "Output Currency",
            hint: "portfolioImport.nexoParserHint",
        },
        {
            source: "saxo",
            format: "saxo_transaction_history",
            dateColumn: "Transactiedatum",
            symbolColumn: "Instrumentsymbool",
            hint: "portfolioImport.saxoParserHint",
        },
    ] as const)(
        "maps the $source selection to its format, columns, and hint",
        ({ source, format, dateColumn, symbolColumn, hint }) => {
            const config = portfolioImportPresetConfig(source);

            expect(config).toMatchObject({
                format,
                dateColumn,
                symbolColumn,
            });
            expect(portfolioImportSpecializedHintKey(config?.format)).toBe(
                hint,
            );
        },
    );

    it("returns a fresh config for each selection", () => {
        const first = portfolioImportPresetConfig("nexo");
        const second = portfolioImportPresetConfig("nexo");

        expect(first).not.toBe(second);
        expect(portfolioImportPresetConfig("custom")).toBeUndefined();
        expect(portfolioImportSpecializedHintKey(undefined)).toBeUndefined();
    });
});
