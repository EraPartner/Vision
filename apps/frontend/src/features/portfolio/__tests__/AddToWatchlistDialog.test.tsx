// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { AddToWatchlistDialog } from "@/features/portfolio/AddToWatchlistDialog";

const API_BASE = "http://localhost:3002";

const MARKET_SEARCH_RESULT = {
  symbol: "AAPL",
  name: "Apple Inc.",
  type: "stock",
  exchange: "NASDAQ",
};

const WATCHLIST_STUB = {
  id: 1,
  symbol: "AAPL",
  name: "Apple Inc.",
  asset_class: "stock",
  currency: "USD",
  target_price: 200,
  notes: null,
  price_provider_id: "AAPL",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: null,
};

afterEach(() => vi.restoreAllMocks());

describe("AddToWatchlistDialog", () => {
  it("renders dialog when open=true", async () => {
    // Arrange + Act
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Assert — dialog content is present
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("close button calls onOpenChange(false)", async () => {
    // Arrange
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);
    await screen.findByRole("dialog");

    // Act — click the dialog close button (radix renders it with aria-label "Close")
    const closeButton = screen.getByRole("button", { name: /close/i });
    await user.click(closeButton);

    // Assert
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("search input is visible and typing triggers search results display", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");

    // Assert — search result appears
    expect(await screen.findByText("AAPL")).toBeInTheDocument();
    expect(await screen.findByText("Apple Inc.")).toBeInTheDocument();
  });

  it("clicking a search result transitions to details phase (shows targetPrice input)", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — type to trigger search, then click result
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    const result = await screen.findByText("Apple Inc.");
    await user.click(result);

    // Assert — details phase: target price input is present
    expect(await screen.findByLabelText(/target buy price/i)).toBeInTheDocument();
  });

  it("submit button is disabled when targetPrice is empty", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — reach details phase without filling targetPrice
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    await user.click(await screen.findByText("Apple Inc."));

    // Assert — wait for details phase, then check submit is disabled
    await screen.findByLabelText(/target buy price/i);
    const submitButton = await screen.findByRole("button", { name: /add to watchlist/i });
    expect(submitButton).toBeDisabled();
  });

  it("successful submit calls POST /api/watchlist and calls onOpenChange(false)", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
      http.post(`${API_BASE}/api/watchlist`, () => ok(WATCHLIST_STUB)),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — search, select, fill target price, submit
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    await user.click(await screen.findByText("Apple Inc."));

    const targetPriceInput = await screen.findByLabelText(/target buy price/i);
    await user.type(targetPriceInput, "200");

    const submitButton = await screen.findByRole("button", { name: /add to watchlist/i });
    await user.click(submitButton);

    // Assert
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("API failure does not call onOpenChange(false)", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
      http.post(`${API_BASE}/api/watchlist`, () =>
        err(500, "Internal server error"),
      ),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — search, select, fill target price, submit
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    await user.click(await screen.findByText("Apple Inc."));

    const targetPriceInput = await screen.findByLabelText(/target buy price/i);
    await user.type(targetPriceInput, "200");

    const submitButton = await screen.findByRole("button", { name: /add to watchlist/i });
    await user.click(submitButton);

    // Assert — onOpenChange(false) is NOT called after error
    await waitFor(() => expect(submitButton).not.toBeDisabled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("rejects a 0 target price — no POST, dialog stays open (regression)", async () => {
    // parseDecimal's 0-fallback used to POST target_price: 0 for garbage
    // input like "1e999"; a 0/non-finite target must now be rejected.
    let posted = false;
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
      http.post(`${API_BASE}/api/watchlist`, () => {
        posted = true;
        return ok(WATCHLIST_STUB);
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — search, select, set a 0 target price (paste-equivalent), submit
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    await user.click(await screen.findByText("Apple Inc."));

    const targetPriceInput = await screen.findByLabelText(/target buy price/i);
    fireEvent.change(targetPriceInput, { target: { value: "0" } });

    const submitButton = await screen.findByRole("button", { name: /add to watchlist/i });
    await user.click(submitButton);

    // Assert — dialog stays open, no POST sent
    await waitFor(() => expect(submitButton).not.toBeDisabled());
    expect(posted).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("back navigation from phase 2 returns to phase 1 (search input visible)", async () => {
    // Arrange
    server.use(
      http.get(`${API_BASE}/api/market/search`, () =>
        ok({ items: [MARKET_SEARCH_RESULT] }),
      ),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);

    // Act — reach details phase, then click "Change" button to go back
    const searchInput = await screen.findByRole("textbox");
    await user.type(searchInput, "AAPL");
    await user.click(await screen.findByText("Apple Inc."));
    await screen.findByLabelText(/target buy price/i); // wait for phase 2

    const changeButton = await screen.findByRole("button", { name: /change/i });
    await user.click(changeButton);

    // Assert — back to search phase: textbox (search input) is visible again
    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByLabelText(/target buy price/i)).not.toBeInTheDocument();
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  it("Escape key calls onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("dialog renders in open state (a11y / backdrop guard)", async () => {
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-state", "open");
  });

  it("first focusable element is reachable by Tab (keyboard nav)", async () => {
    const user = userEvent.setup();
    renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={vi.fn()} />);
    await screen.findByRole("dialog");
    // Auto-focus is on the search input; one Tab moves to next focusable.
    await user.tab();
    expect(document.activeElement).toBeDefined();
    expect(document.activeElement?.tagName).toMatch(/INPUT|BUTTON|SELECT|TEXTAREA/i);
  });
});
