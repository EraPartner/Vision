// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
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

/** Raw chart response — component reads res.json() directly (no envelope). */
const CHART_RESPONSE = {
  symbol: "AAPL",
  currency: "USD",
  points: [
    { time: 1700000000000, close: 190 },
    { time: 1700086400000, close: 192 },
  ],
};

/** Raw quote response — component reads data.quotes?.[0]. */
const QUOTE_RESPONSE = {
  quotes: [{ symbol: "AAPL", price: 195.5, change: 1.2, changePercent: 0.6 }],
};

function setupDefaultChartHandlers() {
  server.use(
    http.get(`${API_BASE}/api/market/chart`, () =>
      HttpResponse.json(CHART_RESPONSE),
    ),
    http.get(`${API_BASE}/api/market/quote`, () =>
      HttpResponse.json(QUOTE_RESPONSE),
    ),
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
      http.get(`${API_BASE}/api/market/chart`, () =>
        HttpResponse.json({ symbol: "AAPL", currency: "USD", points: [] }),
      ),
      http.get(`${API_BASE}/api/market/quote`, () =>
        HttpResponse.json(QUOTE_RESPONSE),
      ),
    );
    const onOpenChange = vi.fn();
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={onOpenChange} />,
    );

    // Assert — no-data message appears when points array is empty
    expect(await screen.findByText(/no chart data/i)).toBeInTheDocument();
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
        return HttpResponse.json({ symbol: "AAPL", currency: "USD", points: [] });
      }),
      http.get(`${API_BASE}/api/market/quote`, () =>
        HttpResponse.json(QUOTE_RESPONSE),
      ),
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
      http.get(`${API_BASE}/api/market/chart`, () =>
        HttpResponse.json({ symbol: "AAPL", currency: "USD", points: [] }),
      ),
      http.get(`${API_BASE}/api/market/quote`, () =>
        HttpResponse.json(QUOTE_RESPONSE),
      ),
      http.patch(`${API_BASE}/api/watchlist/1`, async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({ ok: true });
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
      http.get(`${API_BASE}/api/watchlist/:id/chart`, () =>
        err(500, "history unavailable"),
      ),
      http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [] })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithApp(
      <WatchlistChartDialog item={ITEM} open={true} onOpenChange={vi.fn()} />,
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
