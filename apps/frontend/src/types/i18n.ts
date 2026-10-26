import type { TranslationKey } from "@/locales/keys";

export type Language = "en" | "nl";

/**
 * The part of a translation key that follows `Prefix`, for helpers that
 * namespace their keys (`tr("option.sum")` -> `analysis.ext.workbench.option.sum`).
 * Resolves to `never` when no key starts with the prefix.
 */
export type TranslationKeySuffix<Prefix extends string> =
    TranslationKey extends infer K
        ? K extends `${Prefix}${infer Suffix}`
            ? Suffix
            : never
        : never;
