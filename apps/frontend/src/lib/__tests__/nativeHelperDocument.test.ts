// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import type { ExchangeRatesData } from "@/lib/api/info";
import {
    activity,
    household,
    partner,
} from "@/lib/belgianTax/__tests__/testHousehold";
import {
    startNativeHelperDocument,
    type NativeHelperDocument,
    type NativeHelperDocumentOptions,
    type NativeHelperDocumentProvenance,
} from "@/lib/nativeHelperDocument";
import type { NativeHelperWindow } from "@/lib/nativeHelperRuntime";
import { exchangeRateKeys } from "@/lib/queryKeys";
import type { Language } from "@/types/i18n";

vi.mock("@/lib/api", () => ({
    apiClient: {
        getExchangeRates: vi.fn(() => {
            throw Error("No provider requests allowed");
        }),
    },
}));

const frames: HTMLIFrameElement[] = [];
const documents: NativeHelperDocument[] = [];
const provenance = {
    documentId: "synthetic-document",
    generation: "synthetic-graph",
};
const settings = () =>
    JSON.stringify({
        belgian_tax_household_v2: household([
            partner("A", [activity("employee", 50_000)]),
        ]),
    });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function target(flags = true): NativeHelperWindow {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frames.push(frame);
    const result = frame.contentWindow as NativeHelperWindow;
    if (flags) {
        for (const key of [
            "__VISION_NATIVE_PALETTE__",
            "__VISION_NATIVE_REPORTS__",
            "__VISION_NATIVE_SHORTCUTS__",
        ]) {
            Object.defineProperty(result, key, { value: true });
        }
    }
    return result;
}

async function actualLocale(
    language: Language,
): Promise<Record<string, string>> {
    return (
        language === "en"
            ? await import("@/locales/en")
            : await import("@/locales/nl")
    ).default;
}

function start(
    window = target(),
    overrides: Partial<NativeHelperDocumentOptions> = {},
) {
    const host = {
        isCurrent: vi.fn(() => true),
        ready: vi
            .fn<NativeHelperDocumentOptions["signalReady"]>()
            .mockResolvedValue(),
    };
    const result = startNativeHelperDocument({
        target: window,
        initialLanguage: "en",
        provenance,
        isCurrent: host.isCurrent,
        signalReady: host.ready,
        ...overrides,
    });
    documents.push(result);
    return { document: result, window, host };
}

function rates(document: NativeHelperDocument, rate: number): void {
    const value: ExchangeRatesData = {
        total_rates: 1,
        fallback_rates: {},
        rates: [
            {
                currency: "USD",
                rate_to_eur: rate,
                rate_date: "2026-01-01",
                fetched_at: "2026-01-01T00:00:00Z",
            },
        ],
    };
    document.queryClient.setQueryData(exchangeRateKeys.all, value);
}

async function bracket(
    window: NativeHelperWindow,
): Promise<string | undefined> {
    return (await window.__visionNativeTaxReportContext!(settings(), 2025))
        .precomputedPIT?.brackets?.[0]?.label;
}

afterEach(() => {
    documents.splice(0).forEach((document) => document.dispose());
    frames.splice(0).forEach((frame) => frame.remove());
    expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("dormant native helper document bootstrap", () => {
    it("owns App query defaults and installs actual fixed source callbacks and English locale before ready", async () => {
        const window = target();
        const ready = vi.fn(
            async (candidate: NativeHelperDocumentProvenance) => {
                expect(candidate).toEqual(provenance);
                expect(Object.isFrozen(candidate)).toBe(true);
                expect(window.document.documentElement.lang).toBe("en");
                expect(await bracket(window)).toBe("Bracket 1 (25%)");
                expect(
                    await window.__visionNativePaletteAnswer!(
                        "2+2",
                        "us",
                        "EUR",
                        2,
                    ),
                ).toEqual({ kind: "arithmetic", text: "4" });
                const input = household([
                    partner("A", [activity("employee", 50_000)]),
                ]);
                expect(
                    await window.__visionNativeTaxReportProfile!(
                        JSON.stringify(input),
                        2025,
                    ),
                ).toMatchObject({ employmentType: "employee", taxYear: 2025 });
            },
        );
        const { document } = start(window, { signalReady: ready });
        expect(document.queryClient.getDefaultOptions().queries).toEqual({
            staleTime: 30_000,
            gcTime: 300_000,
            refetchOnWindowFocus: false,
            retry: 1,
        });
        await document.ready;
        expect(ready).toHaveBeenCalledTimes(1);
        expect(document.language).toBe("en");
        for (const name of [
            "__visionNativePaletteAnswer",
            "__visionNativeTaxReportProfile",
            "__visionNativeTaxReportContext",
        ]) {
            expect(Object.getOwnPropertyDescriptor(window, name)).toMatchObject(
                { configurable: false, writable: false, enumerable: false },
            );
        }
    });

    it("loads only the actual active Dutch dictionary and retains cache/callback identities on typed locale updates", async () => {
        const loadLocale = vi.fn(actualLocale);
        const { document, window, host } = start(target(), {
            initialLanguage: "nl",
            loadLocale,
        });
        await document.ready;
        expect(loadLocale.mock.calls).toEqual([["nl"]]);
        expect(await bracket(window)).toBe("Schijf 1 (25%)");
        rates(document, 0.5);
        const callbacks = [
            window.__visionNativePaletteAnswer,
            window.__visionNativeTaxReportProfile,
            window.__visionNativeTaxReportContext,
        ];
        const cache = document.queryClient;
        await document.updateLocale("en", provenance);
        expect(await bracket(window)).toBe("Bracket 1 (25%)");
        await document.updateLocale("nl", provenance);
        expect(await bracket(window)).toBe("Schijf 1 (25%)");
        expect(loadLocale.mock.calls).toEqual([["nl"], ["en"]]);
        expect(document.queryClient).toBe(cache);
        expect([
            window.__visionNativePaletteAnswer,
            window.__visionNativeTaxReportProfile,
            window.__visionNativeTaxReportContext,
        ]).toEqual(callbacks);
        expect(
            await window.__visionNativePaletteAnswer!("4 USD", "us", "EUR", 2),
        ).toEqual({ kind: "fx", text: "€2.00" });
        expect(host.ready).toHaveBeenCalledTimes(1);
    });

    it("does not install callbacks or signal ready while the initial dictionary is pending", async () => {
        const dictionary = deferred<Record<string, string>>();
        const { document, window, host } = start(target(), {
            loadLocale: () => dictionary.promise,
        });
        expect(window.__visionNativeTaxReportContext).toBeUndefined();
        expect(host.ready).not.toHaveBeenCalled();
        dictionary.resolve(await actualLocale("en"));
        await document.ready;
        expect(await bracket(window)).toBe("Bracket 1 (25%)");
        expect(host.ready).toHaveBeenCalledExactlyOnceWith(provenance);
    });

    it("rejects missing native capabilities and foreign callbacks without claiming readiness", async () => {
        const loadLocale = vi.fn(actualLocale);
        const ordinary = start(target(false), { loadLocale });
        await expect(ordinary.document.ready).rejects.toThrow("capabilities");
        expect(loadLocale).not.toHaveBeenCalled();
        expect(ordinary.host.ready).not.toHaveBeenCalled();
        expect(ordinary.window.__visionNativePaletteAnswer).toBeUndefined();

        const foreign = target();
        Object.defineProperty(foreign, "__visionNativePaletteAnswer", {
            value: () => null,
        });
        const unknown = start(foreign);
        await expect(unknown.document.ready).rejects.toThrow("unknown owner");
        expect(unknown.host.ready).not.toHaveBeenCalled();
        expect(foreign.__visionNativeTaxReportContext).toBeUndefined();
    });

    it("retires initial locale and host-ready failures rather than keeping partially ready owners", async () => {
        const localeFailure = start(target(), {
            loadLocale: async () => {
                throw Error("synthetic locale unavailable");
            },
        });
        await expect(localeFailure.document.ready).rejects.toThrow(
            "synthetic locale unavailable",
        );
        expect(localeFailure.host.ready).not.toHaveBeenCalled();
        expect(
            localeFailure.window.__visionNativePaletteAnswer,
        ).toBeUndefined();
        const hostFailure = start(target(), {
            signalReady: async () => {
                throw Error("synthetic ready rejected");
            },
        });
        await expect(hostFailure.document.ready).rejects.toThrow(
            "synthetic ready rejected",
        );
        expect(
            await hostFailure.window.__visionNativePaletteAnswer!(
                "2+2",
                "us",
                "EUR",
                2,
            ),
        ).toBeNull();
        await expect(bracket(hostFailure.window)).rejects.toThrow(
            "unavailable",
        );
        expect(
            hostFailure.document.queryClient.getQueryCache().getAll(),
        ).toEqual([]);
    });

    it("rejects stale provenance before installing callbacks after a delayed initial locale", async () => {
        let current = true;
        const dictionary = deferred<Record<string, string>>();
        const { document, window, host } = start(target(), {
            isCurrent: () => current,
            loadLocale: () => dictionary.promise,
        });
        current = false;
        dictionary.resolve(await actualLocale("en"));
        await expect(document.ready).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(host.ready).not.toHaveBeenCalled();
        expect(window.__visionNativePaletteAnswer).toBeUndefined();
    });

    it("disposes pending bootstrap immediately and ignores its late locale", async () => {
        const dictionary = deferred<Record<string, string>>();
        const { document, window, host } = start(target(), {
            loadLocale: () => dictionary.promise,
        });
        const rejection = expect(document.ready).rejects.toMatchObject({
            name: "AbortError",
        });
        document.dispose();
        document.dispose();
        await rejection;
        dictionary.resolve(await actualLocale("nl"));
        await dictionary.promise;
        expect(host.ready).not.toHaveBeenCalled();
        expect(window.__visionNativeTaxReportContext).toBeUndefined();
        expect(window.document.documentElement.lang).not.toBe("nl");
    });

    it("checks currentness after a host ACK and rejects a stale owner", async () => {
        let current = true;
        const ack = deferred<void>();
        const entered = deferred<void>();
        const ready = vi.fn(async () => {
            entered.resolve();
            await ack.promise;
        });
        const { document, window } = start(target(), {
            isCurrent: () => current,
            signalReady: ready,
        });
        await entered.promise;
        current = false;
        ack.resolve();
        await expect(document.ready).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(
            await window.__visionNativePaletteAnswer!("2+2", "us", "EUR", 2),
        ).toBeNull();
    });

    it("rejects mismatched or unproven locale updates and does not consume global settings publications", async () => {
        const { document, window } = start();
        await document.ready;
        window.dispatchEvent(
            new CustomEvent("vision:native-settings", {
                detail: {
                    kind: "draft",
                    key: "app_settings",
                    value: { language: "nl" },
                },
            }),
        );
        expect(document.language).toBe("en");
        await expect(
            document.updateLocale("nl", {
                ...provenance,
                generation: "old-graph",
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(
            document.updateLocale("nl", {
                ...provenance,
                documentId: "old-document",
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(
            document.updateLocale("de" as Language, provenance),
        ).rejects.toThrow("Unsupported");
        expect(await bracket(window)).toBe("Bracket 1 (25%)");
    });

    it("rejects locale updates before the initial host ACK", async () => {
        const dictionary = deferred<Record<string, string>>();
        const { document } = start(target(), {
            loadLocale: () => dictionary.promise,
        });
        await expect(document.updateLocale("nl", provenance)).rejects.toThrow(
            "not ready",
        );
        dictionary.resolve(await actualLocale("en"));
        await document.ready;
    });

    it("rejects superseded locale loads and retains the last acknowledged language after load failure", async () => {
        const dutch = deferred<Record<string, string>>();
        const loadLocale = vi.fn((language: Language) =>
            language === "en" ? actualLocale("en") : dutch.promise,
        );
        const { document, window } = start(target(), { loadLocale });
        await document.ready;
        const older = document.updateLocale("nl", provenance);
        const retiredUpdate = expect(older).rejects.toMatchObject({
            name: "AbortError",
        });
        await document.updateLocale("en", provenance);
        await retiredUpdate;
        dutch.resolve(await actualLocale("nl"));
        await dutch.promise;
        expect(document.language).toBe("en");
        expect(window.document.documentElement.lang).toBe("en");
        expect(await bracket(window)).toBe("Bracket 1 (25%)");

        const failed = start(target(), {
            loadLocale: async (language) => {
                if (language === "nl")
                    throw Error("synthetic Dutch locale unavailable");
                return actualLocale(language);
            },
        });
        await failed.document.ready;
        await expect(
            failed.document.updateLocale("nl", provenance),
        ).rejects.toThrow("synthetic Dutch locale unavailable");
        expect(failed.document.language).toBe("en");
        expect(await bracket(failed.window)).toBe("Bracket 1 (25%)");
    });

    it("replacement document owner retires pending old callbacks and owns a separate cache", async () => {
        const window = target();
        const first = start(window);
        await first.document.ready;
        rates(first.document, 0.5);
        const palette = window.__visionNativePaletteAnswer!;
        const pendingOldAnswer = palette("4 USD", "us", "EUR", 2);
        const next = start(window, {
            provenance: { ...provenance, generation: "replacement-graph" },
            initialLanguage: "nl",
        });
        await next.document.ready;
        rates(next.document, 0.75);
        expect(await pendingOldAnswer).toBeNull();
        expect(next.document.queryClient).not.toBe(first.document.queryClient);
        expect(first.document.queryClient.getQueryCache().getAll()).toEqual([]);
        expect(window.__visionNativePaletteAnswer).toBe(palette);
        expect(await palette("4 USD", "us", "EUR", 2)).toEqual({
            kind: "fx",
            text: "€3.00",
        });
        expect(await bracket(window)).toBe("Schijf 1 (25%)");
        first.document.dispose();
        expect(await bracket(window)).toBe("Schijf 1 (25%)");
    });

    it("dispose while host-ready is pending retires helpers and never revives after the late ACK", async () => {
        const ack = deferred<void>();
        const entered = deferred<void>();
        const { document, window } = start(target(), {
            signalReady: async () => {
                entered.resolve();
                await ack.promise;
            },
        });
        await entered.promise;
        const rejection = expect(document.ready).rejects.toMatchObject({
            name: "AbortError",
        });
        document.dispose();
        await rejection;
        expect(
            await window.__visionNativePaletteAnswer!("2+2", "us", "EUR", 2),
        ).toBeNull();
        ack.resolve();
        await ack.promise;
        await expect(
            document.updateLocale("nl", provenance),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("owns keyboard listener cleanup and forwards overlay failures without a UI mount", async () => {
        const window = target();
        const failure = Error("synthetic overlay denied");
        const open = vi.fn().mockRejectedValue(failure);
        Object.defineProperty(window, "__visionNativeOpenOverlay", {
            value: open,
        });
        const report = vi.fn();
        const { document } = start(window, { reportOverlayFailure: report });
        await document.ready;
        const key = new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
            cancelable: true,
        });
        window.document.dispatchEvent(key);
        await vi.waitFor(() =>
            expect(report).toHaveBeenCalledExactlyOnceWith(failure),
        );
        expect(key.defaultPrevented).toBe(true);
        document.dispose();
        const retiredKey = new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
            cancelable: true,
        });
        window.document.dispatchEvent(retiredKey);
        expect(retiredKey.defaultPrevented).toBe(false);
        expect(open).toHaveBeenCalledTimes(1);
    });
});
