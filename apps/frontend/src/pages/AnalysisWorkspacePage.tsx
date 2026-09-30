import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, Play, Save, Square, Trash2 } from "lucide-react";
import { apiClient } from "@/lib/api";
import type {
    AnalysisDataset,
    AnalysisEditProposal,
    AnalysisResult,
    AnalysisValue,
    AnalysisWorkspace,
    SavedAnalysis,
    VisualAnalysisPlan,
} from "@/lib/api/analysis";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { addAll } from "@vision/shared-utils/money";
import { useAnalysisWorkspaceQueries } from "@/hooks/useAnalysisQueries";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { resolveAnalysisPreferences } from "@/lib/analysisPreferences";
import { AnalysisInterchangePanel } from "@/features/analysis/AnalysisInterchangePanel";
import type { AnalysisScenarioModel } from "@/features/analysis/analysisInterchange";
import {
    ANALYSIS_TEMPLATES,
    cloneAnalysisPlan,
} from "@/features/analysis/analysisTemplates";

import {
    analysisCatalogLabel,
    analysisColumnLabel,
    formatAnalysisValue,
} from "@/features/analysis/analysisPresentation";

function chartColumns(result: AnalysisResult | null) {
    const columns = result?.declaredColumns?.length
        ? result.declaredColumns
        : (result?.columns ?? []);
    return {
        ids: columns.map((column) => column.id),
        numericIds: columns
            .filter(
                (column) =>
                    /^(decimal|number|integer|currency|numeric|float|double)$/.test(
                        column.type,
                    ) ||
                    result?.rows.some((row) => {
                        const value = row[column.id];
                        return (
                            (typeof value === "number" ||
                                (typeof value === "string" &&
                                    value.trim() !== "")) &&
                            Number.isFinite(Number(value))
                        );
                    }),
            )
            .map((column) => column.id),
    };
}

const EMPTY_PLAN: VisualAnalysisPlan = {
    datasetId: "cash-flows",
    fields: ["month", "category_general", "currency"],
    filters: [
        { fieldId: "is_transfer", operator: "eq", value: false },
        { fieldId: "is_active", operator: "eq", value: true },
    ],
    groups: ["month", "category_general", "currency"],
    measures: ["sum_spending"],
    joins: [],
    orderBy: [{ id: "month", direction: "asc" }],
    limit: 500,
};

const WORKSPACES: AnalysisWorkspace[] = [
    "budgeting",
    "portfolio",
    "research",
    "cross-workspace",
];
const OPERATORS = [
    "eq",
    "neq",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "starts-with",
    "is-null",
    "is-not-null",
];
const requestId = () => `analysis-${crypto.randomUUID()}`;

interface AnalysisExportContext {
    name: string;
    timezone: string;
    workspace: AnalysisWorkspace;
    definitionId?: string;
    definitionVersion?: number;
    datasetIds: string[];
    sourceReferences: string[];
}

const savedDatasetIds = (saved: SavedAnalysis) =>
    (
        saved.definition.datasets as
            Array<{ id?: string; datasetId?: string }> | undefined
    )
        ?.map(({ id, datasetId }) => id ?? datasetId)
        .filter((datasetId): datasetId is string => Boolean(datasetId)) ?? [];

function visualPlanFromSource(
    source: Record<string, unknown>,
): VisualAnalysisPlan {
    const select =
        (source.select as Array<{
            id: string;
            source: { kind: string };
        }>) ?? [];
    return {
        datasetId: String(source.datasetId),
        fields: select
            .filter((entry) => entry.source.kind === "field")
            .map((entry) => entry.id),
        measures: select
            .filter((entry) => entry.source.kind === "metric")
            .map((entry) => entry.id),
        filters: ((source.filters as Array<Record<string, unknown>>) ?? []).map(
            (filter) => {
                const left = filter.left as Record<string, unknown>;
                const columnId = String(left.columnId);
                return {
                    fieldId:
                        left.datasetId === "accounts"
                            ? `account.${columnId}`
                            : columnId,
                    operator: String(filter.operator),
                    value: (
                        filter.right as
                            Record<string, AnalysisValue> | undefined
                    )?.value,
                };
            },
        ),
        groups: (source.groupBy as string[]) ?? [],
        joins: ((source.joins as Array<{ pathId: string }>) ?? []).map(
            (join) => join.pathId,
        ),
        orderBy: (
            (source.orderBy as Array<{
                outputId: string;
                direction: "asc" | "desc";
            }>) ?? []
        ).map(({ outputId, direction }) => ({
            id: outputId,
            direction,
        })),
        limit: Number(source.limit) || 500,
    };
}

function sourceFromSaved(saved: SavedAnalysis): {
    mode: "visual" | "sql";
    plan?: VisualAnalysisPlan;
    sql?: string;
    datasetIds?: string[];
    visualOrigin?: VisualAnalysisPlan;
} {
    const source = saved.definition.source as
        Record<string, unknown> | undefined;
    if (source?.kind === "visual-plan") {
        return {
            mode: "visual",
            plan: visualPlanFromSource(source),
        };
    }
    return {
        mode: "sql",
        sql: String(source?.text ?? ""),
        datasetIds: (source?.datasetIds as string[]) ?? [],
        visualOrigin: source?.visualOrigin
            ? visualPlanFromSource(
                  source.visualOrigin as Record<string, unknown>,
              )
            : undefined,
    };
}

function parseSqlValues(
    value: string,
    invalidMessage: string,
): AnalysisValue[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value || "[]");
    } catch {
        throw new Error(invalidMessage);
    }
    if (
        !Array.isArray(parsed) ||
        parsed.some(
            (item) =>
                item !== null &&
                !["string", "number", "boolean"].includes(typeof item),
        )
    ) {
        throw new Error(invalidMessage);
    }
    return parsed as AnalysisValue[];
}

function inferColumnType(result: AnalysisResult, id: string): string {
    const declared = result.declaredColumns?.find((column) => column.id === id);
    if (declared) return declared.type;
    const runtime = result.columns.find((column) => column.id === id);
    if (runtime?.type) return runtime.type;
    const value = result.rows.find((row) => row[id] != null)?.[id];
    if (typeof value === "number") return "decimal";
    if (typeof value === "boolean") return "boolean";
    return "string";
}

function compatibleVisualOrigin(
    origin: VisualAnalysisPlan | null,
    result: AnalysisResult | null,
): VisualAnalysisPlan | undefined {
    if (!origin || !result) return undefined;
    const originOutputs = new Set([...origin.fields, ...origin.measures]);
    const resultOutputs = result.declaredColumns?.length
        ? result.declaredColumns.map((column) => column.id)
        : result.columns.map((column) => column.id);
    return originOutputs.size === resultOutputs.length &&
        resultOutputs.every((id) => originOutputs.has(id))
        ? origin
        : undefined;
}

function ResultTable({
    result,
    onDrill,
    onSort,
    datasets,
}: {
    result: AnalysisResult;
    onDrill?: (row: Record<string, AnalysisValue>) => void;
    onSort: (id: string) => void;
    datasets: AnalysisDataset[];
}) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const columns = result.declaredColumns?.length
        ? result.declaredColumns.map((column) => column.id)
        : result.columns.map((column) => column.id);
    return (
        <div
            className="overflow-auto rounded-xl border border-border/70"
            tabIndex={0}
        >
            <table className="w-full text-sm">
                <thead className="bg-muted/60">
                    <tr>
                        {columns.map((column) => (
                            <th
                                key={column}
                                scope="col"
                                className="px-3 py-2 text-left font-medium"
                            >
                                <button
                                    className="hover:text-primary"
                                    onClick={() => onSort(column)}
                                >
                                    {analysisColumnLabel(
                                        result,
                                        column,
                                        datasets,
                                        t,
                                    )}
                                </button>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {result.rows.map((row, index) => (
                        <tr
                            key={index}
                            className="border-t border-border/50 hover:bg-muted/30"
                            onDoubleClick={() => onDrill?.(row)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && onDrill) {
                                    onDrill(row);
                                }
                            }}
                            tabIndex={onDrill ? 0 : undefined}
                        >
                            {columns.map((column) => (
                                <td
                                    key={column}
                                    className="max-w-72 truncate px-3 py-2 font-mono text-xs"
                                >
                                    {formatAnalysisValue(
                                        row[column],
                                        inferColumnType(result, column),
                                        column,
                                        appSettings.numberFormat,
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PivotTable({
    result,
    rowId,
    columnId,
    valueId,
    datasets,
}: {
    result: AnalysisResult;
    rowId: string;
    columnId: string;
    valueId: string;
    datasets: AnalysisDataset[];
}) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const columns = [
        ...new Set(result.rows.map((row) => String(row[columnId] ?? "—"))),
    ];
    const rows = [
        ...new Set(result.rows.map((row) => String(row[rowId] ?? "—"))),
    ];
    const values = new Map<string, string[]>();
    for (const item of result.rows) {
        const key = `${String(item[rowId] ?? "—")}\u0000${String(item[columnId] ?? "—")}`;
        values.set(key, [
            ...(values.get(key) ?? []),
            String(item[valueId] ?? 0),
        ]);
    }
    return (
        <div className="overflow-auto rounded-xl border border-border/70">
            <table className="w-full text-sm">
                <thead className="bg-muted/60">
                    <tr>
                        <th className="px-3 py-2 text-left">
                            {analysisColumnLabel(result, rowId, datasets, t)}
                        </th>
                        {columns.map((column) => (
                            <th key={column} className="px-3 py-2 text-right">
                                {formatAnalysisValue(
                                    column,
                                    inferColumnType(result, columnId),
                                    columnId,
                                    appSettings.numberFormat,
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row} className="border-t border-border/50">
                            <th className="px-3 py-2 text-left font-medium">
                                {formatAnalysisValue(
                                    row,
                                    inferColumnType(result, rowId),
                                    rowId,
                                    appSettings.numberFormat,
                                )}
                            </th>
                            {columns.map((column) => (
                                <td
                                    key={column}
                                    className="px-3 py-2 text-right tabular-nums"
                                >
                                    {formatAnalysisValue(
                                        addAll(
                                            values.get(
                                                `${row}\u0000${column}`,
                                            ) ?? [],
                                        ).toString(),
                                        "decimal",
                                        valueId,
                                        appSettings.numberFormat,
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function AnalysisWorkspacePage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const queryClient = useQueryClient();
    const requestedSavedAnalysisId = useMemo(
        () =>
            typeof window === "undefined"
                ? null
                : new URLSearchParams(window.location.search).get(
                      "savedAnalysis",
                  ),
        [],
    );
    const [workspace, setWorkspace] = useState<AnalysisWorkspace>("budgeting");
    const [templatesOpen, setTemplatesOpen] = useState(true);
    const [builderOpen, setBuilderOpen] = useState(true);
    const templateSummaryRef = useRef<HTMLElement>(null);
    const builderSummaryRef = useRef<HTMLElement>(null);
    const [mode, setMode] = useState<"visual" | "sql">("visual");
    const [plan, setPlan] = useState<VisualAnalysisPlan>(EMPTY_PLAN);
    const [sql, setSql] = useState("");
    const [sqlValues, setSqlValues] = useState("[]");
    const [sqlDatasets, setSqlDatasets] = useState<string[]>(["cash-flows"]);
    const [sqlHistory, setSqlHistory] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            return JSON.parse(
                localStorage.getItem(LOCAL_STORAGE_KEYS.ANALYSIS_SQL_HISTORY) ||
                    "[]",
            );
        } catch {
            return [];
        }
    });
    const [result, setResult] = useState<AnalysisResult | null>(null);
    const [resultQuery, setResultQuery] = useState<string | null>(null);
    const querySignature = (
        queryMode: "visual" | "sql",
        queryPlan: VisualAnalysisPlan,
        querySql: string,
        values: string,
        datasets: string[],
    ) =>
        JSON.stringify(
            queryMode === "visual"
                ? { mode: queryMode, plan: queryPlan }
                : { mode: queryMode, sql: querySql, values, datasets },
        );
    const currentQuery = querySignature(
        mode,
        plan,
        sql,
        sqlValues,
        sqlDatasets,
    );
    const [lastUsableResult, setLastUsableResult] =
        useState<AnalysisResult | null>(null);
    const [exportContext, setExportContext] =
        useState<AnalysisExportContext | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeRequest, setActiveRequest] = useState<string | null>(null);
    const [offset, setOffset] = useState(0);
    const [name, setName] = useState("");
    const [sourceReferences, setSourceReferences] = useState("");
    const [formulasJson, setFormulasJson] = useState("[]");
    const [assumptionsJson, setAssumptionsJson] = useState("[]");
    const [assumptionValuesJson, setAssumptionValuesJson] = useState("{}");
    const [scenarioModel, setScenarioModel] = useState<AnalysisScenarioModel>({
        attachments: [],
        joins: [],
    });
    const [runCurrency, setRunCurrency] = useState("");
    const [runBenchmark, setRunBenchmark] = useState("");
    const [runWithoutBenchmark, setRunWithoutBenchmark] = useState(false);
    const [runAnswerDepth, setRunAnswerDepth] = useState("");
    const [runLanguage, setRunLanguage] = useState("");
    const [proposalJson, setProposalJson] = useState("");
    const [proposalPreview, setProposalPreview] = useState<{
        proposal: AnalysisEditProposal;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
    } | null>(null);
    const [versions, setVersions] = useState<number[] | null>(null);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [selectedSaved, setSelectedSaved] = useState<SavedAnalysis | null>(
        null,
    );
    const selectedRevision = useRef("");
    selectedRevision.current = selectedSaved
        ? `${selectedSaved.id}:${selectedSaved.version}`
        : "";
    const [resultDatasetId, setResultDatasetId] = useState<string | null>(null);
    const [drillResult, setDrillResult] = useState<AnalysisResult | null>(null);
    const [chartX, setChartX] = useState("");
    const [chartY, setChartY] = useState("");
    const [visualOrigin, setVisualOrigin] = useState<VisualAnalysisPlan | null>(
        null,
    );

    const { catalog: catalogQuery, saved: savedQuery } =
        useAnalysisWorkspaceQueries(workspace);
    const localizedDatasets = (catalogQuery.data?.datasets ?? []).map(
        (entry) => ({
            ...entry,
            label: analysisCatalogLabel(entry.label, t),
            fields: entry.fields.map((field) => ({
                ...field,
                label: analysisCatalogLabel(field.label, t),
            })),
            measures: entry.measures.map((measure) => ({
                ...measure,
                label: analysisCatalogLabel(measure.label, t),
            })),
        }),
    );
    const rawDataset = catalogQuery.data?.datasets.find(
        (entry) => entry.id === plan.datasetId,
    );
    const dataset = localizedDatasets.find(
        (entry) => entry.id === plan.datasetId,
    );
    const effectivePreferences = resolveAnalysisPreferences({
        run: {
            currency: runCurrency || undefined,
            benchmark: runWithoutBenchmark ? null : runBenchmark || undefined,
            answerDepth: runAnswerDepth || undefined,
            language: runLanguage || undefined,
        },
        saved: selectedSaved?.parameters,
        appSettings,
    });
    const reportingTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    useEffect(() => {
        if (!rawDataset) return;
        const valid = new Set(rawDataset.fields.map((field) => field.id));
        setPlan((current) => ({
            ...current,
            fields: current.fields.filter((id) => valid.has(id)),
            groups: current.groups.filter((id) => valid.has(id)),
            filters: current.filters.filter((filter) =>
                valid.has(filter.fieldId),
            ),
            measures: current.measures.filter((id) =>
                rawDataset.measures.some((measure) => measure.id === id),
            ),
            joins: current.joins.filter((id) =>
                rawDataset.joins.some((join) => join.id === id),
            ),
        }));
    }, [rawDataset]);

    useEffect(() => {
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.ANALYSIS_SQL_HISTORY,
            JSON.stringify(sqlHistory.slice(0, 10)),
        );
    }, [sqlHistory]);

    const execute = async (
        pageOffset = 0,
        planOverride: VisualAnalysisPlan = plan,
    ) => {
        const id = requestId();
        setActiveRequest(id);
        setError(null);
        try {
            const next = await apiClient.executeAnalysis(
                mode === "visual"
                    ? {
                          requestId: id,
                          mode,
                          plan: planOverride,
                          limit: planOverride.limit,
                          offset: pageOffset,
                      }
                    : {
                          requestId: id,
                          mode,
                          sql,
                          values: parseSqlValues(
                              sqlValues,
                              t("analysis.sqlParametersInvalid"),
                          ),
                          datasetIds: sqlDatasets,
                          columns: (
                              result?.declaredColumns ?? result?.columns
                          )?.map((column) => ({
                              id: column.id,
                              label: String(
                                  "label" in column ? column.label : column.id,
                              ),
                              type: String(
                                  "type" in column ? column.type : "string",
                              ),
                          })),
                          limit: planOverride.limit,
                          offset: pageOffset,
                      },
            );
            setResult(next);
            setResultDatasetId(
                mode === "visual" ? planOverride.datasetId : null,
            );
            setResultQuery(
                querySignature(mode, planOverride, sql, sqlValues, sqlDatasets),
            );
            setLastUsableResult(next);
            setExportContext({
                name: name.trim() || "analysis",
                timezone: reportingTimezone,
                workspace,
                datasetIds:
                    mode === "visual"
                        ? [planOverride.datasetId]
                        : [...sqlDatasets],
                sourceReferences: sourceReferences
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
            });
            setOffset(pageOffset);
            if (mode === "visual") setSql(next.generatedSql);
            else
                setSqlHistory((history) =>
                    [sql, ...history.filter((entry) => entry !== sql)].slice(
                        0,
                        10,
                    ),
                );
            const { ids, numericIds } = chartColumns(next);
            setChartX((current) =>
                ids.includes(current) ? current : (ids[0] ?? ""),
            );
            setChartY((current) =>
                numericIds.includes(current) ? current : (numericIds[0] ?? ""),
            );
        } catch (cause) {
            setBuilderOpen(true);
            setError(apiErrorToMessage(cause, t));
        } finally {
            setActiveRequest(null);
        }
    };

    const saveMutation = useMutation({
        mutationFn: () => {
            if (!name.trim()) throw new Error(t("analysis.nameRequired"));
            const querySpec =
                mode === "visual"
                    ? { mode, plan }
                    : {
                          mode,
                          sql,
                          datasetIds: sqlDatasets,
                          columns: (
                              result?.declaredColumns ??
                              result?.columns ??
                              []
                          ).map((column) => ({
                              ...column,
                              label: column.id,
                              type: inferColumnType(
                                  displayedResult!,
                                  column.id,
                              ),
                              nullable: true,
                          })),
                          visualOrigin: compatibleVisualOrigin(
                              visualOrigin,
                              displayedResult,
                          ),
                      };
            const input = {
                name: name.trim(),
                workspace,
                querySpec,
                refreshMode: "live",
                parameters: {
                    currency: effectivePreferences.currency,
                    benchmark: effectivePreferences.benchmark,
                    answerDepth: effectivePreferences.answerDepth,
                    language: effectivePreferences.language,
                    timezone: reportingTimezone,
                    sqlValues: parseSqlValues(
                        sqlValues,
                        t("analysis.sqlParametersInvalid"),
                    ),
                    scenarioModel,
                },
                charts:
                    chartX && chartY
                        ? [{ kind: "bar", x: chartX, y: chartY }]
                        : [],
                sourceReferences: sourceReferences
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                formulas: JSON.parse(formulasJson || "[]"),
                assumptions: JSON.parse(assumptionsJson || "[]"),
                assumptionValues: JSON.parse(assumptionValuesJson || "{}"),
            };
            return selectedSaved
                ? apiClient.updateSavedAnalysis(selectedSaved.id, input)
                : apiClient.createSavedAnalysis(input);
        },
        onSuccess: (saved) => {
            setSelectedSaved(saved);
            queryClient.invalidateQueries({ queryKey: ["analysis", "saved"] });
        },
        onError: (cause) => setError(apiErrorToMessage(cause, t)),
    });

    const loadSaved = useCallback(
        (saved: SavedAnalysis) => {
            const source = sourceFromSaved(saved);
            setTemplatesOpen(false);
            setBuilderOpen(true);
            setSelectedSaved(saved);
            setName(saved.name);
            setWorkspace(saved.workspace);
            setMode(source.mode);
            setResultQuery(
                querySignature(
                    source.mode,
                    source.plan ?? EMPTY_PLAN,
                    source.sql ?? "",
                    JSON.stringify(saved.parameters.sqlValues ?? []),
                    source.datasetIds ?? [],
                ),
            );
            if (source.plan) setPlan(source.plan);
            if (source.sql !== undefined) setSql(source.sql);
            if (source.datasetIds?.length) setSqlDatasets(source.datasetIds);
            if (source.visualOrigin) setVisualOrigin(source.visualOrigin);
            setSqlValues(JSON.stringify(saved.parameters.sqlValues ?? []));
            setScenarioModel(
                (saved.parameters.scenarioModel as
                    AnalysisScenarioModel | undefined) ?? {
                    attachments: [],
                    joins: [],
                },
            );
            setRunCurrency("");
            setRunBenchmark("");
            setRunWithoutBenchmark(false);
            setRunAnswerDepth("");
            setRunLanguage("");
            const { ids, numericIds } = chartColumns(saved.lastResult);
            const binding = saved.charts.find(
                (chart): chart is { kind: string; x: string; y: string } =>
                    typeof chart === "object" &&
                    chart !== null &&
                    "kind" in chart &&
                    chart.kind === "bar" &&
                    "x" in chart &&
                    typeof chart.x === "string" &&
                    "y" in chart &&
                    typeof chart.y === "string",
            );
            setChartX(
                binding && (!saved.lastResult || ids.includes(binding.x))
                    ? binding.x
                    : (ids[0] ?? ""),
            );
            setChartY(
                binding && (!saved.lastResult || numericIds.includes(binding.y))
                    ? binding.y
                    : (numericIds[0] ?? ""),
            );
            setOffset(0);
            setResult(saved.lastResult);
            setResultDatasetId(
                source.mode === "visual"
                    ? (source.plan?.datasetId ?? null)
                    : null,
            );
            setLastUsableResult(saved.lastResult);
            setExportContext(
                saved.lastResult
                    ? {
                          name: saved.name,
                          timezone:
                              typeof saved.parameters.timezone === "string"
                                  ? saved.parameters.timezone
                                  : reportingTimezone,
                          workspace: saved.workspace,
                          definitionId: saved.definitionId,
                          definitionVersion: saved.version,
                          datasetIds: savedDatasetIds(saved),
                          sourceReferences: saved.sourceReferences.map(String),
                      }
                    : null,
            );
            setSourceReferences(saved.sourceReferences.map(String).join("\n"));
            const formulaModel = saved.parameters.formulaModel as
                | {
                      formulas?: unknown[];
                      assumptions?: unknown[];
                      assumptionValues?: Record<string, unknown>;
                  }
                | undefined;
            setFormulasJson(
                JSON.stringify(formulaModel?.formulas ?? [], null, 2),
            );
            setAssumptionsJson(
                JSON.stringify(formulaModel?.assumptions ?? [], null, 2),
            );
            setAssumptionValuesJson(
                JSON.stringify(formulaModel?.assumptionValues ?? {}, null, 2),
            );
            setProposalPreview(null);
            setVersions(null);
            setVersionsLoading(false);
            setError(saved.lastError?.message ?? null);
        },
        [reportingTimezone],
    );

    useEffect(() => {
        const requestedId = requestedSavedAnalysisId;
        if (!requestedId || selectedSaved?.id === requestedId) return;
        const requested = savedQuery.data?.find(
            (saved) => saved.id === requestedId,
        );
        if (requested) loadSaved(requested);
    }, [
        loadSaved,
        requestedSavedAnalysisId,
        savedQuery.data,
        selectedSaved?.id,
    ]);

    const presentationDatasets = (catalogQuery.data?.datasets ?? []).filter(
        (entry) => entry.id === resultDatasetId,
    );
    const displayedResult = result ?? lastUsableResult;
    const availableChartColumns = chartColumns(displayedResult);
    const completeForChart =
        displayedResult?.window.kind === "page" &&
        displayedResult.window.hasMore === false &&
        offset === 0;
    const mixedCurrencies =
        new Set(
            displayedResult?.rows
                .map((row) => row.currency)
                .filter((value) => value != null),
        ).size > 1;
    const pivotReady =
        completeForChart &&
        resultQuery === currentQuery &&
        mode === "visual" &&
        plan.groups.length === 2 &&
        plan.measures.length >= 1;
    const chartValues = useMemo(() => {
        if (!displayedResult || !chartX || !chartY) return [];
        return displayedResult.rows
            .filter((row) => row[chartY] != null && row[chartY] !== "")
            .map((row) => ({
                label: formatAnalysisValue(
                    row[chartX],
                    inferColumnType(displayedResult, chartX),
                    chartX,
                    appSettings.numberFormat,
                ),
                value: Number(row[chartY] ?? 0),
                formattedValue: formatAnalysisValue(
                    row[chartY],
                    inferColumnType(displayedResult, chartY),
                    chartY,
                    appSettings.numberFormat,
                ),
            }))
            .filter((row) => Number.isFinite(row.value));
    }, [displayedResult, chartX, chartY, appSettings.numberFormat]);
    const maxChart = Math.max(
        0,
        ...chartValues.map((row) => Math.abs(row.value)),
    );

    return (
        <PageShell>
            <PageHeader
                title={t("analysis.title")}
                subtitle={t("analysis.subtitle")}
                icon={PAGE_ICONS["/analysis"]}
            />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="space-y-4">
                    <Card>
                        <details
                            open={templatesOpen}
                            onToggle={(event) =>
                                setTemplatesOpen(event.currentTarget.open)
                            }
                        >
                            <summary
                                ref={templateSummaryRef}
                                className="cursor-pointer rounded-lg p-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {t(
                                    templatesOpen
                                        ? "analysis.startTitle"
                                        : "analysis.chooseTemplate",
                                )}
                            </summary>
                            <CardContent className="space-y-3">
                                <p className="max-w-prose text-sm text-muted-foreground">
                                    {t("analysis.taskStartHelp")}
                                </p>
                                <div className="grid gap-2 md:grid-cols-3">
                                    {ANALYSIS_TEMPLATES.map((template) => (
                                        <button
                                            key={template.id}
                                            type="button"
                                            className="rounded-lg border border-border bg-card/60 p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() => {
                                                setTemplatesOpen(false);
                                                setBuilderOpen(false);
                                                builderSummaryRef.current?.focus();
                                                setWorkspace(
                                                    template.workspace,
                                                );
                                                setMode("visual");
                                                setPlan(
                                                    cloneAnalysisPlan(
                                                        template.plan,
                                                    ),
                                                );
                                                setName(t(template.titleKey));
                                                setSelectedSaved(null);
                                                setResult(null);
                                                setLastUsableResult(null);
                                                setExportContext(null);
                                                setError(null);
                                            }}
                                        >
                                            <span className="block text-sm font-medium">
                                                {t(template.titleKey)}
                                            </span>
                                            <span className="mt-1 block text-xs text-muted-foreground">
                                                {t(template.descriptionKey)}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setTemplatesOpen(false);
                                        setBuilderOpen(true);
                                        builderSummaryRef.current?.focus();
                                        setMode("visual");
                                        setPlan({
                                            datasetId:
                                                localizedDatasets[0]?.id ??
                                                "cash-flows",
                                            fields: [],
                                            filters: [],
                                            groups: [],
                                            measures: [],
                                            joins: [],
                                            orderBy: [],
                                            limit: 500,
                                        });
                                        setName("");
                                        setSelectedSaved(null);
                                        setResult(null);
                                        setLastUsableResult(null);
                                        setExportContext(null);
                                        setError(null);
                                    }}
                                >
                                    {t("analysis.blank")}
                                </Button>
                            </CardContent>
                        </details>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("analysis.build")}</CardTitle>
                            <p className="max-w-2xl text-sm text-muted-foreground">
                                {t("analysis.buildHelp")}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {!builderOpen && mode === "visual" && dataset && (
                                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                                    <div>
                                        <dt className="text-xs text-muted-foreground">
                                            {t("analysis.dataset")}
                                        </dt>
                                        <dd className="mt-1">
                                            {dataset.label}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">
                                            {t("analysis.fields")}
                                        </dt>
                                        <dd className="mt-1">
                                            {plan.fields
                                                .map(
                                                    (id) =>
                                                        dataset.fields.find(
                                                            (field) =>
                                                                field.id === id,
                                                        )?.label ?? id,
                                                )
                                                .join(", ") || "—"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">
                                            {t("analysis.measures")}
                                        </dt>
                                        <dd className="mt-1">
                                            {plan.measures
                                                .map(
                                                    (id) =>
                                                        dataset.measures.find(
                                                            (measure) =>
                                                                measure.id ===
                                                                id,
                                                        )?.label ?? id,
                                                )
                                                .join(", ") || "—"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">
                                            {t("analysis.configurationScope")}
                                        </dt>
                                        <dd className="mt-1">
                                            {t(
                                                "analysis.configurationScopeValue",
                                                {
                                                    filters:
                                                        plan.filters.length,
                                                    limit: plan.limit,
                                                },
                                            )}
                                        </dd>
                                    </div>
                                </dl>
                            )}
                            <details
                                open={builderOpen}
                                onToggle={(event) =>
                                    setBuilderOpen(event.currentTarget.open)
                                }
                            >
                                <summary
                                    ref={builderSummaryRef}
                                    className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {t("analysis.editConfiguration")}
                                </summary>
                                <div className="mt-4 space-y-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Button
                                            variant={
                                                mode === "visual"
                                                    ? "default"
                                                    : "outline"
                                            }
                                            aria-pressed={mode === "visual"}
                                            onClick={() => setMode("visual")}
                                        >
                                            {t("analysis.visual")}
                                        </Button>
                                        <details
                                            open={mode === "sql" || undefined}
                                        >
                                            <summary className="cursor-pointer rounded-lg border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                                {t("analysis.advanced")}
                                            </summary>
                                            <Button
                                                className="mt-2"
                                                aria-pressed={mode === "sql"}
                                                variant={
                                                    mode === "sql"
                                                        ? "default"
                                                        : "outline"
                                                }
                                                onClick={() => {
                                                    if (
                                                        !sql &&
                                                        result?.generatedSql
                                                    )
                                                        setSql(
                                                            result.generatedSql,
                                                        );
                                                    setVisualOrigin(plan);
                                                    setSqlDatasets([
                                                        plan.datasetId,
                                                        ...(plan.joins.length
                                                            ? ["accounts"]
                                                            : []),
                                                    ]);
                                                    setMode("sql");
                                                }}
                                            >
                                                {t("analysis.sql")}
                                            </Button>
                                        </details>
                                        <select
                                            aria-label={t("analysis.workspace")}
                                            value={workspace}
                                            onChange={(event) =>
                                                setWorkspace(
                                                    event.target
                                                        .value as AnalysisWorkspace,
                                                )
                                            }
                                            className="rounded-md border bg-background px-3 py-2 text-sm"
                                        >
                                            {WORKSPACES.map((value) => (
                                                <option
                                                    key={value}
                                                    value={value}
                                                >
                                                    {t(
                                                        `analysis.workspace.${value}`,
                                                    )}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    {catalogQuery.isLoading ? (
                                        <p role="status">
                                            {t("analysis.catalogLoading")}
                                        </p>
                                    ) : catalogQuery.isError ? (
                                        <p
                                            role="alert"
                                            className="text-destructive"
                                        >
                                            {t("analysis.catalogError")}
                                        </p>
                                    ) : localizedDatasets.length === 0 ? (
                                        <p>{t("analysis.catalogEmpty")}</p>
                                    ) : mode === "visual" && dataset ? (
                                        <>
                                            <div>
                                                <Label htmlFor="analysis-dataset">
                                                    {t("analysis.dataset")}
                                                </Label>
                                                <select
                                                    id="analysis-dataset"
                                                    value={plan.datasetId}
                                                    onChange={(event) =>
                                                        setPlan({
                                                            ...EMPTY_PLAN,
                                                            datasetId:
                                                                event.target
                                                                    .value,
                                                        })
                                                    }
                                                    className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                                                >
                                                    {localizedDatasets.map(
                                                        (entry) => (
                                                            <option
                                                                key={entry.id}
                                                                value={entry.id}
                                                            >
                                                                {entry.label}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </div>
                                            <div className="grid gap-4 lg:grid-cols-2">
                                                <fieldset>
                                                    <legend className="text-sm font-medium">
                                                        {t("analysis.fields")}
                                                    </legend>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {t(
                                                            "analysis.fieldsHelp",
                                                        )}
                                                    </p>
                                                    <div className="mt-2 grid max-h-48 grid-cols-2 gap-2 overflow-auto">
                                                        {dataset.fields.map(
                                                            (field) => (
                                                                <label
                                                                    key={
                                                                        field.id
                                                                    }
                                                                    className="flex items-center gap-2 text-sm"
                                                                >
                                                                    <Checkbox
                                                                        checked={plan.fields.includes(
                                                                            field.id,
                                                                        )}
                                                                        onCheckedChange={(
                                                                            checked,
                                                                        ) =>
                                                                            setPlan(
                                                                                (
                                                                                    current,
                                                                                ) => ({
                                                                                    ...current,
                                                                                    fields: checked
                                                                                        ? [
                                                                                              ...current.fields,
                                                                                              field.id,
                                                                                          ]
                                                                                        : current.fields.filter(
                                                                                              (
                                                                                                  id,
                                                                                              ) =>
                                                                                                  id !==
                                                                                                  field.id,
                                                                                          ),
                                                                                    groups: checked
                                                                                        ? current.groups
                                                                                        : current.groups.filter(
                                                                                              (
                                                                                                  id,
                                                                                              ) =>
                                                                                                  id !==
                                                                                                  field.id,
                                                                                          ),
                                                                                }),
                                                                            )
                                                                        }
                                                                    />
                                                                    {
                                                                        field.label
                                                                    }
                                                                </label>
                                                            ),
                                                        )}
                                                    </div>
                                                </fieldset>
                                                <fieldset>
                                                    <legend className="text-sm font-medium">
                                                        {t("analysis.measures")}
                                                    </legend>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {t(
                                                            "analysis.measuresHelp",
                                                        )}
                                                    </p>
                                                    <div className="mt-2 space-y-2">
                                                        {dataset.measures.map(
                                                            (measure) => (
                                                                <label
                                                                    key={
                                                                        measure.id
                                                                    }
                                                                    className="flex items-center gap-2 text-sm"
                                                                >
                                                                    <Checkbox
                                                                        checked={plan.measures.includes(
                                                                            measure.id,
                                                                        )}
                                                                        onCheckedChange={(
                                                                            checked,
                                                                        ) =>
                                                                            setPlan(
                                                                                (
                                                                                    current,
                                                                                ) => ({
                                                                                    ...current,
                                                                                    measures:
                                                                                        checked
                                                                                            ? [
                                                                                                  ...current.measures,
                                                                                                  measure.id,
                                                                                              ]
                                                                                            : current.measures.filter(
                                                                                                  (
                                                                                                      id,
                                                                                                  ) =>
                                                                                                      id !==
                                                                                                      measure.id,
                                                                                              ),
                                                                                }),
                                                                            )
                                                                        }
                                                                    />
                                                                    {
                                                                        measure.label
                                                                    }
                                                                </label>
                                                            ),
                                                        )}
                                                        {dataset.joins.map(
                                                            (join) => (
                                                                <label
                                                                    key={
                                                                        join.id
                                                                    }
                                                                    className="flex items-center gap-2 text-sm"
                                                                >
                                                                    <Checkbox
                                                                        checked={plan.joins.includes(
                                                                            join.id,
                                                                        )}
                                                                        onCheckedChange={(
                                                                            checked,
                                                                        ) =>
                                                                            setPlan(
                                                                                (
                                                                                    current,
                                                                                ) => ({
                                                                                    ...current,
                                                                                    joins: checked
                                                                                        ? [
                                                                                              join.id,
                                                                                          ]
                                                                                        : [],
                                                                                }),
                                                                            )
                                                                        }
                                                                    />
                                                                    {t(
                                                                        "analysis.safeAccountJoin",
                                                                    )}
                                                                </label>
                                                            ),
                                                        )}
                                                    </div>
                                                </fieldset>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium">
                                                    {t("analysis.groups")}
                                                </p>
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    {plan.fields.map((id) => (
                                                        <label
                                                            key={id}
                                                            className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                                                        >
                                                            <Checkbox
                                                                checked={plan.groups.includes(
                                                                    id,
                                                                )}
                                                                onCheckedChange={(
                                                                    checked,
                                                                ) =>
                                                                    setPlan(
                                                                        (
                                                                            current,
                                                                        ) => ({
                                                                            ...current,
                                                                            groups: checked
                                                                                ? [
                                                                                      ...current.groups,
                                                                                      id,
                                                                                  ]
                                                                                : current.groups.filter(
                                                                                      (
                                                                                          value,
                                                                                      ) =>
                                                                                          value !==
                                                                                          id,
                                                                                  ),
                                                                        }),
                                                                    )
                                                                }
                                                            />
                                                            {dataset.fields.find(
                                                                (field) =>
                                                                    field.id ===
                                                                    id,
                                                            )?.label ?? id}
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-sm font-medium">
                                                        {t("analysis.filters")}
                                                    </span>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            setPlan(
                                                                (current) => ({
                                                                    ...current,
                                                                    filters: [
                                                                        ...current.filters,
                                                                        {
                                                                            fieldId:
                                                                                dataset
                                                                                    .fields[0]
                                                                                    .id,
                                                                            operator:
                                                                                "eq",
                                                                            value: "",
                                                                        },
                                                                    ],
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        {t(
                                                            "analysis.addFilter",
                                                        )}
                                                    </Button>
                                                </div>
                                                <div className="mt-2 space-y-2">
                                                    {plan.filters.map(
                                                        (filter, index) => (
                                                            <div
                                                                key={index}
                                                                className="grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]"
                                                            >
                                                                <select
                                                                    aria-label={t(
                                                                        "analysis.filterField",
                                                                        {
                                                                            number:
                                                                                index +
                                                                                1,
                                                                        },
                                                                    )}
                                                                    value={
                                                                        filter.fieldId
                                                                    }
                                                                    onChange={(
                                                                        event,
                                                                    ) =>
                                                                        setPlan(
                                                                            (
                                                                                current,
                                                                            ) => ({
                                                                                ...current,
                                                                                filters:
                                                                                    current.filters.map(
                                                                                        (
                                                                                            item,
                                                                                            i,
                                                                                        ) =>
                                                                                            i ===
                                                                                            index
                                                                                                ? {
                                                                                                      ...item,
                                                                                                      fieldId:
                                                                                                          event
                                                                                                              .target
                                                                                                              .value,
                                                                                                  }
                                                                                                : item,
                                                                                    ),
                                                                            }),
                                                                        )
                                                                    }
                                                                    className="rounded-md border bg-background px-2 py-1"
                                                                >
                                                                    {dataset.fields.map(
                                                                        (
                                                                            field,
                                                                        ) => (
                                                                            <option
                                                                                key={
                                                                                    field.id
                                                                                }
                                                                                value={
                                                                                    field.id
                                                                                }
                                                                            >
                                                                                {
                                                                                    field.label
                                                                                }
                                                                            </option>
                                                                        ),
                                                                    )}
                                                                </select>
                                                                <select
                                                                    aria-label={t(
                                                                        "analysis.filterOperator",
                                                                        {
                                                                            number:
                                                                                index +
                                                                                1,
                                                                            field:
                                                                                dataset.fields.find(
                                                                                    (
                                                                                        field,
                                                                                    ) =>
                                                                                        field.id ===
                                                                                        filter.fieldId,
                                                                                )
                                                                                    ?.label ??
                                                                                filter.fieldId,
                                                                        },
                                                                    )}
                                                                    value={
                                                                        filter.operator
                                                                    }
                                                                    onChange={(
                                                                        event,
                                                                    ) =>
                                                                        setPlan(
                                                                            (
                                                                                current,
                                                                            ) => ({
                                                                                ...current,
                                                                                filters:
                                                                                    current.filters.map(
                                                                                        (
                                                                                            item,
                                                                                            i,
                                                                                        ) =>
                                                                                            i ===
                                                                                            index
                                                                                                ? {
                                                                                                      ...item,
                                                                                                      operator:
                                                                                                          event
                                                                                                              .target
                                                                                                              .value,
                                                                                                  }
                                                                                                : item,
                                                                                    ),
                                                                            }),
                                                                        )
                                                                    }
                                                                    className="rounded-md border bg-background px-2 py-1"
                                                                >
                                                                    {OPERATORS.map(
                                                                        (
                                                                            operator,
                                                                        ) => (
                                                                            <option
                                                                                key={
                                                                                    operator
                                                                                }
                                                                                value={
                                                                                    operator
                                                                                }
                                                                            >
                                                                                {t(
                                                                                    `analysis.operator.${operator}`,
                                                                                )}
                                                                            </option>
                                                                        ),
                                                                    )}
                                                                </select>
                                                                <Input
                                                                    aria-label={t(
                                                                        "analysis.filterValue",
                                                                        {
                                                                            number:
                                                                                index +
                                                                                1,
                                                                            field:
                                                                                dataset.fields.find(
                                                                                    (
                                                                                        field,
                                                                                    ) =>
                                                                                        field.id ===
                                                                                        filter.fieldId,
                                                                                )
                                                                                    ?.label ??
                                                                                filter.fieldId,
                                                                        },
                                                                    )}
                                                                    value={String(
                                                                        filter.value ??
                                                                            "",
                                                                    )}
                                                                    disabled={[
                                                                        "is-null",
                                                                        "is-not-null",
                                                                    ].includes(
                                                                        filter.operator,
                                                                    )}
                                                                    onChange={(
                                                                        event,
                                                                    ) => {
                                                                        const field =
                                                                            dataset.fields.find(
                                                                                (
                                                                                    entry,
                                                                                ) =>
                                                                                    entry.id ===
                                                                                    filter.fieldId,
                                                                            );
                                                                        const raw =
                                                                            event
                                                                                .target
                                                                                .value;
                                                                        const value: AnalysisValue =
                                                                            field?.type ===
                                                                            "boolean"
                                                                                ? raw ===
                                                                                  "true"
                                                                                : field?.type ===
                                                                                    "integer"
                                                                                  ? Number(
                                                                                        raw,
                                                                                    )
                                                                                  : raw;
                                                                        setPlan(
                                                                            (
                                                                                current,
                                                                            ) => ({
                                                                                ...current,
                                                                                filters:
                                                                                    current.filters.map(
                                                                                        (
                                                                                            item,
                                                                                            i,
                                                                                        ) =>
                                                                                            i ===
                                                                                            index
                                                                                                ? {
                                                                                                      ...item,
                                                                                                      value,
                                                                                                  }
                                                                                                : item,
                                                                                    ),
                                                                            }),
                                                                        );
                                                                    }}
                                                                />
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "analysis.removeFilterContext",
                                                                        {
                                                                            number:
                                                                                index +
                                                                                1,
                                                                            field:
                                                                                dataset.fields.find(
                                                                                    (
                                                                                        field,
                                                                                    ) =>
                                                                                        field.id ===
                                                                                        filter.fieldId,
                                                                                )
                                                                                    ?.label ??
                                                                                filter.fieldId,
                                                                        },
                                                                    )}
                                                                    onClick={() =>
                                                                        setPlan(
                                                                            (
                                                                                current,
                                                                            ) => ({
                                                                                ...current,
                                                                                filters:
                                                                                    current.filters.filter(
                                                                                        (
                                                                                            _,
                                                                                            i,
                                                                                        ) =>
                                                                                            i !==
                                                                                            index,
                                                                                    ),
                                                                            }),
                                                                        )
                                                                    }
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            </div>
                                                        ),
                                                    )}
                                                </div>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="space-y-2">
                                            <Label htmlFor="analysis-sql">
                                                {t("analysis.sqlEditor")}
                                            </Label>
                                            <Textarea
                                                id="analysis-sql"
                                                className="min-h-56 font-mono text-xs"
                                                value={sql}
                                                onChange={(event) =>
                                                    setSql(event.target.value)
                                                }
                                                spellCheck={false}
                                            />
                                            <fieldset className="space-y-2 rounded-md border p-3">
                                                <legend className="text-sm font-medium">
                                                    {t(
                                                        "analysis.approvedDatasets",
                                                    )}
                                                </legend>
                                                <div className="flex flex-wrap gap-3">
                                                    {localizedDatasets.map(
                                                        (entry) => (
                                                            <label
                                                                key={entry.id}
                                                                className="flex items-center gap-2 text-xs"
                                                            >
                                                                <Checkbox
                                                                    checked={sqlDatasets.includes(
                                                                        entry.id,
                                                                    )}
                                                                    onCheckedChange={(
                                                                        checked,
                                                                    ) =>
                                                                        setSqlDatasets(
                                                                            (
                                                                                current,
                                                                            ) =>
                                                                                checked
                                                                                    ? [
                                                                                          ...new Set(
                                                                                              [
                                                                                                  ...current,
                                                                                                  entry.id,
                                                                                              ],
                                                                                          ),
                                                                                      ]
                                                                                    : current.filter(
                                                                                          (
                                                                                              id,
                                                                                          ) =>
                                                                                              id !==
                                                                                              entry.id,
                                                                                      ),
                                                                        )
                                                                    }
                                                                />
                                                                {entry.label}
                                                            </label>
                                                        ),
                                                    )}
                                                </div>
                                                <div className="flex flex-wrap gap-1">
                                                    {localizedDatasets
                                                        .filter((entry) =>
                                                            sqlDatasets.includes(
                                                                entry.id,
                                                            ),
                                                        )
                                                        .flatMap((entry) =>
                                                            entry.fields
                                                                .slice(0, 12)
                                                                .map(
                                                                    (
                                                                        field,
                                                                    ) => ({
                                                                        datasetId:
                                                                            entry.id,
                                                                        field,
                                                                    }),
                                                                ),
                                                        )
                                                        .map(
                                                            ({
                                                                datasetId,
                                                                field,
                                                            }) => (
                                                                <Button
                                                                    key={`${datasetId}:${field.id}`}
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    onClick={() =>
                                                                        setSql(
                                                                            (
                                                                                current,
                                                                            ) =>
                                                                                `${current}${current.endsWith(" ") || !current ? "" : " "}${field.id}`,
                                                                        )
                                                                    }
                                                                >
                                                                    {field.id}
                                                                </Button>
                                                            ),
                                                        )}
                                                </div>
                                            </fieldset>
                                            <div>
                                                <Label htmlFor="analysis-sql-values">
                                                    {t(
                                                        "analysis.sqlParameters",
                                                    )}
                                                </Label>
                                                <Input
                                                    id="analysis-sql-values"
                                                    className="font-mono text-xs"
                                                    value={sqlValues}
                                                    onChange={(event) =>
                                                        setSqlValues(
                                                            event.target.value,
                                                        )
                                                    }
                                                    placeholder='["2026-01-01", 100]'
                                                />
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {t(
                                                        "analysis.sqlParametersHint",
                                                    )}
                                                </p>
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                {t("analysis.sqlHint")}
                                            </p>
                                            {sqlHistory.length > 0 && (
                                                <details>
                                                    <summary className="cursor-pointer text-xs">
                                                        {t(
                                                            "analysis.queryHistory",
                                                        )}
                                                    </summary>
                                                    {sqlHistory.map(
                                                        (entry, index) => (
                                                            <button
                                                                key={index}
                                                                className="block max-w-full truncate py-1 text-left font-mono text-xs text-muted-foreground"
                                                                onClick={() =>
                                                                    setSql(
                                                                        entry,
                                                                    )
                                                                }
                                                            >
                                                                {entry}
                                                            </button>
                                                        ),
                                                    )}
                                                </details>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </details>
                            <div className="flex gap-2">
                                <Button
                                    onClick={() => execute(0)}
                                    disabled={!!activeRequest}
                                >
                                    <Play className="mr-2 h-4 w-4" />
                                    {t("analysis.run")}
                                </Button>
                                {activeRequest && (
                                    <Button
                                        variant="destructive"
                                        onClick={() =>
                                            apiClient.cancelAnalysis(
                                                activeRequest,
                                            )
                                        }
                                    >
                                        <Square className="mr-2 h-4 w-4" />
                                        {t("analysis.cancel")}
                                    </Button>
                                )}
                            </div>
                            {error && (
                                <div
                                    role="alert"
                                    className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                                >
                                    {error}
                                    {lastUsableResult && (
                                        <p className="mt-1 text-xs">
                                            {t("analysis.lastResultPreserved")}
                                        </p>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {displayedResult && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Database className="h-4 w-4" />
                                    {t("analysis.results")}
                                    <Badge variant="secondary">
                                        {displayedResult.window.returnedRows}
                                    </Badge>
                                </CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t("analysis.resultsHelp")}
                                </p>
                            </CardHeader>
                            <div className="px-6">
                                {resultQuery !== null &&
                                    resultQuery !== currentQuery && (
                                        <p
                                            role="status"
                                            className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
                                        >
                                            {t("analysis.resultsOutdated")}
                                        </p>
                                    )}
                            </div>
                            {!!displayedResult.formulaErrors?.length && (
                                <div
                                    role="alert"
                                    className="mx-6 mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
                                >
                                    <p>{t("analysis.formulaErrorsNotice")}</p>
                                    <ul className="mt-2 list-disc pl-5">
                                        {displayedResult.formulaErrors.map(
                                            (issue, index) => (
                                                <li
                                                    key={`${issue.formulaId}-${issue.rowIndex ?? "summary"}-${index}`}
                                                >
                                                    {issue.formulaId}
                                                    {issue.rowIndex ===
                                                    undefined
                                                        ? ""
                                                        : ` (${t("analysis.formulaErrorRow", { row: issue.rowIndex + 1 })})`}
                                                    : {issue.message}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                </div>
                            )}
                            <Tabs defaultValue="table">
                                <div className="px-6 pb-3">
                                    <TabsList
                                        aria-label={t("analysis.resultViews")}
                                    >
                                        <TabsTrigger value="table">
                                            {t("analysis.tableView")}
                                        </TabsTrigger>
                                        <TabsTrigger value="chart">
                                            {t("analysis.chart")}
                                        </TabsTrigger>
                                        <TabsTrigger value="pivot">
                                            {t("analysis.pivot")}
                                        </TabsTrigger>
                                    </TabsList>
                                </div>
                                <TabsContent value="table" className="mt-0">
                                    <CardContent className="space-y-3">
                                        <ResultTable
                                            result={displayedResult}
                                            datasets={presentationDatasets}
                                            onSort={(id) => {
                                                if (mode === "visual") {
                                                    const next: VisualAnalysisPlan =
                                                        {
                                                            ...plan,
                                                            orderBy: [
                                                                {
                                                                    id,
                                                                    direction:
                                                                        plan
                                                                            .orderBy[0]
                                                                            ?.id ===
                                                                            id &&
                                                                        plan
                                                                            .orderBy[0]
                                                                            .direction ===
                                                                            "asc"
                                                                            ? "desc"
                                                                            : "asc",
                                                                },
                                                            ],
                                                        };
                                                    setPlan(next);
                                                    void execute(0, next);
                                                }
                                            }}
                                            onDrill={
                                                mode === "visual"
                                                    ? async (row) => {
                                                          try {
                                                              setDrillResult(
                                                                  await apiClient.drillAnalysis(
                                                                      plan,
                                                                      row,
                                                                      requestId(),
                                                                  ),
                                                              );
                                                          } catch (cause) {
                                                              setError(
                                                                  apiErrorToMessage(
                                                                      cause,
                                                                      t,
                                                                  ),
                                                              );
                                                          }
                                                      }
                                                    : undefined
                                            }
                                        />
                                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                                            <span>
                                                {displayedResult.window.kind ===
                                                "truncated"
                                                    ? t("analysis.truncated")
                                                    : displayedResult.window
                                                            .hasMore
                                                      ? t("analysis.moreRows")
                                                      : t(
                                                            "analysis.completeRows",
                                                        )}
                                            </span>
                                            <div className="flex gap-2">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={offset === 0}
                                                    onClick={() =>
                                                        execute(
                                                            Math.max(
                                                                0,
                                                                offset -
                                                                    plan.limit,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    {t("analysis.previous")}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={
                                                        displayedResult.window
                                                            .kind !== "page" ||
                                                        !displayedResult.window
                                                            .hasMore
                                                    }
                                                    onClick={() =>
                                                        execute(
                                                            offset + plan.limit,
                                                        )
                                                    }
                                                >
                                                    {t("analysis.next")}
                                                </Button>
                                            </div>
                                        </div>
                                        <details>
                                            <summary className="cursor-pointer text-sm font-medium">
                                                {t("analysis.generatedSql")}
                                            </summary>
                                            <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">
                                                {displayedResult.generatedSql}
                                            </pre>
                                        </details>
                                    </CardContent>
                                </TabsContent>
                                <TabsContent value="chart" className="mt-0">
                                    <CardContent className="space-y-3">
                                        <div className="flex gap-2">
                                            <label className="grid gap-1 text-sm">
                                                <span>
                                                    {t(
                                                        "analysis.chartCategory",
                                                    )}
                                                </span>
                                                <select
                                                    value={chartX}
                                                    onChange={(event) =>
                                                        setChartX(
                                                            event.target.value,
                                                        )
                                                    }
                                                    className="rounded-md border bg-background px-2 py-1"
                                                >
                                                    {availableChartColumns.ids.map(
                                                        (id) => (
                                                            <option
                                                                key={id}
                                                                value={id}
                                                            >
                                                                {analysisColumnLabel(
                                                                    displayedResult,
                                                                    id,
                                                                    presentationDatasets,
                                                                    t,
                                                                )}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </label>
                                            <label className="grid gap-1 text-sm">
                                                <span>
                                                    {t("analysis.chartValue")}
                                                </span>
                                                <select
                                                    value={chartY}
                                                    onChange={(event) =>
                                                        setChartY(
                                                            event.target.value,
                                                        )
                                                    }
                                                    className="rounded-md border bg-background px-2 py-1"
                                                >
                                                    {!chartY && (
                                                        <option value="">
                                                            —
                                                        </option>
                                                    )}
                                                    {availableChartColumns.numericIds.map(
                                                        (id) => (
                                                            <option
                                                                key={id}
                                                                value={id}
                                                            >
                                                                {analysisColumnLabel(
                                                                    displayedResult,
                                                                    id,
                                                                    presentationDatasets,
                                                                    t,
                                                                )}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </label>
                                        </div>
                                        {!chartY ? (
                                            <p className="text-sm text-muted-foreground">
                                                {t("analysis.chartNoNumeric")}
                                            </p>
                                        ) : mixedCurrencies ? (
                                            <p className="text-sm text-muted-foreground">
                                                {t(
                                                    "analysis.chartMixedCurrencies",
                                                )}
                                            </p>
                                        ) : completeForChart ? (
                                            <div className="space-y-2">
                                                {chartValues.map(
                                                    (row, index) => (
                                                        <div
                                                            key={`${row.label}-${index}`}
                                                            className="grid grid-cols-[minmax(0,10rem)_minmax(2rem,1fr)_auto] items-center gap-2 text-xs"
                                                        >
                                                            <span className="truncate">
                                                                {row.label}
                                                            </span>
                                                            <div className="relative h-3 rounded-full bg-primary/15">
                                                                <span
                                                                    aria-hidden="true"
                                                                    className="absolute inset-y-0 left-1/2 border-l border-foreground/50"
                                                                />
                                                                <div
                                                                    className="absolute h-3 rounded-full bg-primary"
                                                                    data-sign={
                                                                        row.value <
                                                                        0
                                                                            ? "negative"
                                                                            : "positive"
                                                                    }
                                                                    style={{
                                                                        width: `${maxChart ? (Math.abs(row.value) / maxChart) * 50 : 0}%`,
                                                                        ...(row.value <
                                                                        0
                                                                            ? {
                                                                                  right: "50%",
                                                                              }
                                                                            : {
                                                                                  left: "50%",
                                                                              }),
                                                                    }}
                                                                />
                                                            </div>
                                                            <span className="text-right tabular-nums">
                                                                {
                                                                    row.formattedValue
                                                                }
                                                            </span>
                                                        </div>
                                                    ),
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">
                                                {t(
                                                    "analysis.chartNeedsComplete",
                                                )}
                                            </p>
                                        )}
                                    </CardContent>
                                </TabsContent>
                                <TabsContent value="pivot" className="mt-0">
                                    {pivotReady ? (
                                        <CardContent>
                                            <PivotTable
                                                result={displayedResult}
                                                datasets={presentationDatasets}
                                                rowId={plan.groups[0]}
                                                columnId={plan.groups[1]}
                                                valueId={plan.measures[0]}
                                            />
                                        </CardContent>
                                    ) : (
                                        <CardContent>
                                            <p className="text-sm text-muted-foreground">
                                                {t("analysis.pivotHelp")}
                                            </p>
                                        </CardContent>
                                    )}
                                </TabsContent>
                            </Tabs>
                        </Card>
                    )}

                    {drillResult && (
                        <Card>
                            <CardHeader>
                                <CardTitle>
                                    {t("analysis.sourceRows")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ResultTable
                                    result={drillResult}
                                    datasets={catalogQuery.data?.datasets ?? []}
                                    onSort={() => {}}
                                />
                            </CardContent>
                        </Card>
                    )}
                </div>

                <aside className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("analysis.saveTitle")}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t("analysis.saveHelp")}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <Label htmlFor="analysis-name">
                                {t("analysis.namePlaceholder")}
                            </Label>
                            <Input
                                id="analysis-name"
                                value={name}
                                onChange={(event) =>
                                    setName(event.target.value)
                                }
                                placeholder={t("analysis.namePlaceholder")}
                            />
                            <details className="rounded-lg border border-border/60 p-3">
                                <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 rounded-sm">
                                    {t("analysis.sourcesLabel")}
                                </summary>
                                <div className="pt-3 space-y-2">
                                    <Label htmlFor="analysis-sources">
                                        {t("analysis.sourcesLabel")}
                                    </Label>
                                    <Textarea
                                        id="analysis-sources"
                                        value={sourceReferences}
                                        onChange={(event) =>
                                            setSourceReferences(
                                                event.target.value,
                                            )
                                        }
                                        placeholder={t(
                                            "analysis.sourcesPlaceholder",
                                        )}
                                    />
                                </div>
                            </details>
                            <details>
                                <summary className="cursor-pointer text-sm font-medium">
                                    {t("analysis.runPreferences")}
                                </summary>
                                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                    <div>
                                        <Label htmlFor="analysis-run-currency">
                                            {t("analysis.reportingCurrency")}
                                        </Label>
                                        <Input
                                            id="analysis-run-currency"
                                            value={runCurrency}
                                            maxLength={3}
                                            placeholder={
                                                effectivePreferences.currency
                                            }
                                            onChange={(event) =>
                                                setRunCurrency(
                                                    event.target.value.toUpperCase(),
                                                )
                                            }
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="analysis-run-benchmark">
                                            {t("analysis.benchmark")}
                                        </Label>
                                        <Input
                                            id="analysis-run-benchmark"
                                            value={runBenchmark}
                                            disabled={runWithoutBenchmark}
                                            maxLength={32}
                                            placeholder={
                                                effectivePreferences.benchmark ??
                                                t("analysis.none")
                                            }
                                            onChange={(event) =>
                                                setRunBenchmark(
                                                    event.target.value.toUpperCase(),
                                                )
                                            }
                                        />
                                        <div className="mt-1 flex items-center gap-2">
                                            <Checkbox
                                                id="analysis-run-no-benchmark"
                                                checked={runWithoutBenchmark}
                                                onCheckedChange={(checked) =>
                                                    setRunWithoutBenchmark(
                                                        checked === true,
                                                    )
                                                }
                                            />
                                            <Label htmlFor="analysis-run-no-benchmark">
                                                {t(
                                                    "analysis.noBenchmarkForRun",
                                                )}
                                            </Label>
                                        </div>
                                    </div>
                                    <div>
                                        <Label htmlFor="analysis-run-depth">
                                            {t("analysis.answerDepth")}
                                        </Label>
                                        <select
                                            id="analysis-run-depth"
                                            value={runAnswerDepth}
                                            onChange={(event) =>
                                                setRunAnswerDepth(
                                                    event.target.value,
                                                )
                                            }
                                            className="w-full rounded-md border bg-background px-3 py-2"
                                        >
                                            <option value="">
                                                {t("analysis.useDefault")}
                                            </option>
                                            <option value="quick">
                                                {t("aiResearch.quick")}
                                            </option>
                                            <option value="detailed">
                                                {t("aiResearch.detailed")}
                                            </option>
                                        </select>
                                    </div>
                                    <div>
                                        <Label htmlFor="analysis-run-language">
                                            {t("analysis.language")}
                                        </Label>
                                        <select
                                            id="analysis-run-language"
                                            value={runLanguage}
                                            onChange={(event) =>
                                                setRunLanguage(
                                                    event.target.value,
                                                )
                                            }
                                            className="w-full rounded-md border bg-background px-3 py-2"
                                        >
                                            <option value="">
                                                {t("analysis.useDefault")}
                                            </option>
                                            <option value="en">
                                                {t("settings.general.lang.en")}
                                            </option>
                                            <option value="nl">
                                                {t("settings.general.lang.nl")}
                                            </option>
                                        </select>
                                    </div>
                                </div>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {t("analysis.preferencePrecedence")}
                                </p>
                            </details>
                            <details>
                                <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    {t("analysis.filesAndScenarios")}
                                </summary>
                                <div className="mt-3">
                                    <AnalysisInterchangePanel
                                        result={displayedResult}
                                        name={exportContext?.name ?? "analysis"}
                                        timezone={
                                            exportContext?.timezone ??
                                            reportingTimezone
                                        }
                                        workspace={
                                            exportContext?.workspace ??
                                            workspace
                                        }
                                        definitionId={
                                            exportContext?.definitionId
                                        }
                                        definitionVersion={
                                            exportContext?.definitionVersion
                                        }
                                        datasetIds={
                                            exportContext?.datasetIds ?? []
                                        }
                                        sourceReferences={
                                            exportContext?.sourceReferences ??
                                            []
                                        }
                                        scenarioModel={scenarioModel}
                                        onScenarioModelChange={setScenarioModel}
                                    />
                                </div>
                            </details>
                            <details>
                                <summary className="cursor-pointer text-sm font-medium">
                                    {t("analysis.formulasAndAssumptions")}
                                </summary>
                                <div className="mt-2 space-y-2">
                                    <Label htmlFor="analysis-formulas-json">
                                        {t("analysis.formulasJson")}
                                    </Label>
                                    <Textarea
                                        id="analysis-formulas-json"
                                        className="font-mono text-xs"
                                        value={formulasJson}
                                        onChange={(event) =>
                                            setFormulasJson(event.target.value)
                                        }
                                    />
                                    <Label htmlFor="analysis-assumptions-json">
                                        {t("analysis.assumptionsJson")}
                                    </Label>
                                    <Textarea
                                        id="analysis-assumptions-json"
                                        className="font-mono text-xs"
                                        value={assumptionsJson}
                                        onChange={(event) =>
                                            setAssumptionsJson(
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <Label htmlFor="analysis-scenarios-json">
                                        {t("analysis.scenarioValuesJson")}
                                    </Label>
                                    <Textarea
                                        id="analysis-scenarios-json"
                                        className="font-mono text-xs"
                                        value={assumptionValuesJson}
                                        onChange={(event) =>
                                            setAssumptionValuesJson(
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        {t("analysis.formulaSafety")}
                                    </p>
                                </div>
                            </details>
                            <Button
                                className="w-full"
                                variant="outline"
                                onClick={() => saveMutation.mutate()}
                                disabled={
                                    !displayedResult || saveMutation.isPending
                                }
                            >
                                <Save className="mr-2 h-4 w-4" />
                                {selectedSaved
                                    ? t("analysis.saveVersion")
                                    : t("analysis.save")}
                            </Button>
                            {selectedSaved && (
                                <div className="space-y-2">
                                    <p className="text-xs text-muted-foreground">
                                        {t("analysis.version", {
                                            version: selectedSaved.version,
                                        })}
                                    </p>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={versionsLoading}
                                        onClick={async () => {
                                            const requestedRevision = `${selectedSaved.id}:${selectedSaved.version}`;
                                            setVersionsLoading(true);
                                            setError(null);
                                            try {
                                                const items =
                                                    await apiClient.listSavedAnalysisVersions(
                                                        selectedSaved.id,
                                                    );
                                                if (
                                                    selectedRevision.current !==
                                                    requestedRevision
                                                )
                                                    return;
                                                setVersions(
                                                    items.map(
                                                        (item) => item.version,
                                                    ),
                                                );
                                            } catch (cause) {
                                                if (
                                                    selectedRevision.current ===
                                                    requestedRevision
                                                )
                                                    setError(
                                                        apiErrorToMessage(
                                                            cause,
                                                            t,
                                                        ),
                                                    );
                                            } finally {
                                                if (
                                                    selectedRevision.current ===
                                                    requestedRevision
                                                )
                                                    setVersionsLoading(false);
                                            }
                                        }}
                                    >
                                        {versionsLoading
                                            ? t("common.loading")
                                            : t("analysis.versionHistory")}
                                    </Button>
                                    {versions !== null &&
                                        !versions.some(
                                            (version) =>
                                                version !==
                                                selectedSaved.version,
                                        ) && (
                                            <p
                                                role="status"
                                                className="text-sm text-muted-foreground"
                                            >
                                                {t(
                                                    "analysis.noEarlierVersions",
                                                )}
                                            </p>
                                        )}
                                    {versions
                                        ?.filter(
                                            (version) =>
                                                version !==
                                                selectedSaved.version,
                                        )
                                        .map((version) => (
                                            <Button
                                                key={version}
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    void apiClient
                                                        .restoreSavedAnalysisVersion(
                                                            selectedSaved.id,
                                                            version,
                                                            selectedSaved.version,
                                                        )
                                                        .then(loadSaved)
                                                }
                                            >
                                                {t("analysis.restoreVersion", {
                                                    version,
                                                })}
                                            </Button>
                                        ))}
                                </div>
                            )}
                            {selectedSaved && (
                                <details>
                                    <summary className="cursor-pointer text-sm font-medium">
                                        {t("analysis.aiEditProposal")}
                                    </summary>
                                    <Textarea
                                        className="mt-2 font-mono text-xs"
                                        value={proposalJson}
                                        onChange={(event) => {
                                            setProposalJson(event.target.value);
                                            setProposalPreview(null);
                                        }}
                                        placeholder={t(
                                            "analysis.aiEditProposalPlaceholder",
                                        )}
                                    />
                                    <div className="mt-2 flex gap-2">
                                        <Button
                                            size="sm"
                                            onClick={() =>
                                                void apiClient
                                                    .generateAnalysisProposal(
                                                        selectedSaved.id,
                                                        proposalJson,
                                                    )
                                                    .then((value) => {
                                                        setProposalPreview(
                                                            value,
                                                        );
                                                        setProposalJson(
                                                            JSON.stringify(
                                                                value.proposal,
                                                                null,
                                                                2,
                                                            ),
                                                        );
                                                    })
                                                    .catch((cause) =>
                                                        setError(
                                                            apiErrorToMessage(
                                                                cause,
                                                                t,
                                                            ),
                                                        ),
                                                    )
                                            }
                                            disabled={!proposalJson.trim()}
                                        >
                                            {t("analysis.generateProposal")}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                try {
                                                    const proposal = JSON.parse(
                                                        proposalJson,
                                                    ) as AnalysisEditProposal;
                                                    void apiClient
                                                        .previewAnalysisProposal(
                                                            proposal,
                                                        )
                                                        .then(
                                                            setProposalPreview,
                                                        )
                                                        .catch((cause) =>
                                                            setError(
                                                                apiErrorToMessage(
                                                                    cause,
                                                                    t,
                                                                ),
                                                            ),
                                                        );
                                                } catch (cause) {
                                                    setError(
                                                        cause instanceof Error
                                                            ? cause.message
                                                            : t(
                                                                  "analysis.proposalInvalid",
                                                              ),
                                                    );
                                                }
                                            }}
                                        >
                                            {t("analysis.revalidateProposal")}
                                        </Button>
                                        {proposalPreview && (
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    void apiClient
                                                        .applyAnalysisProposal(
                                                            proposalPreview.proposal,
                                                        )
                                                        .then(loadSaved)
                                                }
                                            >
                                                {t("analysis.applyProposal")}
                                            </Button>
                                        )}
                                    </div>
                                    {proposalPreview && (
                                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                                            {JSON.stringify(
                                                {
                                                    before: proposalPreview.before,
                                                    after: proposalPreview.after,
                                                },
                                                null,
                                                2,
                                            )}
                                        </pre>
                                    )}
                                </details>
                            )}
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("analysis.savedTitle")}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {savedQuery.data?.map((saved) => (
                                <div
                                    key={saved.id}
                                    className="rounded-lg border p-3"
                                >
                                    <button
                                        className="w-full text-left font-medium hover:text-primary"
                                        onClick={() => loadSaved(saved)}
                                    >
                                        {saved.name}
                                    </button>
                                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                                        <span>
                                            v{saved.version} ·{" "}
                                            {saved.refreshStatus}
                                        </span>
                                        <div>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t(
                                                    "analysis.refresh",
                                                )}
                                                onClick={async () => {
                                                    try {
                                                        loadSaved(
                                                            await apiClient.runSavedAnalysis(
                                                                saved.id,
                                                            ),
                                                        );
                                                        queryClient.invalidateQueries(
                                                            {
                                                                queryKey: [
                                                                    "analysis",
                                                                    "saved",
                                                                ],
                                                            },
                                                        );
                                                    } catch (cause) {
                                                        setError(
                                                            apiErrorToMessage(
                                                                cause,
                                                                t,
                                                            ),
                                                        );
                                                    }
                                                }}
                                            >
                                                <Play className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t(
                                                    "analysis.delete",
                                                )}
                                                onClick={async () => {
                                                    await apiClient.deleteSavedAnalysis(
                                                        saved.id,
                                                    );
                                                    queryClient.invalidateQueries(
                                                        {
                                                            queryKey: [
                                                                "analysis",
                                                                "saved",
                                                            ],
                                                        },
                                                    );
                                                }}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                    {saved.lastError && (
                                        <p className="mt-1 text-xs text-destructive">
                                            {saved.lastError.message}
                                        </p>
                                    )}
                                </div>
                            ))}
                            {savedQuery.data?.length === 0 && (
                                <p className="text-sm text-muted-foreground">
                                    {t("analysis.noneSaved")}
                                </p>
                            )}
                        </CardContent>
                    </Card>
                </aside>
            </div>
        </PageShell>
    );
}
