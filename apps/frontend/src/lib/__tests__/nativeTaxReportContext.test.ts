// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeTaxReportContext, registerNativeTaxReportContextBridge, type NativeTaxReportContextWindow } from "@/lib/nativeTaxReportContext";
import { taxReportContextFromSettings } from "@/lib/nativeTaxReportContextSource";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import { computeBelgianPIT } from "@/lib/belgianTax/pit";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { activity, household, partner } from "@/lib/belgianTax/__tests__/testHousehold";

const translate = (key: string) => `localized:${key}`;
const single = () => household([partner("A", [activity("employee", 50_000)])]);
const couple = () => household([
    partner("A", [activity("employee", 50_000)]),
    partner("B", [activity("employee", 20_000)]),
]);

afterEach(() => {
    Reflect.deleteProperty(window, "__VISION_NATIVE_REPORTS__");
});

describe("read-only original fiscal context for literal extreme years", () => {
    it.each([0, 1899, 2201, 9999])("keeps source one-partner PIT and year metadata for %s", async (year) => {
        const input = single();
        const context = await nativeTaxReportContext(JSON.stringify({ belgian_tax_household_v2: input }), year, translate);
        const projected = { ...DEFAULT_BELGIAN_TAX_PROFILE, ...runtime.projectHouseholdToProfileV1(input), taxYear: year };
        const sourcePIT = computeBelgianPIT(projected);
        expect(context.taxProfile).toEqual({ filingStatus: "employee", region: "flanders", taxYear: year });
        expect(context.precomputedPIT?.taxableIncome).toBe(sourcePIT.taxableIncome);
        expect(context.precomputedPIT?.totalTax).toBe(sourcePIT.totalPIT);
        expect(context.precomputedPIT?.brackets?.[0]?.label).toBe("localized:tax.pit.row.bracket1");
        expect(context.household).toBeUndefined();
        expect(context.precomputedHousehold).toBeUndefined();
        expect(input.taxYear).toBe(2025);
    });

    it("sends the exact two-partner out-of-bounds household rather than omitting it to bypass backend rejection", async () => {
        const input = couple();
        const context = await nativeTaxReportContext(JSON.stringify({ belgian_tax_household_v2: input }), 9999, translate);
        expect(context.household).toEqual({ ...input, taxYear: 9999 });
        expect(context.precomputedHousehold?.partners).toHaveLength(2);
        const { parseHouseholdV2 } = await import("@/lib/belgianTax/householdSchema");
        expect(parseHouseholdV2(context.household).ok).toBe(false);
    });

    it("preserves legacy frozen PIT without an invented household result or unused recomputation", () => {
        const input = couple();
        const frozen = { taxableIncome: 111, totalPIT: 222, breakdown: [] };
        const compute = vi.fn(() => { throw Error("must not recompute frozen filing"); });
        const context = taxReportContextFromSettings({
            belgian_tax_household_v2: input,
            belgian_tax_profile_snapshot_meta_v1: { "9999": { frozenCalculation: frozen } },
        }, 9999, translate, { ...runtime, computeHouseholdTax: compute });
        expect(context.precomputedPIT).toEqual({ taxableIncome: 111, totalTax: 222, brackets: [] });
        expect(context.household?.taxYear).toBe(9999);
        expect(context.precomputedHousehold).toBeUndefined();
        expect(compute).not.toHaveBeenCalled();
    });

    it("keeps fully frozen household results intact and does not compute a preview", () => {
        const input = couple();
        const result = runtime.computeHouseholdTax({ ...input, taxYear: 9999 });
        const frozen = runtime.toBelgianTaxCalculation(result, { ...input, taxYear: 9999 });
        const compute = vi.fn(() => { throw Error("must not recompute frozen filing"); });
        const context = taxReportContextFromSettings({
            belgian_tax_household_v2: input,
            belgian_tax_profile_snapshot_meta_v1: { "9999": { frozenCalculation: frozen, frozenHouseholdResult: result } },
        }, 9999, translate, { ...runtime, computeHouseholdTax: compute });
        expect(context.precomputedPIT?.totalTax).toBe(frozen.totalPIT);
        expect(context.precomputedHousehold?.partners[0]?.totalPIT).toBe(result.partners[0]?.totalPIT);
        expect(compute).not.toHaveBeenCalled();
    });

    it("hydrates v1 compatibility data, preserves unconfigured exports, and leaves the global store unchanged", async () => {
        const before = useSettingsStore.getState();
        const context = await nativeTaxReportContext(JSON.stringify({
            belgian_tax_profile: { ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 40_000, taxYear: 2025 },
        }), 9999, translate);
        expect(context.taxProfile?.taxYear).toBe(9999);
        expect(context.precomputedPIT?.totalTax).toBeGreaterThan(0);
        expect(await nativeTaxReportContext("{}", 9999, translate)).toEqual({});
        expect(useSettingsStore.getState()).toBe(before);
    });

    it("rejects out-of-scope settings keys and malformed fixed arguments", async () => {
        await expect(nativeTaxReportContext('{"provider_api_key":"synthetic"}', 9999, translate)).rejects.toThrow();
        await expect(nativeTaxReportContext("invalid", 9999, translate)).rejects.toThrow();
        await expect(nativeTaxReportContext("{}", "9999", translate)).rejects.toThrow();
    });

    it("registers immutable current-language callbacks only for Reports and cancels retired-owner results", async () => {
        const host = window as NativeTaxReportContextWindow;
        registerNativeTaxReportContextBridge(translate)();
        expect(host.__visionNativeTaxReportContext).toBeUndefined();
        Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true, configurable: true });
        const stop = registerNativeTaxReportContextBridge(translate);
        const fixed = host.__visionNativeTaxReportContext!;
        const snapshot = JSON.stringify({ belgian_tax_household_v2: single() });
        const pending = fixed(snapshot, 9999);
        stop();
        await expect(pending).rejects.toThrow("unavailable");
        const stopNext = registerNativeTaxReportContextBridge((key) => `new-language:${key}`);
        expect(host.__visionNativeTaxReportContext).toBe(fixed);
        expect(Object.getOwnPropertyDescriptor(window, "__visionNativeTaxReportContext"))
            .toMatchObject({ writable: false, configurable: false });
        expect((await fixed(snapshot, 9999)).precomputedPIT?.brackets?.[0]?.label).toBe("new-language:tax.pit.row.bracket1");
        stopNext();
    });
});
