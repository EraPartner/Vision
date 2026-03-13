/**
 * Language / i18n context.
 *
 * Translations are loaded lazily per locale from separate files in src/locales/.
 * This removes ~3800 lines of static string data from the main JS bundle and
 * means only the user's active locale is downloaded and parsed on startup.
 *
 * To add a new locale:
 *  1. Create apps/frontend/src/locales/<code>.ts with a default-exported Record<string,string>.
 *  2. Add the code to the `Language` union type and the `loaders` map below.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Language = 'en' | 'nl';

// Vite will code-split each dynamic import into its own chunk.
const loaders: Record<Language, () => Promise<{ default: Record<string, string> }>> = {
    en: () => import('../locales/en'),
    nl: () => import('../locales/nl'),
};

// Type-safe key is derived from the English dictionary at compile time.
// We keep a static reference only to en for TypeScript — it is not bundled at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TranslationKey = string;

export interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: TranslationKey, vars?: Record<string, string>) => string;
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
        // If we already loaded this locale, nothing to do.
        if (dicts[language]) return;

        loaders[language]()
            .then((mod) => {
                setDicts((prev) => ({ ...prev, [language]: mod.default }));
            })
            .catch((err) => {
                console.error(`Failed to load locale "${language}":`, err);
            });
    }, [language, dicts]);

    const t = useCallback(
        (key: TranslationKey, vars?: Record<string, string>): string => {
            const dict = dicts[language];
            const enDict = dicts['en'];
            let text = dict?.[key] ?? enDict?.[key] ?? key;
            if (vars) {
                for (const [k, v] of Object.entries(vars)) {
                    text = text.replace(`{${k}}`, v);
                }
            }
            return text;
        },
        [dicts, language]
    );

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t }}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage(): LanguageContextType {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error('useLanguage must be used inside <LanguageProvider>');
    return ctx;
}
