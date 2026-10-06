import type { WidgetDefinition } from "@/hooks/useWidgetVisibility";

/**
 * Columns the user can show or hide from the View menu (ADR-181). The core
 * columns (select, date, payee, category, account, amount) are always shown;
 * these persist per user through the same `widget_visibility` setting the
 * Home widgets use, under the `transactionsColumns` page key.
 */
export const TRANSACTIONS_COLUMNS_PAGE_KEY = "transactionsColumns";

export const OPTIONAL_TRANSACTION_COLUMNS: WidgetDefinition[] = [
    { id: "tags", labelKey: "txPage.col.tags", defaultVisible: false },
    { id: "currency", labelKey: "txPage.col.currency", defaultVisible: false },
    {
        id: "runningBalance",
        labelKey: "txPage.col.runningBalance",
        defaultVisible: false,
    },
    { id: "is_active", labelKey: "txPage.col.status", defaultVisible: false },
];

export type DatePreset = "any" | "thisMonth" | "lastMonth" | "thisYear";

/** Inclusive YYYY-MM-DD bounds for a preset, from the local calendar date `today`. */
export function datePresetRange(
    preset: DatePreset,
    today: Date,
): { start: string; end: string } | undefined {
    const ymd = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const y = today.getFullYear();
    const m = today.getMonth();
    switch (preset) {
        case "thisMonth":
            return { start: ymd(new Date(y, m, 1)), end: ymd(new Date(y, m + 1, 0)) };
        case "lastMonth":
            return { start: ymd(new Date(y, m - 1, 1)), end: ymd(new Date(y, m, 0)) };
        case "thisYear":
            return { start: ymd(new Date(y, 0, 1)), end: ymd(new Date(y, 11, 31)) };
        default:
            return undefined;
    }
}

/** The preset a start/end pair corresponds to, or undefined for a custom range. */
export function datePresetFor(
    start: string | undefined,
    end: string | undefined,
    today: Date,
): DatePreset | undefined {
    if (!start && !end) return "any";
    for (const preset of ["thisMonth", "lastMonth", "thisYear"] as const) {
        const range = datePresetRange(preset, today);
        if (range && range.start === start && range.end === end) return preset;
    }
    return undefined;
}
