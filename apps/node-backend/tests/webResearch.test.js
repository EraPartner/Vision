import { describe, expect, it, vi } from "vitest";
import {
  __assertPublicResearchQuery,
  searchPublicWeb,
  fetchPublicWebPage,
} from "../src/services/webResearch.js";

describe("controlled web research", () => {
  it("blocks private financial patterns before a provider call", () => {
    expect(() =>
      __assertPublicResearchQuery("Explain account BE68539007547034"),
    ).toThrow(/private financial data/);
  });
  it("reports hard local quota exhaustion without issuing a request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      searchPublicWeb(
        { query: "Belgian inflation outlook" },
        {
          enabled: true,
          apiKey: "synthetic",
          reserve: async () => null,
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ code: "SEARCH_QUOTA_EXHAUSTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds and normalizes synthetic search results without persisting them", async () => {
    const payload = JSON.stringify({
      web: {
        results: [
          {
            title: "Public source",
            url: "https://example.org/report",
            description: "A dated public result",
            page_age: "2026-09-01",
          },
        ],
      },
    });
    const result = await searchPublicWeb(
      { query: "Belgian inflation outlook", count: 1 },
      {
        enabled: true,
        apiKey: "synthetic",
        reserve: async () => 1,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          body: null,
          arrayBuffer: async () => new TextEncoder().encode(payload).buffer,
        }),
      },
    );
    expect(result.results[0]).toMatchObject({
      url: "https://example.org/report",
      trust: "untrusted-evidence",
    });
    expect(result.meta).toMatchObject({ persisted: false, requestCount: 1 });
  });
  it("revalidates redirects and marks fetched text as untrusted evidence", async () => {
    const assertUrl = vi.fn(async (url) => new URL(url));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({ location: "https://example.org/final" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        body: null,
        arrayBuffer: async () =>
          new TextEncoder().encode("<title>Source</title><p>Evidence</p>")
            .buffer,
      });
    const result = await fetchPublicWebPage(
      { url: "https://example.com" },
      { enabled: true, assertUrl, fetchImpl },
    );
    expect(assertUrl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      title: "Source",
      trust: "untrusted-evidence",
      instructionPolicy: "never-execute",
    });
  });
});
