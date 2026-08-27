// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getSettings, getSetting, saveSetting } from "@/lib/api/settings";

afterEach(() => server.resetHandlers());

describe("settings API client", () => {
  it("getSettings fetches the settings map", async () => {
    server.use(http.get(`${API_BASE}/api/settings`, () => ok({ theme: "dark" })));
    expect((await getSettings()).theme).toBe("dark");
  });

  it("getSetting URL-encodes the key", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/settings/:key`, ({ request }) => {
        url = request.url;
        return ok({ key: "a/b", value: 1 });
      }),
    );
    await getSetting("a/b");
    expect(url).toContain("a%2Fb");
  });

  it("saveSetting PUTs the wrapped value", async () => {
    let body: unknown = null;
    server.use(
      http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
        body = await request.json();
        return ok({ key: "theme", value: "light" });
      }),
    );
    await saveSetting("theme", "light");
    expect(body).toMatchObject({ value: "light" });
  });

});
