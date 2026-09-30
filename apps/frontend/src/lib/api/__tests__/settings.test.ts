// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
let settings: typeof import("@/lib/api/settings");
beforeEach(async () => {
    vi.resetModules();
    settings = await import("@/lib/api/settings");
});
afterEach(() => server.resetHandlers());
describe("settings conditional API client", () => {
    it("loads values and persisted baselines together", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({
                    settings: { theme: "dark" },
                    expected: { theme: { exists: true, value: "dark" } },
                }),
            ),
        );
        expect((await settings.getSettings()).theme).toBe("dark");
        let body;
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
                body = await request.json();
                return ok({ key: "theme", value: "light" });
            }),
        );
        await settings.saveSetting("theme", "light");
        expect(body).toEqual({
            value: "light",
            expected: { exists: true, value: "dark" },
        });
    });
    it("URL-encodes keys and sends the raw persisted baseline, not display defaults", async () => {
        let url = "";
        let body;
        server.use(
            http.get(`${API_BASE}/api/settings/:key`, ({ request }) => {
                url = request.url;
                return ok({
                    key: "a/b",
                    value: 1,
                    expected: { exists: false },
                });
            }),
        );
        await settings.getSetting("a/b");
        expect(url).toContain("a%2Fb");
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
                body = await request.json();
                return ok({ key: "a/b", value: 2 });
            }),
        );
        await settings.saveSetting("a/b", 2);
        expect(body).toEqual({ value: 2, expected: { exists: false } });
    });
    it("fails closed when preload never succeeded", async () => {
        await expect(settings.saveSetting("app_settings", {})).rejects.toThrow(
            "not loaded",
        );
    });
    it("serializes rapid saves and advances only acknowledged baselines", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/:key`, () =>
                ok({
                    key: "x",
                    value: {},
                    expected: { exists: true, value: {} },
                }),
            ),
        );
        await settings.getSetting("x");
        const bodies: unknown[] = [];
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
                const body = (await request.json()) as { value: unknown };
                bodies.push(body);
                return ok({ key: "x", value: body.value });
            }),
        );
        await Promise.all([
            settings.saveSetting("x", { a: 1 }),
            settings.saveSetting("x", { a: 1, b: 2 }),
        ]);
        expect(bodies).toEqual([
            { value: { a: 1 }, expected: { exists: true, value: {} } },
            {
                value: { a: 1, b: 2 },
                expected: { exists: true, value: { a: 1 } },
            },
        ]);
    });
    it("blocks further saves after conflict, even if a background read sees new state", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/:key`, () =>
                ok({
                    key: "x",
                    value: {},
                    expected: { exists: true, value: {} },
                }),
            ),
        );
        await settings.getSetting("x");
        let calls = 0;
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, () => {
                calls++;
                return HttpResponse.json(
                    {
                        ok: false,
                        error: {
                            code: "CONFLICT",
                            message: "Settings changed",
                        },
                    },
                    { status: 409 },
                );
            }),
        );
        await expect(settings.saveSetting("x", { a: 1 })).rejects.toThrow(
            "Settings changed",
        );
        await settings.getSetting("x");
        await expect(settings.saveSetting("x", { b: 2 })).rejects.toThrow(
            "Settings changed",
        );
        expect(calls).toBe(1);
    });
});
