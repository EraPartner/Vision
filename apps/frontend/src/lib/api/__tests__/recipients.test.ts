// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getRecipients, getRecipient, createRecipient, updateRecipient, deleteRecipient, mergeRecipients, unmergeRecipient, listRecipientPatterns, createRecipientPattern, updateRecipientPattern, deleteRecipientPattern, previewRecipientPattern } from "@/lib/api/recipients";

afterEach(() => server.resetHandlers());

describe("recipients API client", () => {
  it("getRecipients forwards search/sort params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/recipients`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getRecipients({ search: "acme", sort_by: "name", sort_dir: "desc", uncategorized: true });
    expect(url).toContain("search=acme");
    expect(url).toContain("sort_by=name");
    expect(url).toContain("sort_dir=desc");
    expect(url).toContain("uncategorized=true");
  });

  it("getRecipient fetches by id", async () => {
    server.use(http.get(`${API_BASE}/api/recipients/3`, () => ok({ id: 3, name: "Acme" })));
    expect((await getRecipient(3)).name).toBe("Acme");
  });

  it("createRecipient reports wasCreated=true on 201", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients`, () => ok({ id: 9, name: "New" }, { status: 201 })),
    );
    const res = await createRecipient({ name: "New" } as never);
    expect(res.recipient.id).toBe(9);
    expect(res.wasCreated).toBe(true);
  });

  it("createRecipient reports wasCreated=false on 200 (existing)", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients`, () => ok({ id: 9, name: "Existing" }, { status: 200 })),
    );
    const res = await createRecipient({ name: "Existing" } as never);
    expect(res.wasCreated).toBe(false);
  });

  it("updateRecipient PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/recipients/9`, () => ok({ id: 9, name: "E" })));
    expect((await updateRecipient(9, {} as never)).name).toBe("E");
  });

  it("deleteRecipient resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/recipients/9`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteRecipient(9)).resolves.toBeUndefined();
  });

  it("mergeRecipients posts alias_ids", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/recipients/1/merge`, async ({ request }) => {
        body = await request.json();
        return ok({ primary: { id: 1 }, merged_ids: [2, 3], aliases: [], patternSuggestion: null });
      }),
    );
    const res = await mergeRecipients(1, [2, 3]);
    expect(body).toMatchObject({ alias_ids: [2, 3] });
    expect(res.merged_ids).toEqual([2, 3]);
  });

  it("unmergeRecipient POSTs to the unmerge route", async () => {
    server.use(http.post(`${API_BASE}/api/recipients/5/unmerge`, () => ok({ id: 5 })));
    expect((await unmergeRecipient(5)).id).toBe(5);
  });

  it("listRecipientPatterns fetches patterns", async () => {
    server.use(http.get(`${API_BASE}/api/recipients/5/patterns`, () => ok({ items: [], total: 0 })));
    expect((await listRecipientPatterns(5)).items).toEqual([]);
  });

  it("createRecipientPattern posts the pattern body", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/recipients/5/patterns`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 77 });
      }),
    );
    const res = await createRecipientPattern(5, { pattern: "ACME*", pattern_kind: "glob" });
    expect(body).toMatchObject({ pattern: "ACME*", pattern_kind: "glob" });
    expect(res.id).toBe(77);
  });

  it("updateRecipientPattern PATCHes by pattern id", async () => {
    server.use(
      http.patch(`${API_BASE}/api/recipients/5/patterns/77`, () => ok({ patternId: 77 })),
    );
    expect((await updateRecipientPattern(5, 77, { priority: 2 })).patternId).toBe(77);
  });

  it("deleteRecipientPattern DELETEs by pattern id and resolves on 204", async () => {
    let hit = 0;
    server.use(
      http.delete(`${API_BASE}/api/recipients/5/patterns/77`, () => {
        hit += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    // Hard delete → 204 No Content, so there is no body to unwrap.
    await expect(deleteRecipientPattern(5, 77)).resolves.toBeUndefined();
    expect(hit).toBe(1);
  });

  it("previewRecipientPattern posts and returns match counts", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients/5/patterns/preview`, () =>
        ok({ matchCount: 4, recipientIds: [1, 2, 3, 4] }),
      ),
    );
    const res = await previewRecipientPattern(5, { pattern: "X*", pattern_kind: "glob" });
    expect(res.matchCount).toBe(4);
  });

});
