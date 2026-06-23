// @vitest-environment node
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import {
  searchResearch,
  getResearchQuote,
  getResearchChart,
  resolveResearchMappings,
} from "@/lib/api/research";

const API_BASE = "http://localhost:3002";

/** Research envelope: standard ADR-026 success + provenance meta. */
function research<T>(data: T, meta: { provider: string | null; source: string }) {
  return HttpResponse.json({ ok: true, data, meta });
}

describe("research API client", () => {
  it("preserves meta.provider and meta.source on a live response", async () => {
    server.use(
      http.get(`${API_BASE}/api/research/search`, () =>
        research({ items: [{ symbol: "AAPL", name: "Apple Inc.", type: "EQUITY", exchange: "NASDAQ" }] },
          { provider: "yahoo", source: "live" }),
      ),
    );

    const result = await searchResearch("apple");

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].symbol).toBe("AAPL");
    expect(result.meta.provider).toBe("yahoo");
    expect(result.meta.source).toBe("live");
  });

  it("surfaces source='unavailable' with the empty shape", async () => {
    server.use(
      http.get(`${API_BASE}/api/research/chart`, () =>
        research({ points: [] }, { provider: null, source: "unavailable" }),
      ),
    );

    const result = await getResearchChart("XYZ", "1mo");

    expect(result.data.points).toEqual([]);
    expect(result.meta.source).toBe("unavailable");
    expect(result.meta.provider).toBeNull();
  });

  it("returns null data for an unavailable quote", async () => {
    server.use(
      http.get(`${API_BASE}/api/research/quote`, () =>
        research(null, { provider: null, source: "unavailable" }),
      ),
    );

    const result = await getResearchQuote("XYZ");

    expect(result.data).toBeNull();
    expect(result.meta.source).toBe("unavailable");
  });

  it("normalizes a missing meta to source='unavailable'", async () => {
    server.use(
      http.get(`${API_BASE}/api/research/quote`, () =>
        HttpResponse.json({ ok: true, data: null }),
      ),
    );

    const result = await getResearchQuote("XYZ");

    expect(result.meta.source).toBe("unavailable");
    expect(result.meta.provider).toBeNull();
  });

  it("POSTs the resolve body and returns proposals + meta", async () => {
    let captured: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/research/mappings/resolve`, async ({ request }) => {
        captured = await request.json();
        return research(
          {
            instrument_key: "US0378331005",
            key_type: "isin",
            proposals: [{ provider: "yahoo", status: "auto", providerSymbol: "AAPL", resolvedName: "Apple Inc.", exchange: "NASDAQ" }],
            existing: [],
          },
          { provider: null, source: "live" },
        );
      }),
    );

    const result = await resolveResearchMappings({
      instrument_key: "US0378331005",
      key_type: "isin",
      query: "apple",
    });

    expect(captured).toMatchObject({ instrument_key: "US0378331005", query: "apple" });
    expect(result.data.proposals[0].providerSymbol).toBe("AAPL");
  });
});
