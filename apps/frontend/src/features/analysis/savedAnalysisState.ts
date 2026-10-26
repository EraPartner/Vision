/**
 * Reads the untyped JSON of a saved analysis (`definition`, `parameters`) back
 * into the workspace's editor state. Saved analyses are validated by the
 * backend when written, so the guards here are deliberately shallow: they check
 * the top-level shape the editor relies on and fall back to the editor defaults
 * for anything else, instead of trusting the blob with a type assertion.
 */
import { CurrencyCodeSchema } from "@vision/types/brands";
import type {
    AnalysisFilter,
    AnalysisPivotConfig,
    SavedAnalysis,
    VisualAnalysisPlan,
} from "@/lib/api/analysis";
import { isAnalysisValue } from "@/lib/analysisValue";
import type { AnalysisScenarioModel } from "@/features/analysis/analysisInterchange";
import type { AnalysisWorkbenchConfig } from "@/features/analysis/AnalysisWorkbenchPanel";
import { isRecord } from "@/lib/isRecord";

const isString = (value: unknown): value is string => typeof value === "string";

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter(isString) : [];

const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

export const savedDatasetIds = (saved: SavedAnalysis): string[] =>
    records(saved.definition.datasets).flatMap(({ id, datasetId }) => {
        const resolved = id ?? datasetId;
        return isString(resolved) && resolved ? [resolved] : [];
    });

export function visualPlanFromSource(
    source: Record<string, unknown>,
): VisualAnalysisPlan {
    const select = records(source.select).map((entry) => ({
        id: String(entry.id),
        kind: isRecord(entry.source) ? entry.source.kind : undefined,
    }));
    const filters: AnalysisFilter[] = records(source.filters).map((filter) => {
        const left = isRecord(filter.left) ? filter.left : {};
        const columnId = String(left.columnId);
        const value = isRecord(filter.right) ? filter.right.value : undefined;
        return {
            fieldId:
                left.datasetId === "accounts" ? `account.${columnId}` : columnId,
            operator: String(filter.operator),
            value: isAnalysisValue(value) ? value : undefined,
        };
    });
    return {
        datasetId: String(source.datasetId),
        fields: select
            .filter((entry) => entry.kind === "field")
            .map((entry) => entry.id),
        measures: select
            .filter((entry) => entry.kind === "metric")
            .map((entry) => entry.id),
        filters,
        groups: strings(source.groupBy),
        joins: records(source.joins).flatMap(({ pathId }) =>
            isString(pathId) ? [pathId] : [],
        ),
        orderBy: records(source.orderBy).flatMap(({ outputId, direction }) =>
            isString(outputId)
                ? [{ id: outputId, direction: direction === "desc" ? "desc" : "asc" } as const]
                : [],
        ),
        limit: Number(source.limit) > 0 ? Number(source.limit) : 500,
    };
}

export function sourceFromSaved(saved: SavedAnalysis): {
    mode: "visual" | "sql";
    plan?: VisualAnalysisPlan;
    sql?: string;
    datasetIds?: string[];
    visualOrigin?: VisualAnalysisPlan | undefined;
} {
    const source = saved.definition.source;
    if (!isRecord(source)) {
        return { mode: "sql", sql: "", datasetIds: [], visualOrigin: undefined };
    }
    if (source.kind === "visual-plan") {
        return { mode: "visual", plan: visualPlanFromSource(source) };
    }
    return {
        mode: "sql",
        sql: typeof source.text === "string" ? source.text : "",
        datasetIds: strings(source.datasetIds),
        visualOrigin: isRecord(source.visualOrigin)
            ? visualPlanFromSource(source.visualOrigin)
            : undefined,
    };
}

export const EMPTY_SCENARIO_MODEL: AnalysisScenarioModel = {
    attachments: [],
    joins: [],
};

// Shallow gate: the backend validated the element shapes on save.
const isScenarioModel = (value: unknown): value is AnalysisScenarioModel =>
    isRecord(value) &&
    Array.isArray(value.attachments) &&
    Array.isArray(value.joins);

export function savedScenarioModel(value: unknown): AnalysisScenarioModel {
    return isScenarioModel(value) ? value : EMPTY_SCENARIO_MODEL;
}

// Every workbench field is optional, so any object is a (possibly empty)
// config; element shapes were validated by the backend on save.
const isWorkbenchConfig = (value: unknown): value is AnalysisWorkbenchConfig =>
    isRecord(value);

export const savedWorkbench = (value: unknown): AnalysisWorkbenchConfig =>
    isWorkbenchConfig(value) ? value : {};

/** `undefined` when the saved pivot config is absent or not a pivot config. */
export function savedPivotConfig(value: unknown): AnalysisPivotConfig | undefined {
    if (!isRecord(value)) return undefined;
    return {
        rows: strings(value.rows),
        columns: strings(value.columns),
        values: strings(value.values),
        filters: Array.isArray(value.filters)
            ? value.filters.filter(isRecord).map((filter) => ({
                  fieldId: String(filter.fieldId),
                  operator: String(filter.operator),
                  value: isAnalysisValue(filter.value) ? filter.value : undefined,
              }))
            : [],
    };
}

/** The plan fields a saved analysis stores outside the visual-plan source. */
export function savedFinancialPlan(value: unknown): Partial<VisualAnalysisPlan> {
    if (!isRecord(value)) return {};
    const out: Partial<VisualAnalysisPlan> = {};
    const currency = CurrencyCodeSchema.safeParse(value.reportingCurrency);
    if (currency.success) out.reportingCurrency = currency.data;
    for (const key of ["from", "to", "symbol", "range", "costBasisMethod"] as const) {
        const field = value[key];
        if (isString(field)) out[key] = field;
    }
    return out;
}

export interface SavedFormulaModel {
    formulas: unknown[];
    assumptions: unknown[];
    assumptionValues: Record<string, unknown>;
}

export function savedFormulaModel(value: unknown): SavedFormulaModel {
    const model = isRecord(value) ? value : {};
    return {
        formulas: Array.isArray(model.formulas) ? model.formulas : [],
        assumptions: Array.isArray(model.assumptions) ? model.assumptions : [],
        assumptionValues: isRecord(model.assumptionValues)
            ? model.assumptionValues
            : {},
    };
}
