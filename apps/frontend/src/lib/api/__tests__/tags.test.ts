// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getTags, createTag, updateTag, deleteTag, bulkTagTransactions } from "@/lib/api/tags";

afterEach(() => server.resetHandlers());

describe("tags API client", () => {
  it("getTags forwards is_active/limit as query params and unwraps the envelope", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/tags`, ({ request }) => {
        url = request.url;
        return ok({ items: [{ id: 1, slug: "groceries" }], total: 1, limit: 25, offset: 0 });
      }),
    );

    const res = await getTags({ is_active: true, limit: 25 });

    expect(url).toContain("is_active=true");
    expect(url).toContain("limit=25");
    expect(res.items[0].slug).toBe("groceries");
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
