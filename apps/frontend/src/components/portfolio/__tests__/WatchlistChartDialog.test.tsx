// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { WatchlistChartDialog } from "@/components/portfolio/WatchlistChartDialog";
import type { WatchlistItem } from "@/types/watchlist";

const API_BASE = "http://localhost:3002";

const ITEM: WatchlistItem = {
  id: 1,
  symbol: "AAPL",
  name: "Apple Inc.",
  asset_class: "stock",
  currency: "USD",
  target_price: 200,
  notes: null,
  price_provider_id: "AAPL",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

/** Chart data payload — wrapped in the ADR-026 success envelope by `ok()`,
 *  matching the real /api/market/chart response the component unwraps. */
const CHART_RESPONSE = {
  symbol: "AAPL",
  currency: "USD",
  items: [
    { time: 1700000000000, close: 190 },
    { time: 1700086400000, close: 192 },
  ],
  total: 2,
};

/** Quote data payload — wrapped in the ADR-026 success envelope by `ok()`. */
const QUOTE_RESPONSE = {
  items: [{ symbol: "AAPL", price: 195.5, change: 1.2, changePercent: 0.6 }],
  total: 1,
};

function setupDefaultChartHandlers() {
  server.use(
    http.get(`${API_BASE}/api/market/chart`, () => ok(CHART_RESPONSE)),
    http.get(`${API_BASE}/api/market/quote`, () => ok(QUOTE_RESPONSE)),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("WatchlistChartDialog", () => {
  it("renders null when item is null", () => {
    // Arrange + Act
    const onOpenChange = vi.fn();
    const { container } = renderWithApp(
      <WatchlistChartDialog item={null} open={true} onOpenChange={onOpenChange} />,
    );

    // Assert — nothing is rendered
    expect(container).toBeEmptyDOMElement();
  });

  it("renders dialog with item name when open=true and item is non-null", async () => {
    // Arrange
    setupDefaultChartHandlers();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );

    // Assert — dialog title shows item name (use heading role to avoid sr-only duplicate)
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Apple Inc." })).toBeInTheDocument();
  });

  it("fetches chart data on open and displays chart or no-data message", async () => {
    // Arrange — empty chart data
    server.use(
      http.get(`${API_BASE}/api/market/chart`, () => ok({ symbol: "AAPL", currency: "USD", items: [], total: 0 })),
      http.get(`${API_BASE}/api/market/quote`, () => ok(QUOTE_RESPONSE)),
    );
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );

    // Assert — no-data message appears when points array is empty
    expect(await screen.findByText(/no chart data/i)).toBeInTheDocument();
  });

  it("unwraps the API envelope so chart points and live quote render (regression)", async () => {
    // Regression guard for the envelope bug: the market endpoints return
    // { ok, data: { items, total } }. Reading res.json() directly (the old
    // raw-fetch path) left the rows undefined — empty chart + no price.
    // Arrange — realistic enveloped responses with non-empty data.
    setupDefaultChartHandlers();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Assert — live quote (195.5) is unwrapped from data.items[0] and rendered
    // (locale-tolerant on the decimal separator); not the loading skeleton.
    expect(await screen.findByText(/195[.,]5/)).toBeInTheDocument();
    // Assert — chart points are unwrapped from data.items, so the empty-state
    // fallback must not appear.
    expect(screen.queryByText(/no chart data/i)).not.toBeInTheDocument();
  });

  it("range buttons are all visible (1M, 3M, 6M, 1Y, 5Y)", async () => {
    // Arrange
    setupDefaultChartHandlers();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );
    await screen.findByRole("dialog");

    // Assert — all five range buttons are present
    for (const label of ["1M", "3M", "6M", "1Y", "5Y"]) {
      expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("clicking a range button triggers a new chart fetch with the new range param", async () => {
    // Arrange
    let capturedRange: string | null = null;
    server.use(
      http.get(`${API_BASE}/api/market/chart`, ({ request }) => {
        const url = new URL(request.url);
        capturedRange = url.searchParams.get("range");
        return ok({ symbol: "AAPL", currency: "USD", items: [], total: 0 });
      }),
      http.get(`${API_BASE}/api/market/quote`, () => ok(QUOTE_RESPONSE)),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );

    // Wait for initial render and first fetch (1M = 1mo)
    await screen.findByRole("dialog");
    await waitFor(() => expect(capturedRange).toBe("1mo"));

    // Act — click "1Y" range button
    capturedRange = null;
    await user.click(await screen.findByRole("button", { name: "1Y" }));

    // Assert — chart re-fetched with 1y range
    await waitFor(() => expect(capturedRange).toBe("1y"));
  });

  it("can update target price — fill input, click save, PATCH /api/watchlist/:id", async () => {
    // Arrange
    let patchBody: unknown = null;
    server.use(
      http.get(`${API_BASE}/api/market/chart`, () => ok({ symbol: "AAPL", currency: "USD", items: [], total: 0 })),
      http.get(`${API_BASE}/api/market/quote`, () => ok(QUOTE_RESPONSE)),
      http.patch(`${API_BASE}/api/watchlist/1`, async ({ request }) => {
        patchBody = await request.json();
        return ok({ ...ITEM, target_price: 210 });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );
    await screen.findByRole("dialog");

    // Act — click the target price display to enter edit mode
    const targetPriceButton = await screen.findByRole("button", { name: /200/i });
    await user.click(targetPriceButton);

    // Fill in the new price
    const priceInput = await screen.findByRole("spinbutton");
    await user.clear(priceInput);
    await user.type(priceInput, "210");

    // Click the confirm/save button (icon-only Check button, before the Cancel button)
    // The edit row contains: [input] [check-button] [cancel-button]
    const editContainer = priceInput.closest("div") as HTMLElement;
    const editButtons = editContainer.querySelectorAll("button");
    // First button in the edit row is the Check/save button
    await user.click(editButtons[0] as HTMLButtonElement);

    // Assert — PATCH was called with the new target price
    await waitFor(() =>
      expect(patchBody).toMatchObject({ target_price: 210 }),
    );
  });

  it("rejects a 0 target price — no PATCH, validation toast (regression)", async () => {
    // parseDecimal's 0-fallback used to let garbage input PATCH target_price: 0
    // with a success toast. A 0 target must now be rejected client-side.
    let patched = false;
    server.use(
      http.get(`${API_BASE}/api/market/chart`, () => ok({ symbol: "AAPL", currency: "USD", items: [], total: 0 })),
      http.get(`${API_BASE}/api/market/quote`, () => ok(QUOTE_RESPONSE)),
      http.patch(`${API_BASE}/api/watchlist/1`, () => {
        patched = true;
        return ok(ITEM);
      }),
    );
    const user = userEvent.setup();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Act — enter edit mode and set the price to 0 (paste-equivalent)
    await user.click(await screen.findByRole("button", { name: /200/i }));
    const priceInput = await screen.findByRole("spinbutton");
    fireEvent.change(priceInput, { target: { value: "0" } });

    const editContainer = priceInput.closest("div") as HTMLElement;
    const editButtons = editContainer.querySelectorAll("button");
    await user.click(editButtons[0] as HTMLButtonElement);

    // Assert — edit mode stays open (success path would close it) and no PATCH sent
    await waitFor(() => expect(screen.getByRole("spinbutton")).toBeInTheDocument());
    expect(patched).toBe(false);
  });

  it("close button calls onOpenChange(false)", async () => {
    // Arrange
    setupDefaultChartHandlers();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );
    await screen.findByRole("dialog");

    // Act
    const closeButton = screen.getByRole("button", { name: /close/i });
    await user.click(closeButton);

    // Assert
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  it("Escape key calls onOpenChange(false)", async () => {
    setupDefaultChartHandlers();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("dialog renders in open state (a11y / backdrop guard)", async () => {
    setupDefaultChartHandlers();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={vi.fn()} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-state", "open");
  });

  it("renders gracefully when chart history API returns 5xx error", async () => {
    server.use(
      http.get(`${API_BASE}/api/market/chart`, () => err(500, "history unavailable")),
      http.get(`${API_BASE}/api/market/quote`, () => ok({ items: [], total: 0 })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={vi.fn()} />,
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
