/**
 * Language / i18n hydration.
 *
 * Translations are loaded lazily per locale from separate files in src/locales/.
 * This removes ~3800 lines of static string data from the main JS bundle and
 * means only the user's active locale is downloaded and parsed on startup.
 *
 * To add a new locale:
 *  1. Edit i18n/source/<code>.json (the canonical source of translations).
 *  2. Run `node scripts/generate-locales.js` (or add it to your build) to emit
 *     generated frontend TS modules and packaging JSON files.
 *  3. Add the code to the `Language` union type and the `loaders` map below.
 */

import { useCallback, useEffect, useLayoutEffect } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";

import { setNativeLanguage } from "@/lib/api/electron";
import logger from "@/lib/logger";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { useSettingsStore } from "@/stores/settingsStore";
import type { Language } from "@/types/i18n";

export type { Language };

// Vite will code-split each dynamic import into its own chunk.
// Generated TS modules (apps/frontend/src/locales/*.ts) are code-split so only
// the active locale is downloaded and parsed. Run the generator to update them.
const loaders: Record<
    Language,
    () => Promise<{ default: Record<string, string> }>
> = {
    en: () => import("@/locales/en"),
    nl: () => import("@/locales/nl"),
};

const englishLoader = loaders.en;

// Language mirrored to localStorage on the previous session (server value still
// wins on hydration). Reading it synchronously lets a non-English user warm the
// active locale chunk during entry execution rather than waiting behind the
// settings API round trip.
function readCachedLanguage(): Language {
    try {
        return localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE) === "nl"
            ? "nl"
            : "en";
    } catch {
        return "en";
    }
}
const cachedLanguage = readCachedLanguage();

// Kick the active dictionary fetch off at module-evaluation time so the chunk
// request overlaps the entry bundle's execution + React mount instead of only
// starting after first commit — this shrinks the raw-key flash on cold boot.
//
// en is preloaded ONLY when it is the active locale. Every non-en locale has
// full key parity with en (CI-enforced by validate-locales), so en is never
// consulted as a fallback for it — eagerly downloading the ~50 KB gz en dict for
// a Dutch user was pure waste. Non-en users warm their own locale below instead.
const enDictPromise: Promise<Record<string, string>> | null =
    cachedLanguage === "en"
        ? englishLoader()
              .then((mod) => mod.default)
              .catch((err) => {
                  logger.error('Failed to preload locale "en":', err);
                  return {} as Record<string, string>;
              })
        : null;

if (cachedLanguage !== "en") {
    // Fire-and-forget: warms Vite's module cache so the later effect-driven
    // import resolves from cache instead of a fresh request.
    void loaders[cachedLanguage]();
}

// Type-safe key is derived from the English dictionary at compile time.
// We keep a static reference only to en for TypeScript — it is not bundled at runtime.
export type TranslationKey = string;

export interface LanguageState {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
    /**
     * Plural-aware translation. Resolves `${key}.${category}` where category is
     * the Intl.PluralRules CLDR plural category for `count` in the active locale
     * (e.g. `one` / `other`), falling back to `${key}.other` then `${key}`.
     * `count` is always available as a `{count}` interpolation var.
     */
    tc: (
        key: TranslationKey,
        count: number,
        vars?: Record<string, string | number>,
    ) => string;
}

// Intl.PluralRules instances are not free to construct; cache one per locale.
const pluralRulesCache = new Map<Language, Intl.PluralRules>();
function getPluralRules(language: Language): Intl.PluralRules {
    let rules = pluralRulesCache.get(language);
    if (!rules) {
        rules = new Intl.PluralRules(language);
        pluralRulesCache.set(language, rules);
    }
    return rules;
}

interface LanguageDictionaryState {
    dicts: Partial<Record<Language, Record<string, string>>>;
    setDictionary: (
        language: Language,
        dictionary: Record<string, string>,
    ) => void;
}

const useLanguageDictionaryStore = create<LanguageDictionaryState>((set) => ({
    dicts: {},
    setDictionary: (language, dictionary) =>
        set((state) => ({ dicts: { ...state.dicts, [language]: dictionary } })),
}));

export function LanguageHydration({ children }: { children: ReactNode }) {
    const language = useSettingsStore((state) => state.appSettings.language);
    const dicts = useLanguageDictionaryStore((state) => state.dicts);
    const setDictionary = useLanguageDictionaryStore(
        (state) => state.setDictionary,
    );

    useEffect(() => {
        // Only populated when en is the active locale (preloaded above). For a
        // non-en locale enDictPromise is null and en is never loaded as a
        // fallback — the active locale has full key parity, and the
        // language-keyed effect below loads en on demand if the user switches.
        if (dicts.en || !enDictPromise) return;
        let cancelled = false;
        void enDictPromise.then((en) => {
            if (!cancelled && !useLanguageDictionaryStore.getState().dicts.en) {
                setDictionary("en", en);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dicts.en, setDictionary]);

    // Mirror the active locale onto <html lang>. index.html hardcodes lang="en",
    // and browsers parse native `<input type="number">` values against that
    // locale — so without this a Dutch user's "12,50" is rejected as invalid en
    // input. Keeping documentElement.lang in sync with the UI language makes the
    // native numeric inputs comma-tolerant for nl.
    useEffect(() => {
        document.documentElement.lang = language;
        try {
            localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, language);
        } catch {
            // localStorage unavailable — locale prefetch falls back to English.
        }
        setNativeLanguage(language);
    }, [language]);

    useEffect(() => {
        // If we already loaded this locale, nothing to do.
        if (dicts[language]) return;

        loaders[language]()
            .then((mod) => {
                setDictionary(language, mod.default);
            })
            .catch((err) => {
                logger.error(`Failed to load locale "${language}":`, err);
            });
    }, [language, dicts, setDictionary]);

    return <>{children}</>;
}

interface LanguageProviderProps {
    children: ReactNode;
    language: Language;
    setLanguage: (language: Language) => void;
}

/**
 * Test compatibility wrapper for suites that need to force a locale. Runtime
 * composition uses LanguageHydration directly; language still has one source
 * of truth in the settings store.
 */
export function LanguageProvider({
    children,
    language,
    setLanguage: _setLanguage,
}: LanguageProviderProps) {
    useLayoutEffect(() => {
        useSettingsStore.setState((state) => ({
            appSettings: { ...state.appSettings, language },
        }));
    }, [language]);
    return <LanguageHydration>{children}</LanguageHydration>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLanguage(): LanguageState {
    const language = useSettingsStore((state) => state.appSettings.language);
    const updateAppSettings = useSettingsStore(
        (state) => state.updateAppSettings,
    );
    const dicts = useLanguageDictionaryStore((state) => state.dicts);
    const setLanguage = useCallback(
        (nextLanguage: Language) =>
            updateAppSettings({ language: nextLanguage }),
        [updateAppSettings],
    );
    const t = useCallback(
        (
            key: TranslationKey,
            vars?: Record<string, string | number>,
        ): string => {
            const dict = dicts[language];
            const enDict = dicts["en"];
            let text = dict?.[key] ?? enDict?.[key] ?? key;
            if (vars) {
                for (const [k, v] of Object.entries(vars)) {
                    text = text.replaceAll(`{${k}}`, String(v));
                }
            }
            return text;
        },
        [dicts, language],
    );

    const tc = useCallback(
        (
            key: TranslationKey,
            count: number,
            vars?: Record<string, string | number>,
        ): string => {
            const dict = dicts[language];
            const enDict = dicts["en"];
            const category = getPluralRules(language).select(count);
            const lookup = (cat: string) =>
                dict?.[`${key}.${cat}`] ?? enDict?.[`${key}.${cat}`];
            let text =
                lookup(category) ??
                lookup("other") ??
                dict?.[key] ??
                enDict?.[key] ??
                key;
            const allVars: Record<string, string | number> = { count, ...vars };
            for (const [k, v] of Object.entries(allVars)) {
                text = text.replaceAll(`{${k}}`, String(v));
            }
            return text;
        },
        [dicts, language],
    );

    return { language, setLanguage, t, tc };
}
