// @refresh reset
/**
 * Language / i18n context.
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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import logger from '@/lib/logger';
import { LOCAL_STORAGE_KEYS } from '@/lib/localStorage-keys';

export type Language = 'en' | 'nl';

// Vite will code-split each dynamic import into its own chunk.
// Generated TS modules (apps/frontend/src/locales/*.ts) are code-split so only
// the active locale is downloaded and parsed. Run the generator to update them.
const loaders: Record<Language, () => Promise<{ default: Record<string, string> }>> = {
    en: () => import('../locales/en'),
    nl: () => import('../locales/nl'),
};

const englishLoader = loaders.en;

// Kick the fallback (English) dictionary fetch off at module-evaluation time so
// the chunk request overlaps the entry bundle's execution + React mount, instead
// of only starting after first commit — this removes the raw-key flash on cold
// boot (keys like `nav.dashboard` rendering literally until the dict arrives).
const enDictPromise: Promise<Record<string, string>> = englishLoader()
    .then((mod) => mod.default)
    .catch((err) => {
        logger.error('Failed to preload fallback locale "en":', err);
        return {} as Record<string, string>;
    });

// Language mirrored to localStorage on the previous session (server value still
// wins on hydration). Reading it synchronously lets a non-English user warm the
// active locale chunk during entry execution rather than waiting behind the
// settings API round trip.
function readCachedLanguage(): Language {
    try {
        return localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE) === 'nl' ? 'nl' : 'en';
    } catch {
        return 'en';
    }
}
const cachedLanguage = readCachedLanguage();
if (cachedLanguage !== 'en') {
    // Fire-and-forget: warms Vite's module cache so the later effect-driven
    // import resolves from cache instead of a fresh request.
    void loaders[cachedLanguage]();
}

// Type-safe key is derived from the English dictionary at compile time.
// We keep a static reference only to en for TypeScript — it is not bundled at runtime.
export type TranslationKey = string;

export interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
    /**
     * Plural-aware translation. Resolves `${key}.${category}` where category is
     * the Intl.PluralRules CLDR plural category for `count` in the active locale
     * (e.g. `one` / `other`), falling back to `${key}.other` then `${key}`.
     * `count` is always available as a `{count}` interpolation var.
     */
    tc: (key: TranslationKey, count: number, vars?: Record<string, string | number>) => string;
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

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
    children: ReactNode;
    language: Language;
    setLanguage: (lang: Language) => void;
}

export function LanguageProvider({ children, language, setLanguage }: LanguageProviderProps) {
    // activeDict holds the lazily loaded translations for `language`.
    // We start with an empty dict so the app renders immediately and keys fall
    // back to themselves (visible for <1 render cycle on cold load).
    const [dicts, setDicts] = useState<Partial<Record<Language, Record<string, string>>>>({});

    useEffect(() => {
        if (dicts.en) return;
        let cancelled = false;
        void enDictPromise.then((en) => {
            if (!cancelled) setDicts((prev) => (prev.en ? prev : { ...prev, en }));
        });
        return () => { cancelled = true; };
    }, [dicts.en]);

    useEffect(() => {
        // If we already loaded this locale, nothing to do.
        if (dicts[language]) return;

        loaders[language]()
            .then((mod) => {
                setDicts((prev) => ({ ...prev, [language]: mod.default }));
            })
            .catch((err) => {
                logger.error(`Failed to load locale "${language}":`, err);
            });
    }, [language, dicts]);

    const t = useCallback(
        (key: TranslationKey, vars?: Record<string, string | number>): string => {
            const dict = dicts[language];
            const enDict = dicts['en'];
            let text = dict?.[key] ?? enDict?.[key] ?? key;
            if (vars) {
                for (const [k, v] of Object.entries(vars)) {
                    text = text.replaceAll(`{${k}}`, String(v));
                }
            }
            return text;
        },
        [dicts, language]
    );

    const tc = useCallback(
        (key: TranslationKey, count: number, vars?: Record<string, string | number>): string => {
            const dict = dicts[language];
            const enDict = dicts['en'];
            const category = getPluralRules(language).select(count);
            const lookup = (cat: string) => dict?.[`${key}.${cat}`] ?? enDict?.[`${key}.${cat}`];
            let text = lookup(category) ?? lookup('other') ?? dict?.[key] ?? enDict?.[key] ?? key;
            const allVars: Record<string, string | number> = { count, ...vars };
            for (const [k, v] of Object.entries(allVars)) {
                text = text.replaceAll(`{${k}}`, String(v));
            }
            return text;
        },
        [dicts, language]
    );

    const value = useMemo(
        () => ({ language, setLanguage, t, tc }),
        [language, setLanguage, t, tc]
    );

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLanguage(): LanguageContextType {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error('useLanguage must be used inside <LanguageProvider>');
    return ctx;
}
