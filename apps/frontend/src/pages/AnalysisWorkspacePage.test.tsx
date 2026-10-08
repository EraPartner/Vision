// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { apiClient } from "@/lib/api";
import * as analysisApi from "@/lib/api/analysis";
import { downloadBlob } from "@/lib/downloadBlob";
import AnalysisWorkspacePage from "@/pages/AnalysisWorkspacePage";

import { analysisDraftSignature } from "@/features/analysis/analysisPresentation";

const presentation = vi.hoisted(() => ({ language: "en" as "en" | "nl" }));

vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: vi.fn() }));

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: en } = await import("@/locales/en");
    const { default: nl } = await import("@/locales/nl");
    return {
        ...actual,
        useLanguage: () => ({
            language: presentation.language,
            setLanguage: vi.fn(),
            t: (key: string, params: Record<string, string | number> = {}) =>
                Object.entries(params).reduce(
                    (text, [name, value]) =>
                        text.replaceAll(`{${name}}`, String(value)),
                    (presentation.language === "nl" ? nl : en)[key] ?? key,
                ),
        }),
    };
});

type User = ReturnType<typeof userEvent.setup>;
async function openRowMenu(user: User, name: string) {
    await user.click(
        screen.getByRole("button", { name: `Actions for ${name}` }),
    );
}
async function clickRowAction(user: User, name: string, action: string) {
    await openRowMenu(user, name);
    await user.click(await screen.findByRole("menuitem", { name: action }));
}
async function expectRowActionIdle(user: User, name: string, action: string) {
    await openRowMenu(user, name);
    await waitFor(() =>
        expect(
            screen.getByRole("menuitem", { name: action }),
        ).not.toHaveAttribute("aria-disabled"),
    );
    await user.keyboard("{Escape}");
}
async function pickOption(user: User, trigger: HTMLElement, option: string) {
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: option }));
}

function renderPage() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/analysis"]}>
                <AnalysisWorkspacePage />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

const catalog = {
    version: 1,
    datasets: [
        {
            id: "cash-flows",
            label: "Cash flows",
            relation: "vision_analysis.cash_flows_v1",
            fields: [
                { id: "month", label: "Month", type: "date" },
                { id: "currency", label: "Currency", type: "currency" },
                {
                    id: "category_general",
                    label: "Category",
                    type: "string",
                },
                { id: "is_transfer", label: "Transfer", type: "boolean" },
                { id: "is_active", label: "Active", type: "boolean" },
            ],
            measures: [
                {
                    id: "sum_spending",
                    label: "Spending",
                    type: "decimal",
                },
            ],
            joins: [],
        },
    ],
};

const result = {
    requestId: "analysis-test-request",
    startedAt: "2026-09-13T10:00:00.000Z",
    completedAt: "2026-09-13T10:00:00.010Z",
    executor: "postgresql-role-v1",
    rows: [
        {
            month: "2026-09-01",
            category_general: "Food",
            sum_spending: "12.30",
        },
    ],
    columns: [
        { id: "month", type: "date" },
        { id: "category_general", type: "string" },
        { id: "sum_spending", type: "decimal" },
    ],
    generatedSql:
        "SELECT month, category_general, SUM(spending_amount) AS sum_spending FROM vision_analysis.cash_flows_v1 GROUP BY month, category_general",
    byteLength: 80,
    window: {
        kind: "page" as const,
        offset: 0,
        limit: 500,
        hasMore: false,
        returnedRows: 1,
    },
};

const savedChartAnalysis = {
    id: "chart-analysis",
    definitionId: "analysis:chart",
    name: "Monthly cashflow",
    workspace: "budgeting",
    version: 1,
    refreshMode: "live",
    parameters: {},
    charts: [],
    sourceReferences: [],
    refreshStatus: "success",
    lastResult: result,
    definition: {
        source: {
            kind: "visual-plan",
            datasetId: "cash-flows",
            select: [
                { id: "month", source: { kind: "field" } },
                { id: "sum_spending", source: { kind: "metric" } },
            ],
            groupBy: ["month"],
            orderBy: [],
            filters: [],
            joins: [],
            limit: 500,
        },
    },
};

describe("AnalysisWorkspacePage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        presentation.language = "en";
        vi.spyOn(apiClient, "getAnalysisCatalog").mockResolvedValue(
            catalog as never,
        );
        vi.spyOn(apiClient, "listSavedAnalyses").mockResolvedValue([]);
        vi.spyOn(analysisApi, "executeAnalysisPivot").mockResolvedValue({
            levels: [],
            partitions: ["currency"],
            config: { rows: [], columns: [], values: [], filters: [] },
            coverage: { complete: true, rows: 1 },
        });
        vi.spyOn(analysisApi, "evaluateAnalysisExtension").mockResolvedValue({
            rows: result.rows,
            columns: result.columns.map((c) => ({ ...c, label: c.id })),
            errors: [],
            summaries: {},
        });
        vi.spyOn(apiClient, "executeAnalysis").mockResolvedValue(
            result as never,
        );
    });

    it("uses Dutch catalog and result labels without changing query identifiers", async () => {
        presentation.language = "nl";
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Kasstromen");
        expect(
            screen.getAllByRole("checkbox", { name: "Maand" }).length,
        ).toBeGreaterThan(0);
        const { default: nl } = await import("@/locales/nl");
        await user.click(
            screen.getByRole("button", { name: nl["analysis.run"] }),
        );
        expect(
            await screen.findByRole("button", { name: "Uitgaven" }),
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("tab", { name: nl["analysis.chart"] }),
        );
        await user.click(screen.getByLabelText(nl["analysis.ext.chart.x"]));
        expect(
            await screen.findByRole("option", { name: "Uitgaven" }),
        ).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(
            within(screen.getByRole("tabpanel")).getByRole("checkbox", {
                name: "Uitgaven",
            }),
        ).toBeChecked();
        await user.click(
            screen.getByRole("tab", { name: nl["analysis.pivot"] }),
        );
        expect(
            screen.getByRole("button", { name: nl["analysis.ext.pivot.run"] }),
        ).toBeInTheDocument();
    });

    it("keeps optional tools collapsed and preserves edits when reopening them", async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        const disclosure = screen
            .getByText("Refine this analysis")
            .closest("details")!;
        expect(disclosure).not.toHaveAttribute("open");
        await user.click(screen.getByRole("link", { name: "Calculate" }));
        expect(disclosure).toHaveAttribute("open");
        await user.click(screen.getByRole("button", { name: "Add formula" }));
        await user.type(screen.getByLabelText("Expression"), "1 + 2");
        await user.click(screen.getByText("Refine this analysis"));
        expect(disclosure).not.toHaveAttribute("open");
        await user.click(screen.getByText("Refine this analysis"));
        expect(screen.getByLabelText("Expression")).toHaveValue("1 + 2");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() => expect(disclosure).not.toHaveAttribute("open"));
        expect(screen.getByRole("heading", { name: /Present/ })).toHaveFocus();
        await user.click(screen.getByText("Refine this analysis"));
        expect(screen.getByLabelText("Expression")).toHaveValue("1 + 2");
    });

    it("marks changed queries as outdated until a successful rerun", async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await screen.findByText(/FROM vision_analysis\.cash_flows_v1/);
        await user.click(
            screen.getByRole("button", { name: "Remove filter 1: Transfer" }),
        );
        expect(
            await screen.findByText(/Results need updating/),
        ).toBeInTheDocument();
        vi.mocked(apiClient.executeAnalysis).mockRejectedValueOnce(
            new Error("Unavailable"),
        );
        await user.click(screen.getByRole("button", { name: "Run" }));
        await screen.findByRole("alert");
        expect(screen.getByText(/Results need updating/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() =>
            expect(
                screen.queryByText(/Results need updating/),
            ).not.toBeInTheDocument(),
        );
    });

    it("shows one result view and preserves chart choices when switching views", async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));
        const table = await screen.findByRole("tab", { name: "Table" });
        expect(table).toHaveAttribute("aria-selected", "true");
        expect(
            screen.queryByLabelText("Category / X axis"),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        await pickOption(
            user,
            screen.getByLabelText("Category / X axis"),
            "Category",
        );
        await user.click(table);
        expect(
            screen.queryByLabelText("Category / X axis"),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        expect(screen.getByLabelText("Category / X axis")).toHaveTextContent(
            "Category",
        );
        await user.click(
            screen.getByRole("button", { name: "Remove filter 1: Transfer" }),
        );
        expect(await screen.findByText(/Results need updating/)).toBeVisible();
    });

    it("charts every numeric returned row with signed axes and reports missing values", async () => {
        vi.mocked(apiClient.executeAnalysis).mockResolvedValue({
            ...result,
            rows: Array.from({ length: 32 }, (_, i) => ({
                month: `period-${i + 1}`,
                sum_spending: i === 31 ? null : i === 0 ? "-12.3" : "12.3",
            })),
            window: { ...result.window, returnedRows: 32 },
        } as never);
        const user = userEvent.setup();
        const { container } = renderPage();
        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await user.click(await screen.findByRole("tab", { name: "Chart" }));
        expect(screen.getByText("period-31")).toBeInTheDocument();
        expect(screen.getByText("period-32")).toBeInTheDocument();
        expect(
            screen.getByText(/32 rows; 1 rows contain missing/),
        ).toBeVisible();
        const bars = container.querySelectorAll("svg[role=img] rect");
        expect(bars).toHaveLength(31);
        const zero = Number(
            Array.from(container.querySelectorAll("svg[role=img] line"))
                .at(-1)
                ?.getAttribute("y1"),
        );
        expect(Number(bars[0].getAttribute("y"))).toBe(zero);
        expect(Number(bars[1].getAttribute("y"))).toBeLessThan(zero);
        expect(bars[0].querySelector("title")).toHaveTextContent("-12,3");
    });

    it("blocks mixed-currency charts and requests explicit complete-result pivot dimensions", async () => {
        vi.mocked(apiClient.executeAnalysis).mockResolvedValue({
            ...result,
            rows: [
                { ...result.rows[0], currency: "EUR" },
                { ...result.rows[0], currency: "USD" },
            ],
        } as never);
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await user.click(await screen.findByRole("tab", { name: "Chart" }));
        expect(
            screen.getByText(/single currency and compatible units/),
        ).toBeVisible();
        await user.click(screen.getByRole("tab", { name: "Pivot table" }));
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        const rows = screen.getByText("Rows").closest("fieldset")!;
        await user.click(
            within(rows).getByRole("button", { name: "Add field" }),
        );
        await user.click(
            within(rows).getByRole("button", { name: "Currency" }),
        );
        await user.click(screen.getByRole("button", { name: "Build pivot" }));
        await waitFor(() =>
            expect(analysisApi.executeAnalysisPivot).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    rows: ["category_general", "currency"],
                    columns: ["month"],
                    values: ["sum_spending"],
                }),
                expect.any(String),
            ),
        );
    });

    it("shows saved formula errors with the affected row", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            {
                ...savedChartAnalysis,
                lastResult: {
                    ...result,
                    formulaErrors: [
                        {
                            formulaId: "ratio",
                            rowIndex: 1,
                            code: "DIVIDE_BY_ZERO",
                            message: "Division by zero",
                        },
                    ],
                },
            },
        ] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        expect(
            screen
                .getByText("ratio (row 2): Division by zero")
                .closest('[role="status"]'),
        ).toBeInTheDocument();
    });

    it("keeps SQL aliases that resemble catalog identifiers in result labels", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            {
                ...savedChartAnalysis,
                definition: {
                    source: {
                        kind: "custom-sql",
                        sql: "SELECT amount AS sum_spending",
                        datasets: ["cash-flows"],
                    },
                },
            },
        ] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        expect(
            within(screen.getByRole("tabpanel")).getByRole("button", {
                name: "sum_spending",
            }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        await user.click(screen.getByLabelText("Category / X axis"));
        expect(
            await screen.findByRole("option", { name: "sum_spending" }),
        ).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(
            within(screen.getByRole("tabpanel")).getByRole("checkbox", {
                name: "sum_spending",
            }),
        ).toBeChecked();
    });

    it.each([
        { charts: [], expectedX: "month", expectedY: "sum_spending" },
        {
            charts: [{ kind: "bar", x: "category_general", y: "sum_spending" }],
            expectedX: "category_general",
            expectedY: "sum_spending",
        },
        {
            charts: [{ kind: "bar", x: "removed", y: "month" }],
            expectedX: "month",
            expectedY: "sum_spending",
        },
    ])(
        "restores valid chart bindings with numeric defaults: $expectedX",
        async ({ charts, expectedX, expectedY }) => {
            vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
                { ...savedChartAnalysis, charts },
            ] as never);
            const user = userEvent.setup();
            renderPage();
            await user.click(
                await screen.findByRole("button", { name: "Monthly cashflow" }),
            );
            await user.click(screen.getByRole("tab", { name: "Chart" }));
            expect(
                screen.getByLabelText("Category / X axis"),
            ).toHaveTextContent(
                { month: "Month", category_general: "Category" }[expectedX]!,
            );
            expect(
                within(screen.getByRole("tabpanel")).getByRole("checkbox", {
                    name: "Spending",
                }),
            ).toBeChecked();
            expect(
                within(screen.getByRole("tabpanel")).getByRole("checkbox", {
                    name: "Spending",
                }),
            ).toHaveAttribute("aria-checked", "true");
            expect(expectedY).toBe("sum_spending");
            expect(screen.getByText("12,30")).toBeInTheDocument();
        },
    );

    it("preserves a saved chart binding without cached results through the next run and save", async () => {
        const charts = [
            { kind: "bar", x: "category_general", y: "sum_spending" },
        ];
        const saved = { ...savedChartAnalysis, charts, lastResult: null };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            saved,
        ] as never);
        const update = vi
            .spyOn(apiClient, "updateSavedAnalysis")
            .mockResolvedValue(saved as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        expect(
            screen.getByRole("button", { name: "Save new version" }),
        ).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Run" }));
        await user.click(await screen.findByRole("tab", { name: "Chart" }));
        await waitFor(() =>
            expect(
                screen.getByLabelText("Category / X axis"),
            ).toHaveTextContent("Category"),
        );
        await user.click(
            screen.getByRole("button", { name: "Save new version" }),
        );
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith(
                saved.id,
                expect.objectContaining({
                    charts: [{ ...charts[0], y: [charts[0].y] }],
                }),
            ),
        );
    });

    it("reports refresh failure locally and allows a guarded retry", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
        ] as never);
        let rejectRefresh!: (error: Error) => void;
        const refresh = vi
            .spyOn(apiClient, "runSavedAnalysis")
            .mockReturnValueOnce(
                new Promise((_resolve, reject) => {
                    rejectRefresh = reject;
                }),
            );
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await clickRowAction(user, "Monthly cashflow", "Refresh analysis");
        await openRowMenu(user, "Monthly cashflow");
        const pendingItem = await screen.findByRole("menuitem", {
            name: "Refresh analysis",
        });
        expect(pendingItem).toHaveAttribute("aria-disabled", "true");
        await user.click(pendingItem);
        expect(refresh).toHaveBeenCalledTimes(1);
        await user.keyboard("{Escape}");
        rejectRefresh(new Error("Refresh unavailable"));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Refresh unavailable",
        );
        await expectRowActionIdle(user, "Monthly cashflow", "Refresh analysis");
        refresh.mockResolvedValueOnce(savedChartAnalysis as never);
        await clickRowAction(user, "Monthly cashflow", "Refresh analysis");
        expect(refresh).toHaveBeenCalledTimes(2);
        await waitFor(() =>
            expect(
                screen.queryByText("Refresh unavailable"),
            ).not.toBeInTheDocument(),
        );
        await expectRowActionIdle(user, "Monthly cashflow", "Refresh analysis");
    });

    it("does not replace another opened document when a saved refresh resolves late", async () => {
        const other = {
            ...savedChartAnalysis,
            id: "other",
            name: "Other analysis",
        };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
            other,
        ] as never);
        let resolveRefresh!: (value: never) => void;
        vi.spyOn(apiClient, "runSavedAnalysis").mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await clickRowAction(user, "Monthly cashflow", "Refresh analysis");
        await user.click(
            screen.getByRole("button", { name: "Other analysis" }),
        );
        resolveRefresh({
            ...savedChartAnalysis,
            name: "Late refresh overwrote draft",
        } as never);
        await expectRowActionIdle(user, "Monthly cashflow", "Refresh analysis");
        expect(screen.getByPlaceholderText("Analysis name")).toHaveValue(
            "Other analysis",
        );
        expect(
            screen.queryByDisplayValue("Late refresh overwrote draft"),
        ).not.toBeInTheDocument();
    });

    it("reports a rejected version restore without losing the current document", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            { ...savedChartAnalysis, version: 2 },
        ] as never);
        vi.spyOn(apiClient, "listSavedAnalysisVersions").mockResolvedValue([
            { version: 1 },
            { version: 2 },
        ] as never);
        const restore = vi
            .spyOn(apiClient, "restoreSavedAnalysisVersion")
            .mockRejectedValueOnce(new Error("Restore unavailable"));
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Version history" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Restore version 1" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Restore unavailable",
        );
        expect(restore).toHaveBeenCalledWith(savedChartAnalysis.id, 1, 2);
        expect(screen.getByPlaceholderText("Analysis name")).toHaveValue(
            "Monthly cashflow",
        );
        expect(
            screen.getByRole("button", { name: "Restore version 1" }),
        ).toBeEnabled();
    });

    it("creates a new analysis after deleting the selected saved definition", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
        ] as never);
        vi.spyOn(apiClient, "deleteSavedAnalysis").mockResolvedValue(
            undefined as never,
        );
        const create = vi
            .spyOn(apiClient, "createSavedAnalysis")
            .mockResolvedValue({
                ...savedChartAnalysis,
                id: "new-analysis",
            } as never);
        const update = vi
            .spyOn(apiClient, "updateSavedAnalysis")
            .mockResolvedValue(savedChartAnalysis as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([]);
        await clickRowAction(user, "Monthly cashflow", "Delete analysis");
        const dialog = await screen.findByRole("alertdialog");
        expect(dialog).toHaveTextContent("Delete analysis?");
        await user.click(
            within(dialog).getByRole("button", { name: "Delete" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Save analysis" }),
        );
        await waitFor(() => expect(create).toHaveBeenCalledOnce());
        expect(update).not.toHaveBeenCalled();
    });

    it("ignores query results resolved after opening another saved analysis", async () => {
        const other = {
            ...savedChartAnalysis,
            id: "other",
            name: "Other analysis",
        };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
            other,
        ] as never);
        let resolveRun!: (value: never) => void;
        vi.mocked(apiClient.executeAnalysis).mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRun = resolve;
            }),
        );
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(screen.getByRole("button", { name: "Run" }));
        await user.click(
            screen.getByRole("button", { name: "Other analysis" }),
        );
        resolveRun({
            ...result,
            rows: [
                { ...result.rows[0], category_general: "Stale query output" },
            ],
        } as never);
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Run" })).toBeEnabled(),
        );
        expect(screen.getByPlaceholderText("Analysis name")).toHaveValue(
            "Other analysis",
        );
        expect(
            screen.queryByText("Stale query output"),
        ).not.toBeInTheDocument();
    });

    it("does not retarget a newly opened document when an earlier save completes", async () => {
        const other = {
            ...savedChartAnalysis,
            id: "other",
            name: "Other analysis",
        };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
            other,
        ] as never);
        let resolveSave!: (value: never) => void;
        const update = vi
            .spyOn(apiClient, "updateSavedAnalysis")
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveSave = resolve;
                }),
            )
            .mockResolvedValue(other as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Save new version" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Other analysis" }),
        );
        resolveSave({ ...savedChartAnalysis, version: 2 } as never);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Save new version" }),
            ).toBeEnabled(),
        );
        expect(screen.getByPlaceholderText("Analysis name")).toHaveValue(
            "Other analysis",
        );
        await user.click(
            screen.getByRole("button", { name: "Save new version" }),
        );
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        expect(update.mock.calls[1][0]).toBe("other");
    });

    it("preserves a name edited while its saved refresh is pending", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
        ] as never);
        let resolveRefresh!: (value: never) => void;
        vi.spyOn(apiClient, "runSavedAnalysis").mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await clickRowAction(user, "Monthly cashflow", "Refresh analysis");
        const name = screen.getByPlaceholderText("Analysis name");
        await user.clear(name);
        await user.type(name, "My edited draft");
        resolveRefresh({
            ...savedChartAnalysis,
            name: "Server result",
            lastResult: {
                ...result,
                rows: [
                    { ...result.rows[0], category_general: "Refreshed output" },
                ],
            },
        } as never);
        await expectRowActionIdle(user, "Monthly cashflow", "Refresh analysis");
        expect(name).toHaveValue("My edited draft");
        expect(screen.queryByText("Refreshed output")).not.toBeInTheDocument();
    });

    it("ignores version history resolved after opening another saved analysis", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
            { ...savedChartAnalysis, id: "other", name: "Other analysis" },
        ] as never);
        let resolveHistory!: (value: never) => void;
        vi.spyOn(apiClient, "listSavedAnalysisVersions").mockReturnValue(
            new Promise((resolve) => {
                resolveHistory = resolve;
            }),
        );
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Version history" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Other analysis" }),
        );
        resolveHistory([{ version: 99 }] as never);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Version history" }),
            ).toBeEnabled(),
        );
        expect(
            screen.queryByRole("button", { name: /restore.*99/i }),
        ).not.toBeInTheDocument();
    });

    it("explains empty version history and reports failed history requests", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
        ] as never);
        const history = vi
            .spyOn(apiClient, "listSavedAnalysisVersions")
            .mockResolvedValue([{ version: 1 }] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Version history" }),
        );
        expect(
            await screen.findByText(/No earlier versions/),
        ).toHaveTextContent("No earlier versions");
        history.mockRejectedValueOnce(new Error("History unavailable"));
        await user.click(
            screen.getByRole("button", { name: "Version history" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "History unavailable",
        );
    });

    it("labels visual filters and grouping without changing query identifiers", async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        expect(screen.getAllByRole("checkbox", { name: "Month" })).toHaveLength(
            2,
        );
        expect(
            screen.getAllByRole("checkbox", { name: "Category" }),
        ).toHaveLength(2);
        const operator = screen.getByRole("combobox", {
            name: "Filter 1: operator for Transfer",
        });
        expect(operator).toHaveTextContent("Equals");
        expect(
            screen.getByRole("textbox", {
                name: "Filter 1: value for Transfer",
            }),
        ).toHaveValue("false");
        await pickOption(user, operator, "Does not equal");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() =>
            expect(apiClient.executeAnalysis).toHaveBeenCalledWith(
                expect.objectContaining({
                    plan: expect.objectContaining({
                        filters: expect.arrayContaining([
                            expect.objectContaining({
                                fieldId: "is_transfer",
                                operator: "neq",
                                value: false,
                            }),
                        ]),
                    }),
                }),
            ),
        );
        await user.click(
            screen.getByRole("button", { name: "Remove filter 1: Transfer" }),
        );
        expect(
            screen.queryByRole("textbox", {
                name: "Filter 1: value for Transfer",
            }),
        ).not.toBeInTheDocument();
    });

    it("runs a visual plan, shows its SQL, and validates SQL parameters locally", async () => {
        const user = userEvent.setup();
        renderPage();

        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));

        await waitFor(() =>
            expect(apiClient.executeAnalysis).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: "visual",
                    plan: expect.objectContaining({
                        datasetId: "cash-flows",
                        measures: ["sum_spending"],
                    }),
                }),
            ),
        );
        expect((await screen.findAllByText("Food")).length).toBeGreaterThan(0);
        expect(
            screen.getByText(/FROM vision_analysis\.cash_flows_v1/),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("radio", { name: "SQL editor" }));
        fireEvent.change(screen.getByLabelText("Typed SQL parameters"), {
            target: { value: "not-json" },
        });
        await user.click(screen.getByRole("button", { name: "Run" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "SQL parameters must be a JSON array",
        );
        expect(apiClient.executeAnalysis).toHaveBeenCalledTimes(1);
    });

    it("applies a guided template as an editable ordinary analysis", async () => {
        const user = userEvent.setup();
        renderPage();

        await screen.findByText("Cash flows");
        await user.click(
            screen.getByRole("button", { name: /Category spending/ }),
        );
        const chooser = screen
            .getByRole("button", { name: /Category spending/, hidden: true })
            .closest("details")!;
        expect(chooser).not.toHaveAttribute("open");
        expect(screen.getByText("Edit configuration")).toHaveFocus();
        const editor = screen
            .getByText("Edit configuration")
            .closest("details")!;
        expect(editor).not.toHaveAttribute("open");
        expect(screen.getByLabelText("Dataset")).not.toBeVisible();
        expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
        await user.click(screen.getByText("Edit configuration"));
        expect(editor).toHaveAttribute("open");
        const nameInput = screen.getByLabelText("Analysis name");
        await user.clear(nameInput);
        await user.type(nameInput, "My edited analysis");
        await user.click(chooser.querySelector("summary")!);
        expect(chooser).toHaveAttribute("open");
        expect(nameInput).toHaveValue("My edited analysis");
        await user.click(screen.getByRole("button", { name: "Run" }));

        await waitFor(() =>
            expect(apiClient.executeAnalysis).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: "visual",
                    plan: expect.objectContaining({
                        datasetId: "cash-flows",
                        fields: ["month", "category_general", "currency"],
                        measures: ["sum_spending"],
                    }),
                }),
            ),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { name: /^Present/ }),
            ).toHaveFocus(),
        );
    });

    it("reveals template configuration after a failed run", async () => {
        const user = userEvent.setup();
        vi.mocked(apiClient.executeAnalysis).mockRejectedValueOnce(
            new Error("Invalid configuration"),
        );
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: /Category spending/ }),
        );
        const editor = screen
            .getByText("Edit configuration")
            .closest("details")!;
        expect(editor).not.toHaveAttribute("open");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await screen.findByRole("alert");
        expect(editor).toHaveAttribute("open");
    });

    it("restores saved output ordering when reopening and running an analysis", async () => {
        const user = userEvent.setup();
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            {
                id: "sorted-analysis",
                definitionId: "analysis:sorted",
                name: "Newest months first",
                workspace: "budgeting",
                version: 1,
                refreshMode: "live",
                parameters: {},
                charts: [],
                sourceReferences: [],
                refreshStatus: "never-run",
                lastResult: null,
                definition: {
                    source: {
                        kind: "visual-plan",
                        datasetId: "cash-flows",
                        select: [
                            { id: "month", source: { kind: "field" } },
                            { id: "sum_spending", source: { kind: "metric" } },
                        ],
                        groupBy: ["month"],
                        orderBy: [{ outputId: "month", direction: "desc" }],
                        filters: [],
                        joins: [],
                        limit: 500,
                    },
                },
            },
        ] as never);
        vi.spyOn(apiClient, "listSavedAnalysisVersions").mockResolvedValue([]);
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Newest months first" }),
        );
        expect(
            screen
                .getByRole("button", {
                    name: /Category spending/,
                    hidden: true,
                })
                .closest("details"),
        ).not.toHaveAttribute("open");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() =>
            expect(apiClient.executeAnalysis).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: "visual",
                    plan: expect.objectContaining({
                        orderBy: [{ id: "month", direction: "desc" }],
                    }),
                }),
            ),
        );
    });

    it("collapses the blank-start chooser and keeps the editor mode explicit", async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByText("Cash flows");
        const blank = screen.getByRole("button", { name: "Start blank" });
        const chooser = blank.closest("details")!;
        await user.click(blank);
        expect(chooser).not.toHaveAttribute("open");
        expect(screen.getByText("Edit configuration")).toHaveFocus();
        expect(screen.getByLabelText("Analysis name")).toHaveValue("");
        expect(
            screen.getByRole("radio", { name: "Visual builder" }),
        ).toBeChecked();
    });

    it("persists an explicit no-benchmark override", async () => {
        const user = userEvent.setup();
        const create = vi
            .spyOn(apiClient, "createSavedAnalysis")
            .mockResolvedValue({
                id: "saved-1",
                definitionId: "analysis:saved-1",
                name: "No benchmark",
                workspace: "budgeting",
                version: 1,
                refreshMode: "live",
                parameters: { benchmark: null },
                charts: [],
                sourceReferences: [],
                refreshStatus: "never-run",
                lastSuccessfulRunId: null,
                lastError: null,
                definition: {},
                lastResult: result,
                createdAt: "2026-09-14T10:00:00Z",
                updatedAt: "2026-09-14T10:00:00Z",
            } as never);
        renderPage();

        await screen.findByText("Cash flows");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await screen.findAllByText("Food");
        await user.type(
            screen.getByPlaceholderText("Analysis name"),
            "No benchmark",
        );
        await user.click(screen.getByText("Run preferences"));
        await user.click(
            screen.getByRole("checkbox", {
                name: "Use no benchmark for this analysis",
            }),
        );
        await user.click(screen.getByRole("button", { name: "Save analysis" }));

        await waitFor(() =>
            expect(create).toHaveBeenCalledWith(
                expect.objectContaining({
                    parameters: expect.objectContaining({ benchmark: null }),
                }),
            ),
        );
    });

    it("keeps export metadata bound to the result-producing run", async () => {
        const user = userEvent.setup();
        renderPage();

        await screen.findByText("Cash flows");
        const nameInput = screen.getByPlaceholderText("Analysis name");
        await user.type(nameInput, "Original scope");
        await user.click(screen.getByRole("button", { name: "Run" }));
        await screen.findAllByText("Food");
        await user.clear(nameInput);
        await user.type(nameInput, "Changed after run");
        await user.click(screen.getByText("Export and scenario files"));
        await user.click(
            screen.getByRole("button", { name: "Export safe CSV" }),
        );

        expect(downloadBlob).toHaveBeenCalledWith(
            expect.any(Blob),
            "original-scope.csv",
        );
    });
    it("restores and saves multiple chart series, pivot axes and repeatable workbench configuration", async () => {
        const chart = { kind: "line", x: "month", y: ["sum_spending", "net"] };
        const pivotConfig = {
            rows: ["category_general", "currency"],
            columns: ["month"],
            values: ["sum_spending"],
            filters: [],
        };
        const workbench = {
            steps: [
                {
                    type: "convert",
                    columnId: "sum_spending",
                    targetType: "decimal",
                    onError: "null",
                },
            ],
            time: {
                bucket: "month",
                dateColumn: "month",
                valueColumns: ["sum_spending"],
                groupColumns: ["currency"],
                missing: "null",
                rollingWindow: 3,
                aggregation: "sum",
            },
            scenarios: [
                {
                    id: "base",
                    name: "Base scenario",
                    assumptions: { rate: "0.1" },
                },
            ],
        };
        const saved = {
            ...savedChartAnalysis,
            charts: [chart],
            parameters: {
                pivotConfig,
                workbench,
                formulaModel: {
                    formulas: [
                        {
                            id: "savings_rate",
                            label: "Savings rate",
                            expression: "row.net / row.sum_spending",
                            scope: "row",
                        },
                    ],
                    assumptions: [
                        { id: "rate", label: "Rate", defaultValue: "0.1" },
                    ],
                    assumptionValues: { rate: "0.2" },
                },
            },
            lastResult: {
                ...result,
                columns: [...result.columns, { id: "net", type: "decimal" }],
                rows: [{ ...result.rows[0], net: "2.3" }],
            },
        };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            saved,
        ] as never);
        const update = vi
            .spyOn(apiClient, "updateSavedAnalysis")
            .mockResolvedValue(saved as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        const chartPanel = within(screen.getByRole("tabpanel"));
        expect(chartPanel.getByRole("radio", { name: "Line" })).toBeChecked();
        expect(
            chartPanel.getByRole("checkbox", { name: "Spending" }),
        ).toBeChecked();
        expect(chartPanel.getByRole("checkbox", { name: "net" })).toBeChecked();
        await user.click(screen.getByRole("tab", { name: "Pivot table" }));
        expect(
            within(screen.getByText("Rows").closest("fieldset")!).getByRole(
                "button",
                { name: "Remove Currency" },
            ),
        ).toBeInTheDocument();
        if (
            screen
                .getByRole("button", { name: /Savings rate/ })
                .getAttribute("aria-expanded") !== "true"
        ) {
            await user.click(
                screen.getByRole("button", { name: /Savings rate/ }),
            );
        }
        expect(screen.getByLabelText("Expression")).toHaveValue(
            "row.net / row.sum_spending",
        );
        await user.click(
            screen.getByRole("button", { name: "Save new version" }),
        );
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith(
                saved.id,
                expect.objectContaining({
                    charts: [chart],
                    parameters: expect.objectContaining({
                        pivotConfig,
                        workbench,
                    }),
                    formulas: saved.parameters.formulaModel.formulas,
                    assumptions: saved.parameters.formulaModel.assumptions,
                    assumptionValues: { rate: "0.2" },
                }),
            ),
        );
        await user.click(
            screen.getByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        expect(
            within(screen.getByRole("tabpanel")).getByRole("radio", {
                name: "Line",
            }),
        ).toBeChecked();
    });
    it("runs fresh analysis with structured formulas, numeric assumptions and pipeline configuration", async () => {
        const saved = {
            ...savedChartAnalysis,
            parameters: {
                formulaModel: {
                    formulas: [
                        {
                            id: "total",
                            label: "Total",
                            expression: "SUM(row.sum_spending)",
                            scope: "summary",
                        },
                    ],
                    assumptions: [
                        { id: "rate", label: "Rate", defaultValue: "0.1" },
                    ],
                    assumptionValues: { rate: "0.2" },
                },
                workbench: { steps: [] },
            },
        };
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            saved,
        ] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        expect(
            screen.queryByLabelText("Formulas JSON"),
        ).not.toBeInTheDocument();
        await user.click(screen.getByText("Refine this analysis"));
        if (
            screen
                .getByRole("button", { name: /^Total/ })
                .getAttribute("aria-expanded") !== "true"
        ) {
            await user.click(screen.getByRole("button", { name: /^Total/ }));
        }
        await user.clear(screen.getByLabelText("Expression"));
        await user.type(
            screen.getByLabelText("Expression"),
            "SUM(row.sum_spending) * assumption.rate",
        );
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() =>
            expect(apiClient.executeAnalysis).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    formulaModel: {
                        formulas: [
                            expect.objectContaining({
                                expression:
                                    "SUM(row.sum_spending) * assumption.rate",
                            }),
                        ],
                        assumptions: saved.parameters.formulaModel.assumptions,
                        assumptionValues: { rate: "0.2" },
                    },
                    workbench: { steps: [] },
                }),
            ),
        );
    });
    it("requires a fresh run before exporting a cached saved result and blocks exports after calculation edits", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            savedChartAnalysis,
        ] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(screen.getByText("Export and scenario files"));
        expect(
            screen.getByRole("button", { name: "Export safe CSV" }),
        ).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Run" }));
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Export safe CSV" }),
            ).toBeEnabled(),
        );
        await user.click(screen.getByText("Refine this analysis"));
        await user.click(screen.getByRole("button", { name: "Add formula" }));
        expect(
            screen.getByRole("button", { name: "Export safe CSV" }),
        ).toBeDisabled();
    });
    it("replaces a saved currency-code series with a numeric chart value", async () => {
        vi.mocked(apiClient.listSavedAnalyses).mockResolvedValue([
            {
                ...savedChartAnalysis,
                charts: [{ kind: "bar", x: "month", y: ["currency"] }],
                lastResult: {
                    ...result,
                    columns: [
                        { id: "currency", type: "currency" },
                        ...result.columns,
                    ],
                    rows: result.rows.map((row) => ({
                        ...row,
                        currency: "EUR",
                    })),
                },
            },
        ] as never);
        const user = userEvent.setup();
        renderPage();
        await user.click(
            await screen.findByRole("button", { name: "Monthly cashflow" }),
        );
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        expect(
            within(screen.getByRole("tabpanel")).getByRole("checkbox", {
                name: "Spending",
            }),
        ).toBeChecked();
        expect(
            within(screen.getByRole("tabpanel")).queryByRole("checkbox", {
                name: "Currency",
            }),
        ).not.toBeInTheDocument();
    });
});

it("keeps transient malformed calculation inputs in a safe stale-result signature", () => {
    const inputs = {
        formulasJson: "[]",
        assumptionsJson: "[]",
        assumptionValuesJson: "{}",
        workbench: {},
        scenarioModel: { attachments: [], joins: [] },
    };
    const completed = analysisDraftSignature(inputs);
    for (const field of [
        "formulasJson",
        "assumptionsJson",
        "assumptionValuesJson",
    ] as const) {
        expect(() =>
            analysisDraftSignature({ ...inputs, [field]: "[" }),
        ).not.toThrow();
        expect(analysisDraftSignature({ ...inputs, [field]: "[" })).not.toBe(
            completed,
        );
    }
    expect(analysisDraftSignature({ ...inputs, formulasJson: "[ ]" })).toBe(
        completed,
    );
});
