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
afterEach(() => {
    server.resetHandlers();
    vi.unstubAllGlobals();
});
/** The `PUT /api/settings/:key` body (`settingsRepository.replace`). */
const saved = (key: string, value: unknown) => ({
    key,
    value,
    expected: { exists: true, value },
});
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
                return ok(saved("theme", "light"));
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
                return ok(saved("a/b", 2));
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
                return ok(saved("x", body.value));
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
    it("rejects a settings read without its baselines", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ settings: { theme: "dark" } }),
            ),
        );
        await expect(settings.getSettings()).rejects.toMatchObject({
            name: "ApiContractError",
            endpoint: "GET /api/settings",
        });
    });

    it("advances only an explicit native ACK and a later read cannot rewind it", async () => {
        vi.stubGlobal("window", {
            __VISION_NATIVE_SETTINGS__: true,
            location: { origin: API_BASE },
        });
        const old = { language: "en", future: null };
        const acknowledged = { language: "nl", future: null };
        server.use(
            http.get(`${API_BASE}/api/settings/:key`, () =>
                ok(saved("app_settings", old)),
            ),
        );
        await settings.getSetting("app_settings");
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "app_settings",
                acknowledged,
                undefined,
            ),
        ).toBe(false);
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "app_settings",
                acknowledged,
                { exists: false },
            ),
        ).toBe(false);
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "app_settings",
                acknowledged,
                { exists: true, value: old },
            ),
        ).toBe(false);
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "app_settings",
                acknowledged,
                { exists: true, value: { future: null, language: "nl" } },
            ),
        ).toBe(true);
        await settings.getSetting("app_settings");
        let body;
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
                body = await request.json();
                return ok(saved("app_settings", old));
            }),
        );
        await settings.saveSetting("app_settings", old);
        expect(body).toEqual({
            value: old,
            expected: { exists: true, value: acknowledged },
        });
    });

    it("native ACKs cannot authorize another key or clear a rejected lane", async () => {
        vi.stubGlobal("window", {
            __VISION_NATIVE_SETTINGS__: true,
            location: { origin: API_BASE },
        });
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "onboarding_complete",
                true,
                { exists: true, value: true },
            ),
        ).toBe(false);
        await expect(
            settings.saveSetting("onboarding_complete", false),
        ).rejects.toThrow("not loaded");
        server.use(
            http.get(`${API_BASE}/api/settings/:key`, () =>
                ok(saved("app_settings", {})),
            ),
        );
        await settings.getSetting("app_settings");
        let writes = 0;
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, () => {
                writes++;
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
        await expect(
            settings.saveSetting("app_settings", { language: "nl" }),
        ).rejects.toThrow("Settings changed");
        expect(
            settings.acknowledgeNativeSettingReceipt(
                "app_settings",
                { language: "en" },
                { exists: true, value: { language: "en" } },
            ),
        ).toBe(true);
        await expect(
            settings.saveSetting("app_settings", { language: "nl" }),
        ).rejects.toThrow("Settings changed");
        expect(writes).toBe(1);
    });
});

describe("atomic settings groups", () => {
    it("serializes overlapping single and grouped writes with acknowledged baselines", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ settings: {}, expected: {} }),
            ),
        );
        await settings.getSettings();
        const bodies: unknown[] = [];
        server.use(
            http.put(
                `${API_BASE}/api/settings/:key`,
                async ({ request, params }) => {
                    const body = (await request.json()) as { value: unknown };
                    bodies.push(body);
                    return ok(saved(String(params.key), body.value));
                },
            ),
            http.put(`${API_BASE}/api/settings`, async ({ request }) => {
                bodies.push(await request.json());
                return ok({ saved: 2 });
            }),
        );
        await Promise.all([
            settings.saveSetting("profile", 1),
            settings.saveSettings({ profile: 2, snapshot: 2 }),
            settings.saveSetting("snapshot", 3),
        ]);
        expect(bodies).toEqual([
            { value: 1, expected: { exists: false } },
            {
                settings: { profile: 2, snapshot: 2 },
                expected: {
                    profile: { exists: true, value: 1 },
                    snapshot: { exists: false },
                },
            },
            { value: 3, expected: { exists: true, value: 2 } },
        ]);
    });
    it("does not bless new baselines or allow a partial followup after group conflict", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ settings: {}, expected: {} }),
            ),
        );
        await settings.getSettings();
        let writes = 0;
        server.use(
            http.put(`${API_BASE}/api/settings`, () => {
                writes++;
                return HttpResponse.json(
                    {
                        ok: false,
                        error: { message: "conflict", code: "CONFLICT" },
                    },
                    { status: 409 },
                );
            }),
        );
        await expect(
            settings.saveSettings({ profile: 1, snapshot: 1 }),
        ).rejects.toThrow();
        await settings.getSettings();
        await expect(settings.saveSetting("snapshot", 2)).rejects.toThrow();
        expect(writes).toBe(1);
    });
});
