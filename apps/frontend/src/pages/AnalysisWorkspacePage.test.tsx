// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { apiClient } from "@/lib/api";
import { downloadBlob } from "@/lib/downloadBlob";
import AnalysisWorkspacePage from "@/pages/AnalysisWorkspacePage";

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
        expect(
            screen.getAllByRole("option", { name: "Uitgaven" }),
        ).toHaveLength(2);
        expect(screen.getByLabelText(nl["analysis.chartValue"])).toHaveValue(
            "sum_spending",
        );
        await user.click(
            screen.getByRole("tab", { name: nl["analysis.pivot"] }),
        );
        expect(screen.getByText(nl["analysis.pivotHelp"])).toBeInTheDocument();
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
            screen.queryByLabelText("Category axis"),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        await user.selectOptions(
            screen.getByLabelText("Category axis"),
            "category_general",
        );
        await user.click(table);
        expect(
            screen.queryByLabelText("Category axis"),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        expect(screen.getByLabelText("Category axis")).toHaveValue(
            "category_general",
        );
        await user.click(
            screen.getByRole("button", { name: "Remove filter 1: Transfer" }),
        );
        expect(await screen.findByText(/Results need updating/)).toBeVisible();
    });

    it("charts every returned row and puts negative values left of zero", async () => {
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
        expect(screen.getByText("period-31")).toBeVisible();
        expect(screen.queryByText("period-32")).not.toBeInTheDocument();
        expect(container.querySelectorAll("[data-sign]")).toHaveLength(31);
        expect(container.querySelector('[data-sign="negative"]')).toHaveStyle({
            right: "50%",
            width: "50%",
        });
        expect(container.querySelector('[data-sign="positive"]')).toHaveStyle({
            left: "50%",
            width: "50%",
        });
    });

    it("does not compare unconverted currencies on one chart or collapse a third pivot group", async () => {
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
        expect(screen.getByText(/Filter to one currency/)).toBeVisible();
        await user.click(screen.getByRole("tab", { name: "Pivot table" }));
        expect(screen.getByText(/exactly two groups/)).toBeVisible();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
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
        expect(screen.getByRole("alert")).toHaveTextContent(
            "ratio (row 2): Division by zero",
        );
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
            screen.getByRole("button", { name: "sum_spending" }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Chart" }));
        expect(
            screen.getAllByRole("option", { name: "sum_spending" }),
        ).toHaveLength(2);
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
            expect(screen.getByLabelText("Category axis")).toHaveValue(
                expectedX,
            );
            expect(screen.getByLabelText("Value axis")).toHaveValue(expectedY);
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
            expect(screen.getByLabelText("Category axis")).toHaveValue(
                "category_general",
            ),
        );
        await user.click(
            screen.getByRole("button", { name: "Save new version" }),
        );
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith(
                saved.id,
                expect.objectContaining({ charts }),
            ),
        );
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
        expect(await screen.findByRole("status")).toHaveTextContent(
            "No earlier versions",
        );
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
        expect(operator).toHaveValue("eq");
        expect(operator).toHaveTextContent("Equals");
        expect(operator).toHaveTextContent("Does not equal");
        expect(
            screen.getByRole("textbox", {
                name: "Filter 1: value for Transfer",
            }),
        ).toHaveValue("false");
        await user.selectOptions(operator, "neq");
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

        await user.click(screen.getByText("Advanced controls"));
        await user.click(screen.getByRole("button", { name: "SQL editor" }));
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
            screen.getByRole("button", { name: "Visual builder" }),
        ).toHaveAttribute("aria-pressed", "true");
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
});
