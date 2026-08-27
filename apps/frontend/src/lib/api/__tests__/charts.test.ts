// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getSavedCharts, createSavedChart, updateSavedChart, deleteSavedChart } from "@/lib/api/charts";

afterEach(() => server.resetHandlers());

describe("saved charts API client", () => {
  it("getSavedCharts fetches the list", async () => {
    server.use(http.get(`${API_BASE}/api/saved-charts`, () => ok({ items: [{ id: 1, name: "C" }], total: 1 })));
    expect((await getSavedCharts())[0].id).toBe(1);
  });

  it("createSavedChart POSTs the payload", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/saved-charts`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 2, name: "New" });
      }),
    );
    await createSavedChart({ name: "New" } as never);
    expect(body).toMatchObject({ name: "New" });
  });

  it("updateSavedChart PATCHes by id", async () => {
    server.use(http.patch(`${API_BASE}/api/saved-charts/2`, () => ok({ id: 2, name: "E" })));
    expect((await updateSavedChart(2, { name: "E" })).name).toBe("E");
  });

  it("deleteSavedChart resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/saved-charts/2`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteSavedChart(2)).resolves.toBeUndefined();
  });
});
