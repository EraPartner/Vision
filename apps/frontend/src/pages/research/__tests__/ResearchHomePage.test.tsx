// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import ResearchHomePage from "@/pages/research/ResearchHomePage";

const API_BASE = "http://localhost:3002";

function research<T>(data: T, meta: { provider: string | null; source: string }) {
  return HttpResponse.json({ ok: true, data, meta });
}

describe("ResearchHomePage", () => {
  it("renders the research heading and search box", async () => {
    server.use(http.get(`${API_BASE}/api/watchlist`, () => ok({ items: [] })));
    renderWithApp(<ResearchHomePage />);
    expect(await screen.findByRole("heading", { name: /research/i })).toBeInTheDocument();
    expect(await screen.findByLabelText(/search any stock/i)).toBeInTheDocument();
  });

  it("shows search results from the research API", async () => {
    server.use(
      http.get(`${API_BASE}/api/watchlist`, () => ok({ items: [] })),
      http.get(`${API_BASE}/api/research/search`, () =>
        research({ items: [{ symbol: "AAPL", name: "Apple Inc.", type: "EQUITY", exchange: "NASDAQ" }] },
          { provider: "yahoo", source: "live" }),
      ),
    );
    const user = userEvent.setup();
    renderWithApp(<ResearchHomePage />);

    await user.type(await screen.findByLabelText(/search any stock/i), "apple");
    expect(await screen.findByText("Apple Inc.")).toBeInTheDocument();
  });

  it("surfaces 'live data unavailable' when the search source is unavailable", async () => {
    server.use(
      http.get(`${API_BASE}/api/watchlist`, () => ok({ items: [] })),
      http.get(`${API_BASE}/api/research/search`, () =>
        research({ items: [] }, { provider: null, source: "unavailable" }),
      ),
    );
    const user = userEvent.setup();
    renderWithApp(<ResearchHomePage />);

    await user.type(await screen.findByLabelText(/search any stock/i), "apple");
    expect(await screen.findByText(/live data unavailable/i)).toBeInTheDocument();
  });
});
