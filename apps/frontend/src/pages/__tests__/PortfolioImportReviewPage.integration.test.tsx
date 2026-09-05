// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { PortfolioImportReviewPage } from "@/pages/portfolio/PortfolioImportReviewPage";

const { useWindowVirtualizerMock } = vi.hoisted(() => ({
    useWindowVirtualizerMock: vi.fn(({ count }: { count: number }) => {
        const indexes = count > 1 ? [0, count - 1] : count === 1 ? [0] : [];
        return {
            getVirtualItems: () =>
                indexes.map((index) => ({
                    index,
                    start: index * 38,
                    end: (index + 1) * 38,
                    key: index,
                })),
            getTotalSize: () => count * 38,
            measureElement: vi.fn(),
            measure: vi.fn(),
        };
    }),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useWindowVirtualizer: useWindowVirtualizerMock,
}));

vi.mock("@/features/portfolio/InvestmentCombobox", () => ({
    InvestmentCombobox: ({
        onSelect,
        disabled,
    }: {
        onSelect: (id: number) => void;
        disabled?: boolean;
    }) => (
        <button type="button" disabled={disabled} onClick={() => onSelect(42)}>
            Choose existing holding
        </button>
    ),
}));

vi.mock("@/features/transactions/components/AccountFilterCombobox", () => ({
    AccountFilterCombobox: ({
        onChange,
    }: {
        onChange: (selection: { id: number; label: string }) => void;
    }) => (
        <button
            type="button"
            onClick={() => onChange({ id: 77, label: "Broker cash" })}
        >
            Choose cash account
        </button>
    ),
}));

const API_BASE = "http://localhost:3002";

const preview = {
    batch_id: 5,
    groups: [
        {
            is_cash: false,
            investment_id: null,
            investment_name: null,
            investment_symbol: null,
            investment_asset_class: null,
            raw_symbol: "VWCE",
            raw_name: "Vanguard FTSE All-World",
            row_count: 3,
            rows: [10, 11, 12].map((id, index) => ({
                id,
                row_index: index,
                status: "matched",
                route: "portfolio",
                tx_date: "2026-01-01",
                type: "buy",
                type_raw: "Buy",
                symbol_raw: "VWCE",
                name_raw: "Vanguard FTSE All-World",
                units: 1,
                price_per_unit: 100,
                amount: 100,
                fees: 0,
                taxes: 0,
                currency: "EUR",
                fx_rate_to_eur: 1,
                note: null,
                match_source: "unresolved",
                error_message: null,
                user_override_investment_id: null,
            })),
        },
    ],
    totals: { symbol: 0, name_exact: 0, unresolved: 3, error: 0 },
};

function renderReviewPage() {
    return renderWithApp(
        <Routes>
            <Route
                path="/portfolio/import/:batchId/review"
                element={<PortfolioImportReviewPage />}
            />
            <Route
                path="/portfolio"
                element={<div>Portfolio destination</div>}
            />
        </Routes>,
        { initialEntries: ["/portfolio/import/5/review"] },
    );
}

beforeAll(() => {
    class ResizeObserverStub {
        observe() {}
        disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

beforeEach(() => {
    useWindowVirtualizerMock.mockClear();
});

describe("PortfolioImportReviewPage group resolution", () => {
    it("renders only the preview rows selected by the window virtualizer", async () => {
        const rows = preview.groups[0].rows.map((row, index) => ({
            ...row,
            tx_date: `2026-01-0${index + 1}`,
        }));
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok({
                    ...preview,
                    groups: [{ ...preview.groups[0], rows }],
                }),
            ),
        );

        renderReviewPage();

        expect(await screen.findByText("2026-01-01")).toBeInTheDocument();
        expect(screen.getByText("2026-01-03")).toBeInTheDocument();
        expect(screen.queryByText("2026-01-02")).not.toBeInTheDocument();
        expect(useWindowVirtualizerMock).toHaveBeenCalledWith(
            expect.objectContaining({
                count: 3,
                overscan: 8,
            }),
        );
    });

    it("selects an existing holding with one request for every row id", async () => {
        const user = userEvent.setup();
        const rowIds = Array.from({ length: 2_000 }, (_, index) => index + 1);
        const largePreview = {
            ...preview,
            groups: [
                {
                    ...preview.groups[0],
                    row_count: rowIds.length,
                    rows: rowIds.map((id, index) => ({
                        ...preview.groups[0].rows[0],
                        id,
                        row_index: index,
                    })),
                },
            ],
            totals: { ...preview.totals, unresolved: rowIds.length },
        };
        let requests = 0;
        let body: unknown = null;
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok(largePreview),
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
                async ({ request }) => {
                    requests += 1;
                    body = await request.json();
                    return ok({
                        investment_id: 42,
                        created: false,
                        resolved: rowIds.length,
                    });
                },
            ),
        );

        renderReviewPage();
        await user.click(
            await screen.findByRole("button", {
                name: "Choose existing holding",
            }),
        );

        expect(requests).toBe(1);
        expect(body).toEqual({ row_ids: rowIds, investment_id: 42 });
    });

    it("creates one holding for the complete row set with one request", async () => {
        const user = userEvent.setup();
        let requests = 0;
        let body: unknown = null;
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok(preview),
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
                async ({ request }) => {
                    requests += 1;
                    body = await request.json();
                    return ok({
                        investment_id: 43,
                        created: true,
                        resolved: 3,
                    });
                },
            ),
        );

        renderReviewPage();
        await user.click(
            await screen.findByRole("button", { name: /create new/i }),
        );

        expect(requests).toBe(1);
        expect(body).toEqual({ row_ids: [10, 11, 12], create_new: true });
    });

    it("commits the batch once and navigates to the portfolio", async () => {
        const user = userEvent.setup();
        let requests = 0;
        let body: unknown = null;
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok(preview),
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/commit`,
                async ({ request }) => {
                    requests += 1;
                    body = await request.json();
                    return ok({
                        batch_id: 5,
                        imported: 3,
                        duplicates: 0,
                        errors: 0,
                    });
                },
            ),
        );

        renderReviewPage();
        await user.click(
            await screen.findByRole("button", { name: "Confirm import" }),
        );

        expect(
            await screen.findByText("Portfolio destination"),
        ).toBeInTheDocument();
        expect(requests).toBe(1);
        expect(body).toEqual({});
    });

    it("requires and submits an account to repair a missing-account cash row", async () => {
        const user = userEvent.setup();
        let body: unknown = null;
        const cashRow = {
            ...preview.groups[0].rows[0],
            id: 90,
            status: "error",
            route: "cash",
            error_message: "brokerage cash row requires a batch account",
        };
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok({
                    ...preview,
                    groups: [
                        {
                            ...preview.groups[0],
                            is_cash: true,
                            investment_id: null,
                            row_count: 1,
                            rows: [cashRow],
                        },
                    ],
                    totals: {
                        symbol: 0,
                        name_exact: 0,
                        unresolved: 0,
                        error: 1,
                    },
                }),
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/commit`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        batch_id: 5,
                        imported: 1,
                        duplicates: 0,
                        errors: 0,
                    });
                },
            ),
        );

        renderReviewPage();
        const commitButton = await screen.findByRole("button", {
            name: "Confirm import",
        });
        expect(commitButton).toBeDisabled();

        await user.click(
            screen.getByRole("button", { name: "Choose cash account" }),
        );
        expect(commitButton).toBeEnabled();
        await user.click(commitButton);

        expect(
            await screen.findByText("Portfolio destination"),
        ).toBeInTheDocument();
        expect(body).toEqual({ account_id: 77 });
    });
});
