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

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import logger from '@/lib/logger';

export type Language = 'en' | 'nl';

// Vite will code-split each dynamic import into its own chunk.
// Generated TS modules (apps/frontend/src/locales/*.ts) are code-split so only
// the active locale is downloaded and parsed. Run the generator to update them.
const loaders: Record<Language, () => Promise<{ default: Record<string, string> }>> = {
    en: () => import('../locales/en'),
    nl: () => import('../locales/nl'),
};

const englishLoader = loaders.en;

// Type-safe key is derived from the English dictionary at compile time.
// We keep a static reference only to en for TypeScript — it is not bundled at runtime.
export type TranslationKey = string;

export interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
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
        englishLoader()
            .then((mod) => {
                setDicts((prev) => (prev.en ? prev : { ...prev, en: mod.default }));
            })
            .catch((err) => {
                logger.error('Failed to preload fallback locale "en":', err);
            });
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

    const value = useMemo(
        () => ({ language, setLanguage, t }),
        [language, setLanguage, t]
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
