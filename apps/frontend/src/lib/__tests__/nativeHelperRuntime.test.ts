// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import type { ExchangeRatesData } from "@/lib/api/info";
import { activity, household, partner } from "@/lib/belgianTax/__tests__/testHousehold";
import { exchangeRateKeys } from "@/lib/queryKeys";
import { startNativeHelperRuntime, type NativeHelperWindow } from "@/lib/nativeHelperRuntime";
import { NativePaletteAnswerBridge } from "@/components/shared/NativePaletteAnswerBridge";
import logger from "@/lib/logger";

const language = vi.hoisted(() => ({ t: (key: string) => `en:${key}` }));
vi.mock("@/stores/hydration/LanguageHydration", () => ({ useLanguage: () => ({ t: language.t }) }));
vi.mock("@/lib/api", () => ({ apiClient: { getExchangeRates: vi.fn() } }));

const clients: QueryClient[] = [];
const frames: HTMLIFrameElement[] = [];
const stops: (() => void)[] = [];
const translate = (key: string) => `en:${key}`;
const input = () => household([partner("A", [activity("employee", 50_000)])]);
const settings = () => JSON.stringify({ belgian_tax_household_v2: input() });

function client(rate: number = 0.5): QueryClient {
    const result = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const data: ExchangeRatesData = {
        total_rates: 1,
        fallback_rates: {},
        rates: [{ currency: "USD", rate_to_eur: rate, rate_date: "2026-01-01", fetched_at: "2026-01-01T00:00:00Z" }],
    };
    result.setQueryData(exchangeRateKeys.all, data);
    clients.push(result);
    return result;
}

function host(flags: Record<string, boolean> = {}): NativeHelperWindow {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frames.push(frame);
    const target = frame.contentWindow as NativeHelperWindow;
    for (const [key, value] of Object.entries(flags)) {
        Object.defineProperty(target, key, { value, configurable: true });
    }
    return target;
}

function start(target: NativeHelperWindow, queryClient = client(), localize = translate): () => void {
    const stop = startNativeHelperRuntime({ queryClient, translate: localize, target });
    stops.push(stop);
    return stop;
}

afterEach(() => {
    cleanup();
    stops.splice(0).forEach((stop) => stop());
    clients.splice(0).forEach((value) => value.clear());
    frames.splice(0).forEach((frame) => frame.remove());
    for (const key of ["__VISION_NATIVE_PALETTE__", "__VISION_NATIVE_REPORTS__", "__visionNativeOpenOverlay"]) {
        Reflect.deleteProperty(window, key);
    }
    language.t = translate;
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("fixed native source helper runtime ownership", () => {
    it("keeps ordinary web inert and gates each native capability independently", async () => {
        const web = host();
        const listen = vi.spyOn(web.document, "addEventListener");
        start(web);
        expect(web.__visionNativePaletteAnswer).toBeUndefined();
        expect(web.__visionNativeTaxReportProfile).toBeUndefined();
        expect(web.__visionNativeTaxReportContext).toBeUndefined();
        expect(listen).not.toHaveBeenCalledWith("keydown", expect.anything());
        const reports = host({ __VISION_NATIVE_REPORTS__: true });
        start(reports);
        expect(reports.__visionNativePaletteAnswer).toBeUndefined();
        expect(await reports.__visionNativeTaxReportProfile!(JSON.stringify(input()), 2024))
            .toMatchObject({ taxYear: 2025, employmentType: "employee" });
        expect(await reports.__visionNativeTaxReportContext!("{}", 2025)).toEqual({});
        expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
    });

    it("keeps fixed callbacks across retirement and remount with current cache and locale owners", async () => {
        const target = host({ __VISION_NATIVE_PALETTE__: true, __VISION_NATIVE_REPORTS__: true });
        const stopFirst = start(target);
        const palette = target.__visionNativePaletteAnswer!;
        const profile = target.__visionNativeTaxReportProfile!;
        const context = target.__visionNativeTaxReportContext!;
        const stopSecond = start(target, client(0.75), (key) => `nl:${key}`);
        stopFirst();
        expect(await palette("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€3.00" });
        expect((await context(settings(), 2025)).precomputedPIT?.brackets?.[0]?.label).toBe("nl:tax.pit.row.bracket1");
        for (const name of ["__visionNativePaletteAnswer", "__visionNativeTaxReportProfile", "__visionNativeTaxReportContext"]) {
            expect(Object.getOwnPropertyDescriptor(target, name)).toMatchObject({ writable: false, configurable: false, enumerable: false });
        }
        stopSecond();
        stopSecond();
        expect(await palette("2+2", "us", "EUR", 2)).toBeNull();
        await expect(profile(JSON.stringify(input()), 2025)).rejects.toThrow("unavailable");
        await expect(context(settings(), 2025)).rejects.toThrow("unavailable");
        start(target);
        expect(target.__visionNativePaletteAnswer).toBe(palette);
        expect(target.__visionNativeTaxReportProfile).toBe(profile);
        expect(target.__visionNativeTaxReportContext).toBe(context);
        expect(await palette("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€2.00" });
        expect((await context(settings(), 2025)).precomputedPIT?.brackets?.[0]?.label).toBe("en:tax.pit.row.bracket1");
        expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
    });

    it("rejects all retired-owner results even when a replacement owner is already installed", async () => {
        const target = host({ __VISION_NATIVE_PALETTE__: true, __VISION_NATIVE_REPORTS__: true });
        const stop = start(target);
        const pending = [
            target.__visionNativePaletteAnswer!("4 USD", "us", "EUR", 2),
            target.__visionNativeTaxReportProfile!(JSON.stringify(input()), 2025),
            target.__visionNativeTaxReportContext!(settings(), 2025),
        ];
        const settled = Promise.allSettled(pending);
        stop();
        start(target, client(0.75));
        expect(await settled).toEqual([
            { status: "fulfilled", value: null },
            { status: "rejected", reason: expect.objectContaining({ message: "Native tax report bridge is unavailable" }) },
            { status: "rejected", reason: expect.objectContaining({ message: "Native tax report bridge is unavailable" }) },
        ]);
        expect(await target.__visionNativePaletteAnswer!("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€3.00" });
        expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
    });

    it("owns keyboard lifetime and forwards source overlay failures", async () => {
        const target = host({ __VISION_NATIVE_PALETTE__: true });
        const failure = Error("synthetic overlay failure");
        const open = vi.fn().mockRejectedValue(failure);
        Object.defineProperty(target, "__visionNativeOpenOverlay", { value: open });
        const report = vi.fn();
        const stop = startNativeHelperRuntime({ queryClient: client(), translate, target, reportOverlayFailure: report });
        stops.push(stop);
        const key = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
        target.document.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(report).toHaveBeenCalledExactlyOnceWith(failure));
        expect(open).toHaveBeenCalledExactlyOnceWith("palette");
        stop();
        const retired = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
        target.document.dispatchEvent(retired);
        expect(retired.defaultPrevented).toBe(false);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it("keeps the React mount owner and its live translation ref without reinstalling on language changes", async () => {
        Object.defineProperty(window, "__VISION_NATIVE_PALETTE__", { value: true, configurable: true });
        Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true, configurable: true });
        const failure = Error("synthetic keyboard failure");
        const open = vi.fn().mockRejectedValue(failure);
        Object.defineProperty(window, "__visionNativeOpenOverlay", { value: open, configurable: true });
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const cache = client();
        const tree = () => createElement(QueryClientProvider, { client: cache }, createElement(NativePaletteAnswerBridge));
        const mounted = render(tree());
        const target = window as NativeHelperWindow;
        const callback = target.__visionNativeTaxReportContext!;
        expect((await callback(settings(), 2025)).precomputedPIT?.brackets?.[0]?.label).toBe("en:tax.pit.row.bracket1");
        const listen = vi.spyOn(document, "addEventListener");
        language.t = (key) => `nl:${key}`;
        mounted.rerender(tree());
        expect(target.__visionNativeTaxReportContext).toBe(callback);
        expect(listen).not.toHaveBeenCalledWith("keydown", expect.anything());
        expect((await callback(settings(), 2025)).precomputedPIT?.brackets?.[0]?.label).toBe("nl:tax.pit.row.bracket1");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }));
        await vi.waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith("Native overlay request failed", failure));
        mounted.unmount();
        await expect(callback(settings(), 2025)).rejects.toThrow("unavailable");
        expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
    });
});
