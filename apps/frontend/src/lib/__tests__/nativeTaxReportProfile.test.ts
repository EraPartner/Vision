// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { nativeTaxReportProfile, registerNativeTaxReportProfileBridge, type NativeTaxReportWindow } from "@/lib/nativeTaxReportProfile";
import { projectHouseholdToProfileV1 } from "@/lib/belgianTax/householdMigration";
import { activity, household, partner } from "@/lib/belgianTax/__tests__/testHousehold";

afterEach(() => {
    Reflect.deleteProperty(window, "__VISION_NATIVE_REPORTS__");
});

describe("native tax report source profile projection", () => {
    it("preserves shared source projection metadata and migrated fields without changing the requested year", async () => {
        const input = household([partner("A", [activity("self_employed_fees", 32_000.25)])], {
            taxYear: 2025,
            region: "wallonia",
            migratedFrom: { fromVersion: 1, unmappedFields: [{ field: "futureMetadata", note: "unknown_profile_field", value: { enabled: true } }] },
        });
        const result = await nativeTaxReportProfile(JSON.stringify(input), 2024);
        expect(result).toEqual(projectHouseholdToProfileV1(input));
        expect(result).toMatchObject({ taxYear: 2025, region: "wallonia", employmentType: "self_employed", selfEmployedIncomeKind: "fees", futureMetadata: { enabled: true } });
        expect(input.taxYear).toBe(2025);
    });

    it("preserves the source's unconfigured and one-partner defaults", async () => {
        const input = household([partner("A", [activity("employee", 100)])], { profileConfigured: false });
        expect(await nativeTaxReportProfile(JSON.stringify(input), 2025)).toMatchObject({ profileConfigured: false, employmentType: "employee", filingStatus: "single", isSpouseDisabled: false });
    });

    it("rejects malformed JSON, invalid household data, and non-integer arguments", async () => {
        await expect(nativeTaxReportProfile("invalid", 2025)).rejects.toThrow();
        await expect(nativeTaxReportProfile("{}", 2025)).rejects.toThrow("Invalid Belgian tax report household");
        await expect(nativeTaxReportProfile(JSON.stringify(household([partner("A", [])])), "2025")).rejects.toThrow();
        await expect(nativeTaxReportProfile("{}", 2025.5)).rejects.toThrow();
        await expect(nativeTaxReportProfile({ household: {} }, 2025)).rejects.toThrow();
    });

    it("registers only for Reports and supports immutable remounts while rejecting late retired-owner results", async () => {
        const host = window as NativeTaxReportWindow;
        registerNativeTaxReportProfileBridge()();
        expect(host.__visionNativeTaxReportProfile).toBeUndefined();
        Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true, configurable: true });
        const stop = registerNativeTaxReportProfileBridge();
        const fixed = host.__visionNativeTaxReportProfile!;
        expect(Object.getOwnPropertyDescriptor(window, "__visionNativeTaxReportProfile"))
            .toMatchObject({ writable: false, configurable: false });
        const input = JSON.stringify(household([partner("A", [activity("employee", 100)])]));
        const pending = fixed(input, 2025);
        stop();
        await expect(pending).rejects.toThrow("unavailable");
        const stopNext = registerNativeTaxReportProfileBridge();
        expect(host.__visionNativeTaxReportProfile).toBe(fixed);
        expect(await fixed(input, 2025)).toMatchObject({ taxYear: 2025, employmentType: "employee" });
        stopNext();
        await expect(fixed(input, 2025)).rejects.toThrow("unavailable");
    });
});
