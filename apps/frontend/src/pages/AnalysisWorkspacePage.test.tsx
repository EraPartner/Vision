// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { apiClient } from "@/lib/api";
import AnalysisWorkspacePage from "@/pages/AnalysisWorkspacePage";

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: en } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string) => en[key] ?? key,
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

describe("AnalysisWorkspacePage", () => {
    beforeEach(() => {
        vi.spyOn(apiClient, "getAnalysisCatalog").mockResolvedValue(
            catalog as never,
        );
        vi.spyOn(apiClient, "listSavedAnalyses").mockResolvedValue([]);
        vi.spyOn(apiClient, "executeAnalysis").mockResolvedValue(
            result as never,
        );
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
});
