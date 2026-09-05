// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useState, type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
    LanguageProvider,
    useLanguage,
    type Language,
} from "@/stores/hydration/LanguageHydration";

function makeWrapper(initial: Language = "en") {
    return function Wrapper({ children }: { children: ReactNode }) {
        const [lang, setLang] = useState<Language>(initial);
        return (
            <LanguageProvider language={lang} setLanguage={setLang}>
                {children}
            </LanguageProvider>
        );
    };
}

describe("LanguageHydration", () => {
    it("reads the default language directly from the settings store", () => {
        const { result } = renderHook(() => useLanguage());
        expect(result.current.language).toBe("en");
    });

    it("returns the key itself before any locale is loaded", () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper(),
        });
        expect(result.current.t("nonexistent.key.xyz")).toBe(
            "nonexistent.key.xyz",
        );
    });

    it("interpolates variables in translation strings once locale loads", async () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper(),
        });
        // addInv.assetTitle = "Add {assetClass}"
        await waitFor(() => {
            expect(
                result.current.t("addInv.assetTitle", { assetClass: "Stock" }),
            ).toBe("Add Stock");
        });
    });

    it("reflects the active language prop", () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper("en"),
        });
        expect(result.current.language).toBe("en");
    });

    it("setLanguage updates the active language", () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper("en"),
        });
        act(() => result.current.setLanguage("nl"));
        expect(result.current.language).toBe("nl");
    });

    it("returns nl translation when language is nl", async () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper("nl"),
        });
        await waitFor(() => {
            // addInv.back = "Terug" in nl locale
            expect(result.current.t("addInv.back")).toBe("Terug");
        });
    });

    it("interpolation handles missing parameters gracefully", async () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => {
            // Missing param leaves placeholder intact (or returns key)
            const out = result.current.t("addInv.assetTitle", {});
            expect(typeof out).toBe("string");
        });
    });

    it("setLanguage to same value is a no-op (idempotent)", () => {
        const { result } = renderHook(() => useLanguage(), {
            wrapper: makeWrapper("en"),
        });
        const before = result.current.language;
        act(() => result.current.setLanguage("en"));
        expect(result.current.language).toBe(before);
    });

    it("switching back to en after nl restores en translations", async () => {
        let outerSet: ((l: Language) => void) | null = null;
        function CaptureWrapper({ children }: { children: ReactNode }) {
            const [lang, setLang] = useState<Language>("en");
            outerSet = setLang;
            return (
                <LanguageProvider language={lang} setLanguage={setLang}>
                    {children}
                </LanguageProvider>
            );
        }
        const { result } = renderHook(() => useLanguage(), {
            wrapper: CaptureWrapper,
        });
        await waitFor(() =>
            expect(result.current.t("addInv.back")).toBe("Back"),
        );
        act(() => outerSet?.("nl"));
        await waitFor(() =>
            expect(result.current.t("addInv.back")).toBe("Terug"),
        );
        act(() => outerSet?.("en"));
        await waitFor(() =>
            expect(result.current.t("addInv.back")).toBe("Back"),
        );
    });
});
