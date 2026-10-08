// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import { CATEGORY_STUB } from "@/test/msw/handlers";
import { ApiContractError } from "@/lib/api/client";

import { getCategories, getCategoryTree, createCategory, updateCategory, deleteCategory } from "@/lib/api/categories";

afterEach(() => server.resetHandlers());

describe("categories API client", () => {
  it("getCategories forwards filter params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/categories`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0, links: [] });
      }),
    );
    await getCategories({ general: "FOOD", search: "x", active: true });
    expect(url).toContain("general=FOOD");
    expect(url).toContain("search=x");
    expect(url).toContain("active=true");
  });

  it("getCategories accepts the backend row shape, extra columns included", async () => {
    const row = { ...CATEGORY_STUB, path_name: "FOOD:GROCERIES" };
    server.use(http.get(`${API_BASE}/api/categories`, () => ok({ items: [row], total: 1, links: [] })));
    expect((await getCategories()).items).toEqual([row]);
  });

  it("getCategories rejects a drifted row in strict mode", async () => {
    server.use(
      http.get(`${API_BASE}/api/categories`, () =>
        ok({ items: [{ ...CATEGORY_STUB, is_active: "true" }], total: 1, links: [] }),
      ),
    );
    await expect(getCategories()).rejects.toThrow(ApiContractError);
    await expect(getCategories()).rejects.toThrow("items[0].is_active");
  });

  it("getCategoryTree validates tree nodes", async () => {
    const node = {
      id: 2,
      name: "GROCERIES",
      parentId: 1,
      pathIds: [1, 2],
      path: ["FOOD", "GROCERIES"],
      category_name: "FOOD:GROCERIES",
      depth: 2,
      description: null,
      is_active: true,
      hierarchyOnly: false,
      legacyCompatible: true,
    };
    server.use(http.get(`${API_BASE}/api/categories/tree`, () => ok({ items: [node], total: 1 })));
    expect((await getCategoryTree()).items).toEqual([node]);

    server.use(
      http.get(`${API_BASE}/api/categories/tree`, () => ok({ items: [{ ...node, pathIds: "1,2" }], total: 1 })),
    );
    await expect(getCategoryTree()).rejects.toThrow("items[0].pathIds");
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
