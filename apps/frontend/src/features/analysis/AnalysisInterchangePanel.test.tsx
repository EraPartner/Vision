// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { AnalysisInterchangePanel } from "./AnalysisInterchangePanel";
import type { AnalysisResult } from "@/lib/api/analysis";
import type { AnalysisScenarioModel } from "./analysisInterchange";
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);
const model: AnalysisScenarioModel = {
    attachments: [
        {
            id: "prices",
            fileName: "prices.csv",
            importedAt: "2026-10-01",
            sha256: "abc",
            rows: [{ ticker: "ABC", price: 12 }],
            columns: [
                { id: "price", label: "Price", type: "decimal" },
                { id: "ticker", label: "Ticker", type: "string" },
            ],
        },
    ],
    joins: [
        { inputId: "prices", resultColumn: "symbol", inputColumn: "ticker" },
    ],
};
const result = {
    columns: [
        { id: "amount", type: "decimal" },
        { id: "symbol", type: "string" },
    ],
    rows: [],
} as unknown as AnalysisResult;
function setup(current: AnalysisScenarioModel = model) {
    const onChange = vi.fn();
    render(
        <AnalysisInterchangePanel
            result={result}
            name="Test"
            timezone="UTC"
            workspace="portfolio"
            datasetIds={[]}
            sourceReferences={[]}
            scenarioModel={current}
            onScenarioModelChange={onChange}
        />,
    );
    return onChange;
}
describe("Analysis import matching", () => {
    it("shows the saved match in visibly labelled fields and preserves it on update", () => {
        const onChange = setup();
        expect(
            (
                screen.getByLabelText(
                    "analysis.interchange.resultField",
                ) as HTMLSelectElement
            ).value,
        ).toBe("symbol");
        expect(
            (
                screen.getByLabelText(
                    "analysis.interchange.importedField",
                ) as HTMLSelectElement
            ).value,
        ).toBe("ticker");
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.updateScenarioJoin" }),
        );
        expect(onChange).toHaveBeenCalledWith(model);
    });
    it("updates a selected match and removes its attachment and join together", () => {
        const onChange = setup();
        fireEvent.change(
            screen.getByLabelText("analysis.interchange.resultField"),
            { target: { value: "amount" } },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.updateScenarioJoin" }),
        );
        expect(onChange.mock.calls[0][0].joins[0].resultColumn).toBe("amount");
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.removeScenario" }),
        );
        expect(onChange).toHaveBeenLastCalledWith({
            attachments: [],
            joins: [],
        });
    });
    it("labels both keyboard reachable file pickers", () => {
        setup();
        expect(
            screen
                .getByLabelText("analysis.ext.workbook.import")
                .getAttribute("type"),
        ).toBe("file");
        expect(
            screen
                .getByLabelText("analysis.attachScenarioCsv")
                .getAttribute("type"),
        ).toBe("file");
    });
});
