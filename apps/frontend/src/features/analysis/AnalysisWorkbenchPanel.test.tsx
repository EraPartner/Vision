// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnalysisResult } from "@/lib/api/analysis";
import { evaluateAnalysisExtension } from "@/lib/api/analysis";
import {
    AnalysisWorkbenchPanel,
    type AnalysisWorkbenchConfig,
} from "./AnalysisWorkbenchPanel";
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({ appSettings: { numberFormat: "eu" } }),
}));
vi.mock("@/lib/api/analysis", () => ({ evaluateAnalysisExtension: vi.fn() }));
const pick = async (label: string, option: string) => {
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(label));
    await user.click(await screen.findByRole("option", { name: option }));
};
const choose = (option: string) =>
    fireEvent.click(screen.getByRole("radio", { name: option }));
const result = {
    rows: [{ date: "2026-09-01", amount: "12" }],
    columns: [
        { id: "date", type: "date" },
        { id: "amount", type: "decimal" },
    ],
    window: {
        kind: "page",
        offset: 0,
        hasMore: false,
        limit: 500,
        returnedRows: 1,
    },
} as unknown as AnalysisResult;
function Harness({ partial = false }: { partial?: boolean }) {
    const [formulas, setFormulas] = useState(
        '[{"id":"total","label":"Total","expression":"SUM(row.amount)","scope":"summary"}]',
    );
    const [assumptions, setAssumptions] = useState(
        '[{"id":"rate","label":"Rate","defaultValue":"0.1"}]',
    );
    const [values, setValues] = useState("{}");
    const [config, setConfig] = useState<AnalysisWorkbenchConfig>({});
    return (
        <AnalysisWorkbenchPanel
            result={
                partial
                    ? {
                          ...result,
                          window: {
                              kind: "truncated",
                              returnedRows: 1,
                              enforcedLimit: 1,
                              reason: "limit",
                          },
                      }
                    : result
            }
            formulasJson={formulas}
            onFormulasChange={setFormulas}
            assumptionsJson={assumptions}
            onAssumptionsChange={setAssumptions}
            assumptionValuesJson={values}
            onAssumptionValuesChange={setValues}
            config={config}
            onConfigChange={setConfig}
            attachments={[]}
            onResultChange={vi.fn()}
        />
    );
}
beforeEach(() => {
    vi.mocked(evaluateAnalysisExtension).mockReset();
    vi.mocked(evaluateAnalysisExtension).mockResolvedValue({
        summaries: { total: "12" },
        errors: [],
    });
});
describe("guided analysis workbench", () => {
    it("creates formulas without JSON and previews summary outcomes", async () => {
        render(<Harness />);
        fireEvent.click(screen.getByText("analysis.ext.workbench.addFormula"));
        expect(
            screen.getAllByLabelText("analysis.ext.workbench.expression"),
        ).toHaveLength(1);
        expect(
            screen.getByLabelText("analysis.ext.workbench.expression"),
        ).toHaveFocus();
        await waitFor(() =>
            expect(evaluateAnalysisExtension).toHaveBeenCalledWith(
                expect.objectContaining({
                    operation: "formulas",
                    complete: true,
                }),
            ),
        );
        expect(screen.getAllByText("12").length).toBeGreaterThan(0);
    });
    it("copies numeric current assumptions into a named scenario and runs comparison", async () => {
        render(<Harness />);
        fireEvent.change(screen.getByLabelText("analysis.ext.workbench.name"), {
            target: { value: "Base" },
        });
        fireEvent.click(
            screen.getByText("analysis.ext.workbench.copyScenario"),
        );
        fireEvent.change(
            within(screen.getByRole("group", { name: "Base" })).getByLabelText(
                "Rate",
            ),
            { target: { value: "0.3" } },
        );
        fireEvent.click(screen.getByText("analysis.ext.workbench.compare"));
        await waitFor(() =>
            expect(evaluateAnalysisExtension).toHaveBeenCalledWith(
                expect.objectContaining({
                    operation: "scenarios",
                    scenarios: [
                        expect.objectContaining({
                            name: "Base",
                            assumptions: { rate: "0.3" },
                        }),
                    ],
                }),
            ),
        );
    });
    it("withholds full-population operations on partial results", () => {
        render(<Harness partial />);
        expect(
            screen.getByText("analysis.ext.workbench.compareTime"),
        ).toBeDisabled();
        choose("analysis.ext.workbench.option.explore");
        expect(
            screen.getByText("analysis.ext.workbench.sensitivity"),
        ).toBeDisabled();
    });
    it("carries structured assumption units to evaluation and exposes financial functions", async () => {
        render(<Harness />);
        fireEvent.click(screen.getByText("analysis.ext.workbench.assumptions"));
        await pick(
            "analysis.ext.workbench.unitKind",
            "analysis.ext.workbench.option.percentage",
        );
        choose("analysis.ext.workbench.option.percent");
        fireEvent.click(
            screen.getByText("analysis.ext.workbench.applyFormulas"),
        );
        await waitFor(() =>
            expect(evaluateAnalysisExtension).toHaveBeenCalledWith(
                expect.objectContaining({
                    assumptionUnits: {
                        rate: {
                            kind: "percentage",
                            percentageBasis: "percent",
                        },
                    },
                }),
            ),
        );
        fireEvent.click(
            screen.getByText("analysis.ext.workbench.functionsHelp"),
        );
        await userEvent
            .setup()
            .click(screen.getByLabelText("analysis.ext.workbench.function"));
        expect(
            await screen.findByRole("option", { name: "MEDIAN" }),
        ).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "PMT" })).toBeInTheDocument();
    });
});

it("applies partial formula coverage and prepared schema while retaining complete source pagination", async () => {
    const applied = vi.fn();
    vi.mocked(evaluateAnalysisExtension).mockResolvedValue({
        rows: [{ period: "2026-09", total: null }],
        columns: [
            { id: "period", label: "Period", type: "string" },
            { id: "total", label: "Total", type: "decimal" },
        ],
        summaries: {},
        errors: [{ formulaId: "total", message: "Unavailable contributor" }],
        complete: false,
        coverage: { complete: false, status: "partial" },
        transformationCoverage: [{ complete: false }],
        transformationErrors: [{ message: "Invalid date" }],
        preparationLineage: [{ step: "convert" }],
        window: result.window,
    });
    render(
        <AnalysisWorkbenchPanel
            result={{
                ...result,
                coverage: { sourceRows: 5, unavailableRows: 1 },
            }}
            formulasJson='[{"id":"total","scope":"summary","expression":"SUM(row.amount)"}]'
            onFormulasChange={vi.fn()}
            assumptionsJson="[]"
            onAssumptionsChange={vi.fn()}
            assumptionValuesJson="{}"
            onAssumptionValuesChange={vi.fn()}
            config={{}}
            onConfigChange={vi.fn()}
            attachments={[]}
            onResultChange={applied}
        />,
    );
    fireEvent.click(screen.getByText("analysis.ext.workbench.applyFormulas"));
    await waitFor(() => expect(applied).toHaveBeenCalled());
    expect(applied.mock.calls[0][0]).toMatchObject({
        complete: false,
        coverage: {
            complete: false,
            status: "partial",
            sourceRows: 5,
            unavailableRows: 1,
        },
        window: result.window,
        columns: [{ id: "period" }, { id: "total" }],
        transformationCoverage: [{ complete: false }],
        transformationErrors: [{ message: "Invalid date" }],
        preparationLineage: [{ step: "convert" }],
        formulaErrors: [
            { formulaId: "total", message: "Unavailable contributor" },
        ],
    });
});

it("prevents applying against an outdated query and discards responses after draft edits", async () => {
    const applied = vi.fn();
    const props = {
        result,
        formulasJson:
            '[{"id":"derived","label":"Derived","scope":"row","expression":"row.amount * 2"}]',
        onFormulasChange: vi.fn(),
        assumptionsJson: "[]",
        onAssumptionsChange: vi.fn(),
        assumptionValuesJson: "{}",
        onAssumptionValuesChange: vi.fn(),
        config: {},
        onConfigChange: vi.fn(),
        attachments: [],
        onResultChange: applied,
    };
    const view = render(<AnalysisWorkbenchPanel {...props} sourceStale />);
    expect(
        screen.getByText("analysis.ext.workbench.applyFormulas"),
    ).toBeDisabled();
    view.rerender(<AnalysisWorkbenchPanel {...props} />);
    let resolve: (value: never) => void = () => {};
    vi.mocked(evaluateAnalysisExtension).mockImplementation(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
    );
    fireEvent.click(screen.getByText("analysis.ext.workbench.applyFormulas"));
    view.rerender(<AnalysisWorkbenchPanel {...props} formulasJson="[]" />);
    resolve({
        rows: [{ derived: "24" }],
        columns: [{ id: "derived", type: "decimal" }],
    } as never);
    await waitFor(() =>
        expect(
            screen.queryByText("analysis.ext.workbench.applying"),
        ).not.toBeInTheDocument(),
    );
    expect(applied).not.toHaveBeenCalled();
});

it("applies preparation through the complete calculation pipeline", async () => {
    const applied = vi.fn();
    const steps = [
        {
            type: "convert",
            columnId: "amount",
            targetType: "decimal",
            onError: "null",
        },
    ];
    vi.mocked(evaluateAnalysisExtension).mockResolvedValue({
        rows: [{ amount: "12", doubled: "24" }],
        columns: [
            { id: "amount", label: "Amount", type: "decimal" },
            { id: "doubled", label: "Doubled", type: "decimal" },
        ],
    });
    render(
        <AnalysisWorkbenchPanel
            result={result}
            formulasJson='[{"id":"doubled","scope":"row","expression":"row.amount * 2"}]'
            onFormulasChange={vi.fn()}
            assumptionsJson="[]"
            onAssumptionsChange={vi.fn()}
            assumptionValuesJson="{}"
            onAssumptionValuesChange={vi.fn()}
            config={{ steps }}
            onConfigChange={vi.fn()}
            attachments={[]}
            onResultChange={applied}
        />,
    );
    fireEvent.click(screen.getByText("analysis.ext.workbench.applySteps"));
    await waitFor(() => expect(applied).toHaveBeenCalled());
    expect(evaluateAnalysisExtension).toHaveBeenCalledWith(
        expect.objectContaining({
            operation: "formulas",
            workbench: { steps },
            formulas: [expect.objectContaining({ id: "doubled" })],
            window: result.window,
        }),
    );
});

it("keeps preparation task-driven and prevents adding an incomplete conversion", async () => {
    render(<Harness />);
    expect(
        screen.queryByLabelText("analysis.ext.workbench.column"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("analysis.ext.workbench.newStep"));
    expect(screen.getByText("analysis.ext.workbench.addStep")).toBeDisabled();
    await pick("analysis.ext.workbench.column", "amount");
    fireEvent.click(screen.getByText("analysis.ext.workbench.addStep"));
    expect(
        screen.getByText(
            /1\. analysis.ext.workbench.option.convert · amount · analysis.ext.workbench.option.decimal/,
        ),
    ).toBeInTheDocument();
    expect(
        screen.queryByLabelText("analysis.ext.workbench.column"),
    ).not.toBeInTheDocument();
});
it("shows only the selected scenario task and only one value list without a second variable", () => {
    render(<Harness />);
    expect(
        screen.queryByLabelText("analysis.ext.workbench.target"),
    ).not.toBeInTheDocument();
    choose("analysis.ext.workbench.option.explore");
    expect(
        screen.getAllByLabelText("analysis.ext.workbench.grid"),
    ).toHaveLength(1);
    expect(
        screen.queryByLabelText("analysis.ext.workbench.name"),
    ).not.toBeInTheDocument();
    choose("analysis.ext.workbench.option.seek");
    expect(
        screen.getByLabelText("analysis.ext.workbench.target"),
    ).toBeInTheDocument();
    expect(
        screen.queryByLabelText("analysis.ext.workbench.grid"),
    ).not.toBeInTheDocument();
});
it("searches fields and inserts the stable reference into the active formula", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.insertField"));
    fireEvent.change(
        screen.getByLabelText("analysis.ext.workbench.searchFields"),
        { target: { value: "amount" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "amount" }));
    expect(
        screen.getByLabelText("analysis.ext.workbench.expression"),
    ).toHaveValue("SUM(row.amount) row.amount");
});

it("formats scenario summary decimals without changing the exact value", async () => {
    vi.mocked(evaluateAnalysisExtension).mockResolvedValue({
        scenarios: [
            {
                id: "base",
                name: "Base outcome",
                summaries: { total: "1234.567890" },
            },
        ],
    });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("analysis.ext.workbench.name"), {
        target: { value: "Base" },
    });
    fireEvent.click(screen.getByText("analysis.ext.workbench.copyScenario"));
    fireEvent.click(screen.getByText("analysis.ext.workbench.compare"));
    expect(await screen.findByText("1.234,567890")).toBeInTheDocument();
});

it("queues unpivot with a new value column name and retains the pivot source selector", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.newStep"));
    await pick(
        "analysis.ext.workbench.step",
        "analysis.ext.workbench.option.unpivot",
    );
    fireEvent.click(
        within(
            screen.getAllByRole("group", {
                name: "analysis.ext.workbench.values",
            })[0],
        ).getByRole("checkbox", { name: "amount" }),
    );
    const valueName = screen.getByRole("textbox", {
        name: "analysis.ext.workbench.valueColumn",
    });
    fireEvent.change(valueName, { target: { value: "amount" } });
    expect(screen.getByText("analysis.ext.workbench.addStep")).toBeDisabled();
    fireEvent.change(valueName, { target: { value: "measure_value" } });
    fireEvent.click(screen.getByText("analysis.ext.workbench.addStep"));
    fireEvent.click(screen.getByText("analysis.ext.workbench.applySteps"));
    await waitFor(() =>
        expect(evaluateAnalysisExtension).toHaveBeenCalledWith(
            expect.objectContaining({
                workbench: {
                    steps: [
                        {
                            type: "unpivot",
                            columnIds: ["amount"],
                            nameColumn: "derived",
                            valueColumn: "measure_value",
                        },
                    ],
                },
            }),
        ),
    );
    fireEvent.click(screen.getByText("analysis.ext.workbench.newStep"));
    await pick(
        "analysis.ext.workbench.step",
        "analysis.ext.workbench.option.pivot",
    );
    expect(
        screen.getByRole("combobox", {
            name: "analysis.ext.workbench.valueColumn",
        }),
    ).toBeInTheDocument();
});

it("shows contextual preparation guidance and explains conflicting output names", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.newStep"));
    expect(
        screen.getByText("analysis.ext.workbench.stepHelp.convert"),
    ).toBeInTheDocument();
    await pick(
        "analysis.ext.workbench.step",
        "analysis.ext.workbench.option.lookup",
    );
    expect(
        screen.getByText("analysis.ext.workbench.attachmentRequired"),
    ).toBeInTheDocument();
    expect(
        screen.queryByText("analysis.ext.workbench.stepHelp.convert"),
    ).not.toBeInTheDocument();
    await pick(
        "analysis.ext.workbench.step",
        "analysis.ext.workbench.option.unpivot",
    );
    fireEvent.change(
        screen.getByRole("textbox", {
            name: "analysis.ext.workbench.valueColumn",
        }),
        { target: { value: "amount" } },
    );
    expect(
        screen.getByText("analysis.ext.workbench.outputNamesConflict"),
    ).toBeInTheDocument();
    fireEvent.change(
        screen.getByRole("textbox", {
            name: "analysis.ext.workbench.valueColumn",
        }),
        { target: { value: "new_value" } },
    );
    expect(
        screen.queryByText("analysis.ext.workbench.outputNamesConflict"),
    ).not.toBeInTheDocument();
});
it("explains an empty field search and recovers when the search is cleared", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.insertField"));
    fireEvent.change(
        screen.getByLabelText("analysis.ext.workbench.searchFields"),
        { target: { value: "no such field" } },
    );
    expect(
        screen.getByText("analysis.ext.workbench.noMatchingFields"),
    ).toBeInTheDocument();
    fireEvent.change(
        screen.getByLabelText("analysis.ext.workbench.searchFields"),
        { target: { value: "" } },
    );
    expect(
        screen.queryByText("analysis.ext.workbench.noMatchingFields"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "amount" })).toBeInTheDocument();
});

it("announces a pending preview and retries a failed preview without changing formulas", async () => {
    vi.mocked(evaluateAnalysisExtension).mockRejectedValueOnce(
        new Error("Temporary failure"),
    );
    render(<Harness />);
    expect(
        screen.getByText("analysis.ext.workbench.previewLoading"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Temporary failure/)).toBeInTheDocument();
    expect(
        screen.queryByText("analysis.ext.workbench.previewLoading"),
    ).not.toBeInTheDocument();
    vi.mocked(evaluateAnalysisExtension).mockResolvedValue({
        summaries: { total: "42" },
    });
    fireEvent.click(screen.getByText("analysis.ext.workbench.retryPreview"));
    expect(
        screen.getByText("analysis.ext.workbench.previewLoading"),
    ).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.queryByText(/Temporary failure/)).not.toBeInTheDocument();
    expect(
        screen.getByLabelText("analysis.ext.workbench.expression"),
    ).toHaveValue("SUM(row.amount)");
});

it("does not show an outdated apply failure after switching away from the formulas", async () => {
    let reject: (cause: Error) => void = () => {};
    vi.mocked(evaluateAnalysisExtension).mockImplementation(
        () =>
            new Promise((_resolve, fail) => {
                reject = fail;
            }),
    );
    const props = {
        result,
        formulasJson:
            '[{"id":"total","label":"Total","expression":"SUM(row.amount)","scope":"summary"}]',
        onFormulasChange: vi.fn(),
        assumptionsJson: "[]",
        onAssumptionsChange: vi.fn(),
        assumptionValuesJson: "{}",
        onAssumptionValuesChange: vi.fn(),
        config: {},
        onConfigChange: vi.fn(),
        attachments: [],
        onResultChange: vi.fn(),
    };
    const view = render(<AnalysisWorkbenchPanel {...props} />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.applyFormulas"));
    view.rerender(
        <AnalysisWorkbenchPanel {...props} formulasJson="[]" sourceStale />,
    );
    reject(new Error("Old request failed"));
    await waitFor(() =>
        expect(
            screen.queryByText("analysis.ext.workbench.applying"),
        ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Old request failed")).not.toBeInTheDocument();
    expect(
        screen.queryByText("analysis.ext.workbench.previewLoading"),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByText("analysis.ext.workbench.applyFormulas"),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByText("analysis.ext.workbench.applySteps"),
    ).not.toBeInTheDocument();
});

it("starts an empty row calculation from an actual result field and focuses the editable expression", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("analysis.ext.workbench.addFormula"));
    fireEvent.click(
        screen.getByRole("button", {
            name: "analysis.ext.workbench.startWithField · amount",
        }),
    );
    expect(
        screen.getByLabelText("analysis.ext.workbench.expression"),
    ).toHaveValue("row.amount");
    expect(
        screen.getByLabelText("analysis.ext.workbench.expression"),
    ).toHaveFocus();
    expect(
        screen.queryByRole("button", {
            name: "analysis.ext.workbench.startWithField · amount",
        }),
    ).not.toBeInTheDocument();
});
