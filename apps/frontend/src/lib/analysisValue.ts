import type { AnalysisValue } from "@/lib/api/analysis";

/** Scalar cell value of an analysis result (string, number, boolean or null). */
export const isAnalysisValue = (value: unknown): value is AnalysisValue =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
