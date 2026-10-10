// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getTags, createTag, updateTag, deleteTag, bulkTagTransactions } from "@/lib/api/tags";

afterEach(() => server.resetHandlers());

describe("tags API client", () => {
  const TAG_ROW = {
    id: 1,
    slug: "groceries",
    color: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  it("getTags forwards the filter and limit as query params and unwraps the envelope", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/tags`, ({ request }) => {
        url = request.url;
        return ok({ items: [TAG_ROW], total: 1, limit: 25, offset: 0, links: [] });
      }),
    );

    const res = await getTags({ is_active: true, limit: 25 });

    expect(url).toContain("limit=25");
    expect(res.items[0].slug).toBe("groceries");
  });

  // Regression: GET /api/tags reads `?active=` (routes/tags.ts, activeOrAllQuery)
  // and ignores unknown keys, so the `is_active` the client used to send was a
  // no-op: `{ is_active: false }` still listed the active tags.
  it.each([
    [true, "true"],
    [false, "false"],
  ])("getTags sends is_active=%s as the route's active=%s", async (isActive, expected) => {
    let query = new URLSearchParams();
    server.use(
      http.get(`${API_BASE}/api/tags`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return ok({ items: [], total: 0, links: [] });
      }),
    );

    await getTags({ is_active: isActive });

    expect(query.get("active")).toBe(expected);
    expect(query.has("is_active")).toBe(false);
  });

  it("getTags sends no filter when none is given (the route then lists active tags)", async () => {
    let query = new URLSearchParams("x=1");
    server.use(
      http.get(`${API_BASE}/api/tags`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return ok({ items: [], total: 0, links: [] });
      }),
    );

    await getTags();

    expect([...query.keys()]).toEqual([]);
  });

  it("getTags rejects a tag row that breaks the response contract", async () => {
    server.use(
      http.get(`${API_BASE}/api/tags`, () =>
        ok({ items: [{ ...TAG_ROW, is_active: "yes" }], total: 1, links: [] }),
      ),
    );

    await expect(getTags()).rejects.toMatchObject({
      name: "ApiContractError",
      endpoint: "GET /api/tags",
    });
  });

  it("createTag POSTs the body and returns the created tag", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/tags`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 7, slug: "rent" });
      }),
    );

    const tag = await createTag({ slug: "rent" });

    expect(body).toMatchObject({ slug: "rent" });
    expect(tag.id).toBe(7);
  });

  it("updateTag PATCHes by id", async () => {
    server.use(
      http.patch(`${API_BASE}/api/tags/7`, () => ok({ id: 7, slug: "rent", color: "#fff" })),
    );
    const tag = await updateTag(7, { color: "#fff" });
    expect(tag.color).toBe("#fff");
  });

  // Soft delete: the backend answers 200 with the deactivated tag, which this
  // client intentionally discards.
  it("deleteTag resolves on the deactivated-tag response", async () => {
    server.use(
      http.delete(`${API_BASE}/api/tags/7`, () =>
        ok({ id: 7, name: "T", is_active: false, links: [] }),
      ),
    );
    await expect(deleteTag(7)).resolves.toBeUndefined();
  });

  it("bulkTagTransactions POSTs to the bulk endpoint", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/transactions/bulk-tag`, async ({ request }) => {
        body = await request.json();
        return ok({ added: 3, removed: 0, transactions_affected: 3 });
      }),
    );

    const result = await bulkTagTransactions({
      transaction_ids: [1, 2, 3],
      add_slugs: ["rent"],
    });

    expect(body).toMatchObject({ transaction_ids: [1, 2, 3], add_slugs: ["rent"] });
    expect(result.added).toBe(3);
  });
});
