import {
    AnalysisCatalogSchema,
    AnalysisPivotResultSchema,
    AnalysisProposalPreviewSchema,
    AnalysisResultSchema,
    SavedAnalysisListSchema,
    SavedAnalysisSchema,
    SavedAnalysisVersionListSchema,
} from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";

export interface AnalysisUnit {
    kind: string;
    currency?: string;
    currencyColumn?: string;
    instrumentColumn?: string;
    instrumentId?: string;
    percentageBasis?: string;
}
export interface AnalysisPivotConfig {
    rows: string[];
    columns: string[];
    values: string[];
    filters: AnalysisFilter[];
}
export interface AnalysisPivotResult {
    levels: Array<{
        rowDepth: number;
        columnDepth: number;
        groups: string[];
        rows: Array<
            Record<string, AnalysisValue | Record<string, AnalysisValue>>
        >;
        columns: AnalysisField[];
    }>;
    partitions: string[];
    config: AnalysisPivotConfig;
    coverage: {
        complete: boolean;
        rows: number;
        financialComplete?: boolean;
        unavailableRows?: number;
    };
}
export interface AnalysisExtensionResult {
    rows?: Array<Record<string, AnalysisValue>>;
    columns?: AnalysisField[];
    [key: string]: unknown;
}
export const evaluateAnalysisExtension = (input: Record<string, unknown>) =>
    apiRequest<AnalysisExtensionResult>("/api/analysis/extensions/evaluate", {
        method: "POST",
        body: JSON.stringify(input),
    });
export const executeAnalysisPivot = (
    plan: VisualAnalysisPlan,
    config: AnalysisPivotConfig,
    requestId: string,
) =>
    apiRequest<AnalysisPivotResult>("/api/analysis/pivot", {
        method: "POST",
        body: JSON.stringify({ plan, config, requestId }),
        schema: AnalysisPivotResultSchema,
    });

export type AnalysisWorkspace =
    "budgeting" | "portfolio" | "research" | "cross-workspace";
export type AnalysisValue = string | number | boolean | null;
export interface AnalysisField {
    id: string;
    label: string;
    type: string;
    unit?: AnalysisUnit;
}
export interface AnalysisDataset {
    id: string;
    label: string;
    relation: string;
    fields: AnalysisField[];
    measures: AnalysisField[];
    joins: Array<{
        id: string;
        datasetId: string;
        cardinality: string;
        duplicationSafe: boolean;
    }>;
}
export interface AnalysisCatalog {
    version: number;
    datasets: AnalysisDataset[];
}
export interface AnalysisFilter {
    fieldId: string;
    operator: string;
    value?: AnalysisValue;
}
export interface VisualAnalysisPlan {
    datasetId: string;
    fields: string[];
    filters: AnalysisFilter[];
    groups: string[];
    measures: string[];
    joins: string[];
    orderBy: Array<{ id: string; direction: "asc" | "desc" }>;
    limit: number;
    reportingCurrency?: string;
    from?: string;
    to?: string;
    symbol?: string;
    range?: string;
    costBasisMethod?: string;
}
export interface AnalysisResult {
    complete?: boolean;
    transformationCoverage?: Array<{
        complete?: boolean;
        [key: string]: unknown;
    }>;
    transformationErrors?: Array<{ message?: string; [key: string]: unknown }>;
    preparationLineage?: Array<Record<string, unknown>>;
    sourceResult?: AnalysisResult;
    coverage?: {
        complete?: boolean;
        status?: string;
        unavailableRows?: number;
        sourceRows?: number;
    };
    provenance?: Record<string, unknown>;
    requestId: string;
    startedAt: string;
    completedAt: string;
    executor: string;
    rows: Array<Record<string, AnalysisValue>>;
    columns: Array<{ id: string; type: string; unit?: AnalysisUnit }>;
    declaredColumns?: Array<{
        id: string;
        label: string;
        type: string;
        nullable: boolean;
        unit?: AnalysisUnit;
    }>;
    generatedSql: string;
    byteLength: number;
    formulaErrors?: Array<{
        formulaId: string;
        rowIndex?: number;
        code: string;
        message: string;
    }>;
    formulaSummaries?: Record<string, AnalysisValue>;
    window:
        | {
              kind: "page";
              offset: number;
              limit: number;
              hasMore: boolean;
              returnedRows: number;
          }
        | {
              kind: "truncated";
              returnedRows: number;
              enforcedLimit: number;
              reason: string;
          };
}
export interface SavedAnalysis {
    id: string;
    definitionId: string;
    name: string;
    workspace: AnalysisWorkspace;
    version: number;
    refreshMode: "live" | "frozen";
    parameters: Record<string, unknown>;
    charts: unknown[];
    sourceReferences: unknown[];
    refreshStatus:
        "never-run" | "running" | "succeeded" | "failed" | "cancelled";
    lastSuccessfulRunId: string | null;
    lastError: { message?: string } | null;
    definition: Record<string, unknown>;
    lastResult: AnalysisResult | null;
    createdAt: string;
    updatedAt: string;
}

export const getAnalysisCatalog = () =>
    apiRequest<AnalysisCatalog>("/api/analysis/catalog", {
        schema: AnalysisCatalogSchema,
    });
export function executeAnalysis(input: {
    requestId: string;
    mode: "visual" | "sql";
    plan?: VisualAnalysisPlan;
    sql?: string;
    values?: AnalysisValue[];
    datasetIds?: string[];
    columns?: AnalysisField[];
    limit?: number;
    offset?: number;
    workbench?: Record<string, unknown>;
    formulaModel?: Record<string, unknown>;
    scenarioModel?: unknown;
}) {
    return apiRequest<AnalysisResult>("/api/analysis/execute", {
        method: "POST",
        body: JSON.stringify(input),
        schema: AnalysisResultSchema,
    });
}
export const cancelAnalysis = (requestId: string) =>
    apiRequest<{ cancelled: boolean; reason?: string }>(
        `/api/analysis/cancel/${encodeURIComponent(requestId)}`,
        { method: "POST" },
    );
export function drillAnalysis(
    plan: VisualAnalysisPlan,
    row: Record<string, AnalysisValue>,
    requestId: string,
) {
    return apiRequest<AnalysisResult>("/api/analysis/drill", {
        method: "POST",
        body: JSON.stringify({ plan, row, requestId }),
        schema: AnalysisResultSchema,
    });
}
export async function listSavedAnalyses(workspace?: AnalysisWorkspace) {
    const suffix = workspace
        ? `?workspace=${encodeURIComponent(workspace)}`
        : "";
    return (
        await apiRequest<{ items: SavedAnalysis[] }>(
            `/api/analysis/saved${suffix}`,
            { schema: SavedAnalysisListSchema },
        )
    ).items;
}
export const createSavedAnalysis = (input: Record<string, unknown>) =>
    apiRequest<SavedAnalysis>("/api/analysis/saved", {
        method: "POST",
        body: JSON.stringify(input),
        schema: SavedAnalysisSchema,
    });
export const updateSavedAnalysis = (
    id: string,
    input: Record<string, unknown>,
) =>
    apiRequest<SavedAnalysis>(`/api/analysis/saved/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
        schema: SavedAnalysisSchema,
    });
export const runSavedAnalysis = (id: string) =>
    apiRequest<SavedAnalysis>(
        `/api/analysis/saved/${encodeURIComponent(id)}/run`,
        { method: "POST", schema: SavedAnalysisSchema },
    );
export const deleteSavedAnalysis = (id: string) =>
    apiRequest<void>(`/api/analysis/saved/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });

export interface SavedAnalysisVersion {
    version: number;
    definition: Record<string, unknown>;
    state: Record<string, unknown>;
    createdAt: string;
}

export const listSavedAnalysisVersions = async (id: string) =>
    (
        await apiRequest<{ items: SavedAnalysisVersion[] }>(
            `/api/analysis/saved/${encodeURIComponent(id)}/versions`,
            { schema: SavedAnalysisVersionListSchema },
        )
    ).items;

export const restoreSavedAnalysisVersion = (
    id: string,
    version: number,
    expectedVersion: number,
) =>
    apiRequest<SavedAnalysis>(
        `/api/analysis/saved/${encodeURIComponent(id)}/restore`,
        {
            method: "POST",
            body: JSON.stringify({ version, expectedVersion }),
            schema: SavedAnalysisSchema,
        },
    );

export interface AnalysisEditProposal {
    schemaVersion: 1;
    savedAnalysisId: string;
    baseVersion: number;
    rationale: string;
    operations: Array<{
        op: "add" | "replace" | "remove";
        path: string;
        value?: unknown;
    }>;
}

export const previewAnalysisProposal = (proposal: AnalysisEditProposal) =>
    apiRequest<{
        proposal: AnalysisEditProposal;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        baseVersion: number;
    }>("/api/analysis/ai-proposals/preview", {
        method: "POST",
        body: JSON.stringify(proposal),
        schema: AnalysisProposalPreviewSchema,
    });

export const applyAnalysisProposal = (proposal: AnalysisEditProposal) =>
    apiRequest<SavedAnalysis>("/api/analysis/ai-proposals/apply", {
        method: "POST",
        body: JSON.stringify(proposal),
        schema: SavedAnalysisSchema,
    });

export const generateAnalysisProposal = (
    id: string,
    instruction: string,
    model?: string,
) =>
    apiRequest<{
        proposal: AnalysisEditProposal;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        baseVersion: number;
    }>(`/api/analysis/saved/${encodeURIComponent(id)}/ai-proposal`, {
        method: "POST",
        body: JSON.stringify({ instruction, model }),
        schema: AnalysisProposalPreviewSchema,
    });
