// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getCategories, createCategory, updateCategory, deleteCategory } from "@/lib/api/categories";

afterEach(() => server.resetHandlers());

describe("categories API client", () => {
  it("getCategories forwards filter params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/categories`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getCategories({ general: "FOOD", search: "x", active: true });
    expect(url).toContain("general=FOOD");
    expect(url).toContain("search=x");
    expect(url).toContain("active=true");
  });

  it("createCategory reports wasCreated from the 201 status", async () => {
    server.use(
      http.post(`${API_BASE}/api/categories`, () => ok({ id: 9 }, { status: 201 })),
    );
    const res = await createCategory({ general: "FOOD" } as never);
    expect(res.category.id).toBe(9);
    expect(res.wasCreated).toBe(true);
  });

  it("updateCategory PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/categories/9`, () => ok({ id: 9 })));
    expect((await updateCategory(9, {} as never)).id).toBe(9);
  });

  it("deleteCategory resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/categories/9`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteCategory(9)).resolves.toBeUndefined();
  });
});
