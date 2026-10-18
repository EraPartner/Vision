// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { type ExchangeRatesData } from "@/lib/api/info";
import { exchangeRateKeys } from "@/lib/queryKeys";
import {
    nativePaletteAnswer,
    registerNativePaletteAnswerBridge,
    type NativePaletteWindow,
} from "@/lib/nativePaletteAnswer";

vi.mock("@/lib/api", () => ({ apiClient: { getExchangeRates: vi.fn() } }));

function rates(values: Record<string, number>, fallback: Record<string, number> = {}): ExchangeRatesData {
    return {
        total_rates: Object.keys(values).length,
        fallback_rates: fallback,
        rates: Object.entries(values).map(([currency, rate_to_eur]) => ({
            currency,
            rate_to_eur,
            rate_date: "2026-01-01",
            fetched_at: "2026-01-01T00:00:00Z",
        })),
    };
}

const clients: QueryClient[] = [];
function client() {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(value);
    return value;
}

afterEach(() => {
    clients.forEach((value) => value.clear());
    clients.length = 0;
    vi.clearAllMocks();
});

describe("native palette shared TypeScript answers", () => {
    it.each([
        [" 1.234 + 2,5 ", "eu", "1.236,5"],
        ["1,234.5 + 2", "us", "1,236.5"],
        ["1'234.5 + 2", "ch", "1'236.5"],
        ["1,23,456 + 2", "in", "1,23,458"],
        ["1 / 3", "us", "0.333333"],
        ["2**3", "eu", "8"],
    ])("matches locale arithmetic %s", async (query, format, text) => {
        const read = vi.fn();
        expect(await nativePaletteAnswer(query, format, "EUR", 2, read))
            .toEqual({ kind: "arithmetic", text });
        expect(read).not.toHaveBeenCalled();
    });

    it.each(["42", "2 +", "1/0", "NaN + 1", "globalThis.__paletteInjected = 1", "2; alert(1)"])(
        "rejects invalid or executable input %s without reading rates",
        async (query) => {
            const read = vi.fn();
            expect(await nativePaletteAnswer(query, "us", "EUR", 2, read)).toBeNull();
            expect(read).not.toHaveBeenCalled();
            expect((globalThis as Record<string, unknown>).__paletteInjected).toBeUndefined();
        },
    );

    it("validates the fixed callback input types before invoking shared parsers", async () => {
        const read = vi.fn();
        for (const values of [[null, "us", "EUR", 2], ["2+2", "invalid", "EUR", 2],
            ["2+2", "us", {}, 2], ["2+2", "us", "EUR", NaN]]) {
            expect(await nativePaletteAnswer(...values as [unknown, unknown, unknown, unknown], read)).toBeNull();
        }
        expect(read).not.toHaveBeenCalled();
    });

    it("uses database rows over fallback rates and EUR's default", async () => {
        const read = vi.fn().mockResolvedValue(rates({ USD: 0.5, EUR: 2 }, { USD: 0.9, EUR: 0.1 }));
        expect(await nativePaletteAnswer("12 USD", "us", "EUR", 2, read))
            .toEqual({ kind: "fx", text: "€3.00" });
        expect(await nativePaletteAnswer("12,5 eur naar usd", "eu", "GBP", 0, read))
            .toEqual({ kind: "fx", text: "50 $" });
    });

    it("preserves missing-rate original amounts and currency-bearing formatting fallback", async () => {
        expect(await nativePaletteAnswer("5 USD to XYZ", "us", "EUR", 2, async () => rates({})))
            .toEqual({ kind: "fx", text: "XYZ 5.00" });
        expect(await nativePaletteAnswer("5 USD", "us", "bad-code", 2, async () => { throw Error("offline"); }))
            .toEqual({ kind: "fx", text: "5.00 bad-code" });
        expect(await nativePaletteAnswer("5 USD", "us", "EUR", 200, async () => undefined))
            .toEqual({ kind: "fx", text: "5.00 EUR" });
        expect(await nativePaletteAnswer("5 USD", "us", "", 2, async () => undefined))
            .toEqual({ kind: "fx", text: "5.00 " });
    });

    it("does not fetch for identical currencies and hides nonfinite conversions", async () => {
        const read = vi.fn().mockResolvedValue(rates({ USD: Infinity }));
        expect(await nativePaletteAnswer("5 EUR", "us", "EUR", 2, read)).toBeNull();
        expect(read).not.toHaveBeenCalled();
        expect(await nativePaletteAnswer("5 USD", "us", "EUR", 2, read)).toBeNull();
    });
});

describe("native palette immutable registration and shared cache", () => {
    it("stays absent on ordinary web and older native settings-only hosts", () => {
        const web = {};
        registerNativePaletteAnswerBridge(client(), web)();
        expect(Object.getOwnPropertyDescriptor(web, "__visionNativePaletteAnswer")).toBeUndefined();
    });

    it("reuses fresh shared rates, refetches stale rates db-only, and retains stale data after errors", async () => {
        const cache = client();
        const fetch = vi.spyOn(cache, "fetchQuery");
        const host: NativePaletteWindow = { __VISION_NATIVE_PALETTE__: true };
        cache.setQueryData(exchangeRateKeys.all, rates({ USD: 0.5 }));
        const stop = registerNativePaletteAnswerBridge(cache, host);
        const answer = host.__visionNativePaletteAnswer!;
        expect(await answer("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€2.00" });
        expect(apiClient.getExchangeRates).not.toHaveBeenCalled();
        cache.setQueryData(exchangeRateKeys.all, rates({ USD: 0.5 }), { updatedAt: Date.now() - 600_001 });
        vi.mocked(apiClient.getExchangeRates).mockResolvedValueOnce(rates({ USD: 0.75 }));
        expect(await answer("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€3.00" });
        expect(apiClient.getExchangeRates).toHaveBeenCalledExactlyOnceWith({ dbOnly: true });
        expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
            queryKey: exchangeRateKeys.all,
            staleTime: 600_000,
            gcTime: 1_800_000,
        }));
        cache.setQueryData(exchangeRateKeys.all, rates({ USD: 0.75 }), { updatedAt: Date.now() - 600_001 });
        vi.mocked(apiClient.getExchangeRates).mockRejectedValueOnce(Error("offline"));
        expect(await answer("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€3.00" });
        stop();
    });

    it("keeps the function immutable across cleanup, overlapping mounts, and remount", async () => {
        const host: NativePaletteWindow = { __VISION_NATIVE_PALETTE__: true };
        const first = client();
        const second = client();
        first.setQueryData(exchangeRateKeys.all, rates({ USD: 0.5 }));
        second.setQueryData(exchangeRateKeys.all, rates({ USD: 0.75 }));
        const stopFirst = registerNativePaletteAnswerBridge(first, host);
        const fixed = host.__visionNativePaletteAnswer!;
        const stopSecond = registerNativePaletteAnswerBridge(second, host);
        stopFirst();
        expect(await fixed("4 USD", "us", "EUR", 2)).toEqual({ kind: "fx", text: "€3.00" });
        expect(Object.getOwnPropertyDescriptor(host, "__visionNativePaletteAnswer"))
            .toMatchObject({ writable: false, configurable: false });
        stopSecond();
        expect(await fixed("2+2", "us", "EUR", 2)).toBeNull();
        const stopRemount = registerNativePaletteAnswerBridge(first, host);
        expect(host.__visionNativePaletteAnswer).toBe(fixed);
        expect(await fixed("2+2", "us", "EUR", 2)).toEqual({ kind: "arithmetic", text: "4" });
        stopRemount();
    });

    it("discards an in-flight result after its registration is removed", async () => {
        let resolve!: (data: ExchangeRatesData) => void;
        vi.mocked(apiClient.getExchangeRates).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const host: NativePaletteWindow = { __VISION_NATIVE_PALETTE__: true };
        const stop = registerNativePaletteAnswerBridge(client(), host);
        const pending = host.__visionNativePaletteAnswer!("4 USD", "us", "EUR", 2);
        stop();
        resolve(rates({ USD: 0.5 }));
        expect(await pending).toBeNull();
    });

    it("deduplicates overlapping FX requests across target currencies in the shared cache", async () => {
        let resolve!: (data: ExchangeRatesData) => void;
        vi.mocked(apiClient.getExchangeRates).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        const host: NativePaletteWindow = { __VISION_NATIVE_PALETTE__: true };
        const cache = client();
        const stop = registerNativePaletteAnswerBridge(cache, host);
        const eur = host.__visionNativePaletteAnswer!("4 USD", "us", "EUR", 2);
        const gbp = host.__visionNativePaletteAnswer!("4 USD to GBP", "us", "EUR", 2);
        expect(apiClient.getExchangeRates).toHaveBeenCalledExactlyOnceWith({ dbOnly: true });
        resolve(rates({ USD: 0.5, GBP: 2 }));
        expect(await eur).toEqual({ kind: "fx", text: "€2.00" });
        expect(await gbp).toEqual({ kind: "fx", text: "£1.00" });
        expect(cache.getQueryCache().getAll()).toHaveLength(1);
        stop();
    });

    it("does not replace an existing callback from another owner", () => {
        const existing = vi.fn().mockResolvedValue(null);
        const host: NativePaletteWindow = { __VISION_NATIVE_PALETTE__: true, __visionNativePaletteAnswer: existing };
        registerNativePaletteAnswerBridge(client(), host)();
        expect(host.__visionNativePaletteAnswer).toBe(existing);
    });
});
