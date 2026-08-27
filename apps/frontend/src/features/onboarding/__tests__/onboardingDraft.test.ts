// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    clearOnboardingDraft,
    createDefaultOnboardingDraft,
    readOnboardingDraft,
    writeOnboardingDraft,
} from "@/features/onboarding/onboardingDraft";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

function installMemoryLocalStorage() {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => backing.get(key) ?? null,
            setItem: (key: string, value: string) =>
                void backing.set(key, String(value)),
            removeItem: (key: string) => void backing.delete(key),
            clear: () => backing.clear(),
        },
    });
}

beforeEach(installMemoryLocalStorage);
afterEach(clearOnboardingDraft);

describe("onboardingDraft", () => {
    it("round-trips validated progress and filters stale category indexes", () => {
        expect(
            writeOnboardingDraft({
                version: 1,
                step: "import",
                selectedBank: "kbc",
                selectedCategoryIndexes: [3, 1, 3, 99],
                categoriesCreated: true,
                importResult: { imported: 8, duplicates: 2 },
                reviewBatch: null,
            }),
        ).toBe(true);

        expect(readOnboardingDraft(5)).toEqual({
            version: 1,
            step: "import",
            selectedBank: "kbc",
            selectedCategoryIndexes: [3, 1],
            categoriesCreated: true,
            importResult: { imported: 8, duplicates: 2 },
            reviewBatch: null,
        });
    });

    it.each([
        "not-json",
        JSON.stringify({ version: 2, step: "bank" }),
        JSON.stringify({
            version: 1,
            step: "unknown",
            selectedBank: "",
            selectedCategoryIndexes: [],
            categoriesCreated: false,
            importResult: null,
            reviewBatch: null,
        }),
    ])("falls back safely for invalid input", (raw) => {
        localStorage.setItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT, raw);
        expect(readOnboardingDraft(3)).toEqual(createDefaultOnboardingDraft(3));
    });

    it("never includes uploaded file or request-state fields", () => {
        writeOnboardingDraft(createDefaultOnboardingDraft(2));
        const raw = localStorage.getItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT);
        expect(raw).not.toContain("file");
        expect(raw).not.toContain("importing");
        expect(raw).not.toContain("creatingCategories");
    });
});
