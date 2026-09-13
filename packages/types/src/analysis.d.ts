import type { z } from "zod";

export declare const ANALYSIS_CONTRACT_VERSION: 1;
export declare const ANALYSIS_WORKSPACES: readonly [
  "budgeting",
  "portfolio",
  "research",
  "cross-workspace",
];
export declare const ANALYSIS_VALUE_TYPES: readonly [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "currency",
];

export type AnalysisWorkspace = (typeof ANALYSIS_WORKSPACES)[number];
export type AnalysisValueType = (typeof ANALYSIS_VALUE_TYPES)[number];
export type AnalysisScalar = string | number | boolean | null;
export type AnalysisCoverageStatus =
  "complete" | "partial" | "unknown" | "unavailable";

export interface AnalysisUnit {
  kind: "money" | "percentage" | "quantity" | "count" | "duration";
  currency?: string;
  currencyParameterId?: string;
  percentageBasis?: "ratio" | "percent";
  scale?: number;
}
export interface AnalysisTypedValue {
  id: string;
  label: string;
  type: AnalysisValueType;
  unit?: AnalysisUnit;
}
export interface AnalysisParameter extends AnalysisTypedValue {
  required: boolean;
  defaultValue?: AnalysisScalar;
  sensitive: boolean;
}
export interface AnalysisAssumption extends AnalysisTypedValue {
  defaultValue: AnalysisScalar;
  editable: boolean;
  source: "user" | "template";
}
export interface AnalysisCalculation {
  id: string;
  label: string;
  kind: "metric" | "formula";
  expression: string;
  resultType: AnalysisValueType;
  languageVersion: string;
  metricVersion?: string;
  dependencies: string[];
  unit?: AnalysisUnit;
  rounding?: { mode: "half-even"; scale: number };
}
export interface AnalysisResultColumn {
  id: string;
  label: string;
  type: AnalysisValueType;
  nullable: boolean;
  semanticType?: string;
  unit?: AnalysisUnit;
  calculationId?: string;
  calculationVersion?: string;
}
export interface AnalysisFieldReference {
  kind: "field";
  datasetId: string;
  columnId: string;
}
export interface AnalysisVisualPlanSource {
  kind: "visual-plan";
  planVersion: number;
  datasetId: string;
  select: Array<{
    id: string;
    source: AnalysisFieldReference | { kind: "metric"; calculationId: string };
  }>;
  joins: Array<{ datasetId: string; type: "inner" | "left"; pathId: string }>;
  filters: Array<{
    left: AnalysisFieldReference;
    operator:
      | "eq"
      | "neq"
      | "lt"
      | "lte"
      | "gt"
      | "gte"
      | "contains"
      | "starts-with"
      | "is-null"
      | "is-not-null";
    right?:
      | { kind: "parameter" | "assumption"; id: string }
      | { kind: "literal"; value: AnalysisScalar };
  }>;
  groupBy: string[];
  orderBy: Array<{ outputId: string; direction: "asc" | "desc" }>;
  limit?: number;
  generatedSql?: string;
}
export interface AnalysisCustomSqlSource {
  kind: "custom-sql";
  dialect: "postgresql";
  text: string;
  datasetIds: string[];
  parameterBindings: Array<{
    parameterId: string;
    startCodeUnit: number;
    endCodeUnit: number;
  }>;
  visualConversion: {
    status: "convertible" | "unsupported";
    reasonCode?: string;
  };
  visualOrigin?: AnalysisVisualPlanSource;
}
export interface AnalysisPresentationRequirement {
  columns: AnalysisResultColumn[];
  completeResult: boolean;
}
export type AnalysisPresentation =
  | {
      id: string;
      kind: "grid";
      bindings: { columns: string[] };
      requires: AnalysisPresentationRequirement;
    }
  | {
      id: string;
      kind: "line" | "bar" | "area";
      bindings: { x: string; y: string[] };
      requires: AnalysisPresentationRequirement;
    }
  | {
      id: string;
      kind: "pie";
      bindings: { category: string; value: string };
      requires: AnalysisPresentationRequirement;
    }
  | {
      id: string;
      kind: "pivot";
      bindings: { rows: string[]; columns: string[]; values: string[] };
      requires: AnalysisPresentationRequirement;
    };

export interface AnalysisDefinition {
  contractVersion: 1;
  definitionId: string;
  definitionVersion: number;
  name: string;
  workspace: AnalysisWorkspace;
  datasets: Array<{
    id: string;
    schemaVersion: number;
    requiredColumns: string[];
    authorizationScope: string;
  }>;
  source: AnalysisVisualPlanSource | AnalysisCustomSqlSource;
  parameters: AnalysisParameter[];
  calculations: AnalysisCalculation[];
  assumptions: AnalysisAssumption[];
  presentations: AnalysisPresentation[];
  expectedResult: { columns: AnalysisResultColumn[] };
  reporting: {
    currencyParameterId: string;
    timezoneParameterId: string;
    dateFromParameterId: string;
    dateToParameterId: string;
  };
}

export interface AnalysisSourceIdentity {
  providerId: string;
  sourceId: string;
  sourceVersion: string;
  asOf: string;
  contentHash?: string;
  uri?: string;
  passageId?: string;
}
export type AnalysisLineage =
  | {
      kind: "records";
      datasetId: string;
      records: Array<{
        entity: string;
        id: string;
        source?: AnalysisSourceIdentity;
      }>;
    }
  | {
      kind: "opaque";
      datasetId: string;
      token: string;
      reason: string;
      sources: AnalysisSourceIdentity[];
    };
export interface AnalysisResultRow {
  id: string;
  values: Record<string, AnalysisScalar>;
  lineage: AnalysisLineage[];
}
export type AnalysisResultWindow =
  | { kind: "complete"; totalRows: number }
  | {
      kind: "page";
      offset: number;
      limit: number;
      totalRows?: number;
      hasMore: boolean;
    }
  | {
      kind: "truncated";
      returnedRows: number;
      rowLimit: number;
      totalRows?: number;
      reason: string;
    };
export interface AnalysisCoverageItem {
  id: string;
  status: AnalysisCoverageStatus;
  reasonCode?: string;
  detail?: string;
  missingRatio?: string;
  sources: AnalysisSourceIdentity[];
}
export type AnalysisCalculationResult =
  | {
      id: string;
      status: "ok";
      kind: "metric" | "formula";
      version: string;
      type: AnalysisValueType;
      unit?: AnalysisUnit;
      value: AnalysisScalar;
    }
  | {
      id: string;
      status: "error";
      kind: "metric" | "formula";
      version: string;
      type: AnalysisValueType;
      unit?: AnalysisUnit;
      error: { code: string; message: string };
    };
export interface AnalysisResultData {
  schemaVersion: number;
  rowGrain: { id: string; description: string; keys: string[] };
  columns: AnalysisResultColumn[];
  rows: AnalysisResultRow[];
  window: AnalysisResultWindow;
}
interface AnalysisExecutionCommon {
  contractVersion: 1;
  runId: string;
  definitionRef: { definitionId: string; definitionVersion: number };
  startedAt: string;
  execution: {
    executorId: string;
    executorVersion: string;
    queryMode: "visual-plan" | "custom-sql";
    durationMs?: number;
    snapshot: {
      consistency: "repeatable-read" | "frozen-inputs" | "best-effort";
      id: string;
      capturedAt: string;
    };
    effectiveParameters: Record<string, AnalysisScalar>;
    effectiveAssumptions: Record<string, AnalysisScalar>;
  };
  reporting: {
    currency: string;
    timezone: string;
    dateRange: { from: string; to: string; bounds: "inclusive" };
  };
  sourceVersions: Array<{
    datasetId: string;
    schemaVersion: number;
    revision: string;
    capturedAt: string;
  }>;
  calculationResults: AnalysisCalculationResult[];
  coverage: {
    status: AnalysisCoverageStatus;
    datasets: AnalysisCoverageItem[];
    dimensions: AnalysisCoverageItem[];
    warnings: Array<{
      code: string;
      message: string;
      affectedColumns?: string[];
    }>;
  };
}
export type AnalysisExecutionResult =
  | (AnalysisExecutionCommon & { status: "queued" | "running" })
  | (AnalysisExecutionCommon & {
      status: "partial" | "completed";
      completedAt: string;
      data: AnalysisResultData;
    })
  | (AnalysisExecutionCommon & {
      status: "failed" | "cancelled";
      completedAt: string;
      error: { code: string; message: string };
    });

export declare const analysisDefinitionSchema: z.ZodType<AnalysisDefinition>;
export declare const analysisExecutionResultSchema: z.ZodType<AnalysisExecutionResult>;
export interface AnalysisCompatibilityReason {
  code: string;
  path: string;
  message: string;
}
export type AnalysisCompatibility =
  | { compatible: true }
  | { compatible: false; reasons: AnalysisCompatibilityReason[] };
export declare function checkAnalysisResultCompatibility(
  definition: unknown,
  result: unknown,
): AnalysisCompatibility;
