import { describe, it, expect } from "vitest";
import { migrateAppSettings, DEFAULT_APP_SETTINGS } from "@/stores/settingsStore";

// Schema guard for the persisted app_settings blob (mirrors the
// storedDashboardSettingsSchema precedent). The load-bearing cases are the
// money-formatting fields: an unvalidated defaultCurrency ("US") or
// showDecimalPlaces (-1 / NaN / 101) makes Intl.NumberFormat throw RangeError,
// which either crashes a page into the error boundary or renders a raw
// unlocalised number on every money tile. The legacy enhancedEffects mapping
// itself is covered in lib/__tests__/visualEffects.test.ts.
describe("migrateAppSettings — blob validation", () => {
    it("passes a well-formed partial blob through exactly like the old spread merge", () => {
        expect(migrateAppSettings({ defaultCurrency: "GBP", showDecimalPlaces: 0 })).toEqual({
            ...DEFAULT_APP_SETTINGS,
            defaultCurrency: "GBP",
            showDecimalPlaces: 0,
        });
    });

    it("keeps unknown keys (forward compatibility — they are persisted back)", () => {
        expect(migrateAppSettings({ defaultCurrency: "CHF", someFutureKey: "x" })).toEqual({
            ...DEFAULT_APP_SETTINGS,
            defaultCurrency: "CHF",
            someFutureKey: "x",
        });
    });

    it("keeps a full valid blob byte-for-byte, aiDefaultModel included", () => {
        const blob = {
            defaultCurrency: "USD",
            dateFormat: "MM/DD/YYYY",
            numberFormat: "us",
            defaultPageSize: 100,
            startOfWeek: "sunday",
            showDecimalPlaces: 3,
            language: "nl",
            aiDefaultModel: "claude-sonnet",
            costBasisMethod: "fifo",
            adminMode: true,
            visualEffects: "enhanced",
            autoAdaptDisplay: false,
            startupSection: "portfolio",
            autoClearPlannedOnMatch: false,
            colorblindGainLoss: true,
        };
        expect(migrateAppSettings(blob)).toEqual(blob);
    });

    it("falls back to the default currency for a malformed ISO code", () => {
        // "US" is the exact corruption that makes Intl.NumberFormat throw
        // RangeError; the schema must stop it at the store boundary.
        expect(migrateAppSettings({ defaultCurrency: "US" }).defaultCurrency).toBe("EUR");
        expect(migrateAppSettings({ defaultCurrency: 42 }).defaultCurrency).toBe("EUR");
        expect(migrateAppSettings({ defaultCurrency: "" }).defaultCurrency).toBe("EUR");
        expect(migrateAppSettings({ defaultCurrency: "EURO" }).defaultCurrency).toBe("EUR");
    });

    it("accepts any well-formed 3-letter code, not just the dropdown list", () => {
        expect(migrateAppSettings({ defaultCurrency: "BTC" }).defaultCurrency).toBe("BTC");
        expect(migrateAppSettings({ defaultCurrency: "XXX" }).defaultCurrency).toBe("XXX");
    });

    it("falls back to the default decimals for out-of-range showDecimalPlaces", () => {
        // -1, NaN and 101 each make Intl.NumberFormat throw
        // "minimumFractionDigits value is out of range".
        expect(migrateAppSettings({ showDecimalPlaces: -1 }).showDecimalPlaces).toBe(2);
        expect(migrateAppSettings({ showDecimalPlaces: NaN }).showDecimalPlaces).toBe(2);
        expect(migrateAppSettings({ showDecimalPlaces: 101 }).showDecimalPlaces).toBe(2);
        expect(migrateAppSettings({ showDecimalPlaces: 1.5 }).showDecimalPlaces).toBe(2);
        expect(migrateAppSettings({ showDecimalPlaces: "2" }).showDecimalPlaces).toBe(2);
    });

    it("the sanitized settings render real localized money on every surface", () => {
        // End-to-end over the finding's failure mode: a corrupted blob used to
        // reach the formatters and render "1234.56" (US decimal point, no
        // symbol, no grouping) in a de-DE app. Post-schema the defaults render.
        const m = migrateAppSettings({ defaultCurrency: "US", showDecimalPlaces: -1 });
        const out = new Intl.NumberFormat("de-DE", {
            style: "currency",
            currency: m.defaultCurrency,
            minimumFractionDigits: m.showDecimalPlaces,
            maximumFractionDigits: m.showDecimalPlaces,
        }).format(1234.56);
        expect(out).toBe("1.234,56 €");
    });

    it("catches malformed fields individually without dropping valid siblings", () => {
        const m = migrateAppSettings({
            defaultCurrency: "USD",
            showDecimalPlaces: 999,
            adminMode: "yes",
            startupSection: "nowhere",
        });
        expect(m.defaultCurrency).toBe("USD");
        expect(m.showDecimalPlaces).toBe(2);
        expect(m.adminMode).toBe(false);
        expect(m.startupSection).toBe("budgeting");
    });

    it("falls back to defaults wholesale when the blob is not an object", () => {
        expect(migrateAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
        expect(migrateAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
        expect(migrateAppSettings("garbage")).toEqual(DEFAULT_APP_SETTINGS);
        expect(migrateAppSettings([1])).toEqual(DEFAULT_APP_SETTINGS);
    });

    it("drops a wrong-typed aiDefaultModel instead of keeping garbage", () => {
        expect(migrateAppSettings({ aiDefaultModel: 123 }).aiDefaultModel).toBeUndefined();
        expect(migrateAppSettings({ aiDefaultModel: "claude-haiku" }).aiDefaultModel).toBe(
            "claude-haiku",
        );
    });

    it("a malformed visualEffects falls back without breaking the legacy mapping", () => {
        expect(migrateAppSettings({ visualEffects: "ultra" }).visualEffects).toBe("standard");
        expect(
            migrateAppSettings({ visualEffects: "ultra", enhancedEffects: true }).visualEffects,
        ).toBe("enhanced");
    });
});
