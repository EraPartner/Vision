/**
 * Radix Select refuses an empty-string item value, so a "none" choice needs a
 * sentinel. `toSelectValue` maps an empty or missing model value onto it and
 * `fromSelectValue` maps it back, so callers keep storing "" for "none".
 */
export const SELECT_NONE = "__none__";

export const toSelectValue = (value: string | null | undefined): string =>
    value ? value : SELECT_NONE;

export const fromSelectValue = (value: string): string =>
    value === SELECT_NONE ? "" : value;
