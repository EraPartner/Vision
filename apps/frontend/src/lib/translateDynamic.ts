import type { TranslationKey } from "@/locales/keys";

type Translate = (
    key: TranslationKey,
    vars?: Record<string, string | number>,
) => string;

/**
 * Translate a key that only exists at runtime: server-provided i18n keys, zod
 * issue messages, or keys assembled from backend codes. `t` already tolerates
 * an unknown key by returning it unchanged (so a miss is visible, never a
 * crash), which is exactly the behavior this wrapper preserves.
 *
 * This is the app's single `as TranslationKey` boundary. Anything whose key set
 * is known at compile time must use a literal, a literal-union template or a
 * `Record<Union, TranslationKey>` map instead, so tsc checks it.
 */
export function translateDynamic(
    t: Translate,
    key: string,
    vars?: Record<string, string | number>,
): string {
    return t(key as TranslationKey, vars);
}
