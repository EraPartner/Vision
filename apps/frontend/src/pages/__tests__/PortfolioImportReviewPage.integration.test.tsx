// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { PortfolioImportReviewPage } from "@/pages/portfolio/PortfolioImportReviewPage";

vi.mock("@tanstack/react-virtual", () => ({
  useWindowVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => count > 0 ? [{ index: 0, start: 0, end: 38, key: 0 }] : [],
    getTotalSize: () => count * 38,
    measureElement: vi.fn(),
    measure: vi.fn(),
  }),
}));

vi.mock("@/features/portfolio/InvestmentCombobox", () => ({
  InvestmentCombobox: ({ onSelect, disabled }: {
    onSelect: (id: number) => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect(42)}>
      Choose existing holding
    </button>
  ),
}));

const API_BASE = "http://localhost:3002";

const preview = {
  batch_id: 5,
  groups: [{
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
  }],
  totals: { symbol: 0, name_exact: 0, unresolved: 3, error: 0 },
};

function renderReviewPage() {
  return renderWithApp(
    <Routes>
      <Route path="/portfolio/import/review/:batchId" element={<PortfolioImportReviewPage />} />
    </Routes>,
    { initialEntries: ["/portfolio/import/review/5"] },
  );
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

describe("PortfolioImportReviewPage group resolution", () => {
  it("selects an existing holding with one request for every row id", async () => {
    const user = userEvent.setup();
    const rowIds = Array.from({ length: 2_000 }, (_, index) => index + 1);
    const largePreview = {
      ...preview,
      groups: [{
        ...preview.groups[0],
        row_count: rowIds.length,
        rows: rowIds.map((id, index) => ({ ...preview.groups[0].rows[0], id, row_index: index })),
      }],
      totals: { ...preview.totals, unresolved: rowIds.length },
    };
    let requests = 0;
    let body: unknown = null;
    server.use(
      http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () => ok(largePreview)),
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
        async ({ request }) => {
          requests += 1;
          body = await request.json();
          return ok({ investment_id: 42, created: false, resolved: rowIds.length });
        },
      ),
    );

    renderReviewPage();
    await user.click(await screen.findByRole("button", { name: "Choose existing holding" }));

    expect(requests).toBe(1);
    expect(body).toEqual({ row_ids: rowIds, investment_id: 42 });
  });

  it("creates one holding for the complete row set with one request", async () => {
    const user = userEvent.setup();
    let requests = 0;
    let body: unknown = null;
    server.use(
      http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () => ok(preview)),
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
        async ({ request }) => {
          requests += 1;
          body = await request.json();
          return ok({ investment_id: 43, created: true, resolved: 3 });
        },
      ),
    );

    renderReviewPage();
    await user.click(await screen.findByRole("button", { name: /create new/i }));

    expect(requests).toBe(1);
    expect(body).toEqual({ row_ids: [10, 11, 12], create_new: true });
  });
});
