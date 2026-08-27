import { z } from "zod";

import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

export const ONBOARDING_STEP_KEYS = [
    "welcome",
    "overview",
    "categories",
    "bank",
    "import",
    "tour",
    "backup",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

const countSchema = z.number().int().nonnegative().safe();

const onboardingDraftSchema = z
    .object({
        version: z.literal(1),
        step: z.enum(ONBOARDING_STEP_KEYS),
        selectedBank: z.string().trim().max(128),
        selectedCategoryIndexes: z
            .array(z.number().int().nonnegative().safe())
            .max(100),
        categoriesCreated: z.boolean(),
        importResult: z
            .object({ imported: countSchema, duplicates: countSchema })
            .strict()
            .nullable(),
        reviewBatch: z
            .object({
                batchId: z.number().int().positive().safe(),
                rows: countSchema,
            })
            .strict()
            .nullable(),
    })
    .strict();

export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;

export function createDefaultOnboardingDraft(
    categoryCount: number,
): OnboardingDraft {
    return {
        version: 1,
        step: "welcome",
        selectedBank: "",
        selectedCategoryIndexes: Array.from(
            { length: categoryCount },
            (_, index) => index,
        ),
        categoriesCreated: false,
        importResult: null,
        reviewBatch: null,
    };
}

export function readOnboardingDraft(categoryCount: number): OnboardingDraft {
    const fallback = createDefaultOnboardingDraft(categoryCount);
    try {
        const raw = window.localStorage.getItem(
            LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT,
        );
        if (!raw) return fallback;
        const parsed = onboardingDraftSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return fallback;

        const selectedCategoryIndexes = Array.from(
            new Set(
                parsed.data.selectedCategoryIndexes.filter(
                    (index) => index < categoryCount,
                ),
            ),
        );
        return { ...parsed.data, selectedCategoryIndexes };
    } catch {
        return fallback;
    }
}

export function writeOnboardingDraft(draft: OnboardingDraft): boolean {
    const parsed = onboardingDraftSchema.safeParse(draft);
    if (!parsed.success) return false;
    try {
        window.localStorage.setItem(
            LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT,
            JSON.stringify(parsed.data),
        );
        return true;
    } catch {
        return false;
    }
}

export function clearOnboardingDraft(): void {
    try {
        window.localStorage.removeItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT);
    } catch {
        // Storage can be unavailable in hardened/private browser contexts.
    }
}
