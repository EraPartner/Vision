import type { AppSettings } from "@/stores/settingsStore";

export type AnalysisAnswerDepth = "quick" | "detailed";
export type AnalysisLanguage = "en" | "nl";

export interface EffectiveAnalysisPreferences {
    currency: string;
    benchmark: string | null;
    answerDepth: AnalysisAnswerDepth;
    language: AnalysisLanguage;
}

export interface AnalysisPreferenceLayer {
    currency?: unknown;
    benchmark?: unknown;
    answerDepth?: unknown;
    language?: unknown;
}

export const PRODUCT_ANALYSIS_PREFERENCES: EffectiveAnalysisPreferences = {
    currency: "EUR",
    benchmark: null,
    answerDepth: "quick",
    language: "en",
};

const currency = (value: unknown): string | undefined =>
    typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined;
const benchmark = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toUpperCase();
    return /^[A-Z0-9][A-Z0-9._:-]{0,31}$/.test(normalized)
        ? normalized
        : undefined;
};
const depth = (value: unknown): AnalysisAnswerDepth | undefined =>
    value === "quick" || value === "detailed" ? value : undefined;
const language = (value: unknown): AnalysisLanguage | undefined =>
    value === "en" || value === "nl" ? value : undefined;

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
    values.find((value) => value !== undefined);

/**
 * Resolve explicit analysis choices without inferring financial preferences.
 * Each field independently follows run -> saved analysis -> application ->
 * product precedence, so deleting one saved value exposes the next layer.
 */
export function resolveAnalysisPreferences({
    run = {},
    saved = {},
    appSettings,
}: {
    run?: AnalysisPreferenceLayer;
    saved?: AnalysisPreferenceLayer;
    appSettings?: Partial<AppSettings>;
}): EffectiveAnalysisPreferences {
    const app: AnalysisPreferenceLayer = {
        currency: appSettings?.defaultCurrency,
        benchmark: appSettings?.analysisBenchmark,
        answerDepth: appSettings?.aiAnswerDepth,
        language: appSettings?.language,
    };
    return {
        currency:
            currency(run.currency) ??
            currency(saved.currency) ??
            currency(app.currency) ??
            PRODUCT_ANALYSIS_PREFERENCES.currency,
        benchmark:
            firstDefined(
                benchmark(run.benchmark),
                benchmark(saved.benchmark),
                benchmark(app.benchmark),
            ) ?? PRODUCT_ANALYSIS_PREFERENCES.benchmark,
        answerDepth:
            depth(run.answerDepth) ??
            depth(saved.answerDepth) ??
            depth(app.answerDepth) ??
            PRODUCT_ANALYSIS_PREFERENCES.answerDepth,
        language:
            language(run.language) ??
            language(saved.language) ??
            language(app.language) ??
            PRODUCT_ANALYSIS_PREFERENCES.language,
    };
}
