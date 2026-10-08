import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    ArrowUpDown,
    Database,
    Loader2,
    Play,
    Save,
    Square,
    Trash2,
} from "lucide-react";
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
import { RowMenu } from "@/components/shared/RowMenu";
import { PAGE_ICONS } from "@/lib/pageIcons";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { List, ListRow } from "@/components/ui/list";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/EmptyState";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { useAnalysisWorkspaceQueries } from "@/hooks/useAnalysisQueries";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { resolveAnalysisPreferences } from "@/lib/analysisPreferences";
import { AnalysisChartPanel } from "@/features/analysis/AnalysisChartPanel";
import {
    normalizeAnalysisChartSpec,
    type AnalysisChartSpec,
} from "@/features/analysis/analysisChartModel";
import { AnalysisPivotPanel } from "@/features/analysis/AnalysisPivotPanel";
import {
    AnalysisWorkbenchPanel,
    type AnalysisWorkbenchConfig,
} from "@/features/analysis/AnalysisWorkbenchPanel";
import type { AnalysisPivotConfig } from "@/lib/api/analysis";
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
    analysisDraftSignature,
} from "@/features/analysis/analysisPresentation";

function chartColumns(result: AnalysisResult | null) {
    const columns = result?.declaredColumns?.length
        ? result.declaredColumns
        : (result?.columns ?? []);
    return {
        ids: columns.map((column) => column.id),
        numericIds: columns
            .filter((column) =>
                /decimal|number|integer|numeric|float|double/.test(column.type),
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
const DEFAULT_PREFERENCE = "__default__";
const codeBlockClass =
    "max-h-64 overflow-auto rounded-card corner-continuous border border-border/50 bg-background/60 p-3 type-footnote leading-snug text-foreground/80";
const chipLabelClass =
    "flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-chip border border-border/60 bg-card/70 px-3 type-footnote [overflow-wrap:anywhere]";
const checkLabelClass = "flex items-center gap-2 type-callout";
const legendClass = "type-callout font-medium";
const helpClass = "type-footnote text-label-secondary";

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
            className="overflow-hidden rounded-card corner-continuous border border-border/60 focus-ring"
            tabIndex={0}
        >
            <Table>
                <TableHeader className="bg-foreground/[0.03]">
                    <TableRow>
                        {columns.map((column) => (
                            <TableHead
                                key={column}
                                scope="col"
                                className="px-2"
                            >
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    className="gap-1 px-2 text-label-secondary hover:text-foreground"
                                    onClick={() => onSort(column)}
                                >
                                    {analysisColumnLabel(
                                        result,
                                        column,
                                        datasets,
                                        t,
                                    )}
                                    <ArrowUpDown
                                        aria-hidden="true"
                                        className="h-3 w-3 opacity-60"
                                    />
                                </Button>
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {result.rows.map((row, index) => (
                        <TableRow
                            key={index}
                            className="focus-ring focus-visible:outline-offset-[-3px]"
                            onDoubleClick={() => onDrill?.(row)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && onDrill) {
                                    onDrill(row);
                                }
                            }}
                            tabIndex={onDrill ? 0 : undefined}
                        >
                            {columns.map((column) => (
                                <TableCell
                                    key={column}
                                    className="max-w-72 truncate py-2 font-mono type-footnote"
                                >
                                    {formatAnalysisValue(
                                        row[column],
                                        inferColumnType(result, column),
                                        column,
                                        appSettings.numberFormat,
                                    )}
                                </TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

export default function AnalysisWorkspacePage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const queryClient = useQueryClient();
    const { confirm, ConfirmDialog } = useConfirmDialog();
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
    const [toolsOpen, setToolsOpen] = useState(false);
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
    const [exportInputsKnown, setExportInputsKnown] = useState(false);
    const [resultInputs, setResultInputs] = useState({
        formulasJson: "[]",
        assumptionsJson: "[]",
        assumptionValuesJson: "{}",
        workbench: {} as AnalysisWorkbenchConfig,
        scenarioModel: { attachments: [], joins: [] } as AnalysisScenarioModel,
    });
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
    const draftEpoch = useRef(0);
    const draftSnapshot = useRef("");
    const runRequest = useRef<string | null>(null);
    const [savedAction, setSavedAction] = useState(false);
    const savedActionLock = useRef(false);
    const [savedFeedback, setSavedFeedback] = useState<{
        error: boolean;
        message: string;
    } | null>(null);
    const resetPendingDraft = () => {
        draftEpoch.current += 1;
        runRequest.current = null;
        setActiveRequest(null);
        setSavedFeedback(null);
    };
    const savedOperation = async (
        operation: (epoch: number, canApply: () => boolean) => Promise<void>,
    ) => {
        if (savedActionLock.current) return;
        savedActionLock.current = true;
        setSavedAction(true);
        setSavedFeedback(null);
        const epoch = draftEpoch.current;
        const snapshot = draftSnapshot.current;
        try {
            await operation(
                epoch,
                () =>
                    epoch === draftEpoch.current &&
                    snapshot === draftSnapshot.current,
            );
            if (epoch === draftEpoch.current)
                setSavedFeedback({
                    error: false,
                    message: t("analysis.savedActionComplete"),
                });
        } catch (cause) {
            if (epoch === draftEpoch.current)
                setSavedFeedback({
                    error: true,
                    message: apiErrorToMessage(cause, t),
                });
        } finally {
            savedActionLock.current = false;
            setSavedAction(false);
        }
    };
    const selectedRevision = useRef("");
    selectedRevision.current = selectedSaved
        ? `${selectedSaved.id}:${selectedSaved.version}`
        : "";
    const [resultDatasetId, setResultDatasetId] = useState<string | null>(null);
    const [drillResult, setDrillResult] = useState<AnalysisResult | null>(null);
    const [chartSpec, setChartSpec] = useState<AnalysisChartSpec>({
        kind: "bar",
        x: "",
        y: [],
    });
    const [workbench, setWorkbench] = useState<AnalysisWorkbenchConfig>({});
    const [pivotConfig, setPivotConfig] = useState<AnalysisPivotConfig>({
        rows: ["category_general"],
        columns: ["month"],
        values: ["sum_spending"],
        filters: [],
    });
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

    const resultHeadingRef = useRef<HTMLHeadingElement>(null);
    const [resultFocusRequest, setResultFocusRequest] = useState(0);
    useEffect(() => {
        if (!resultFocusRequest) return;
        resultHeadingRef.current?.focus();
        resultHeadingRef.current?.scrollIntoView?.({ block: "start" });
    }, [resultFocusRequest]);

    const execute = async (
        pageOffset = 0,
        planOverride: VisualAnalysisPlan = plan,
        revealResult = false,
    ) => {
        const id = requestId();
        runRequest.current = id;
        setActiveRequest(id);
        setError(null);
        try {
            const next = await apiClient.executeAnalysis(
                mode === "visual"
                    ? {
                          requestId: id,
                          mode,
                          plan: planOverride,
                          workbench: workbench as Record<string, unknown>,
                          scenarioModel,
                          formulaModel: {
                              formulas: JSON.parse(formulasJson),
                              assumptions: JSON.parse(assumptionsJson),
                              assumptionValues:
                                  JSON.parse(assumptionValuesJson),
                          },
                          limit: planOverride.limit,
                          offset: pageOffset,
                      }
                    : {
                          requestId: id,
                          mode,
                          sql,
                          workbench: workbench as Record<string, unknown>,
                          scenarioModel,
                          formulaModel: {
                              formulas: JSON.parse(formulasJson),
                              assumptions: JSON.parse(assumptionsJson),
                              assumptionValues:
                                  JSON.parse(assumptionValuesJson),
                          },
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
            if (runRequest.current !== id) return;
            setExportInputsKnown(true);
            setResultInputs({
                formulasJson,
                assumptionsJson,
                assumptionValuesJson,
                workbench,
                scenarioModel,
            });
            setResult(next);
            if (revealResult) {
                setBuilderOpen(false);
                setToolsOpen(false);
                setResultFocusRequest((value) => value + 1);
            }
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
            setChartSpec((current) => ({
                ...current,
                x: ids.includes(current.x) ? current.x : (ids[0] ?? ""),
                y: current.y.some((id) => numericIds.includes(id))
                    ? current.y.filter((id) => numericIds.includes(id))
                    : [numericIds[0]].filter(Boolean),
            }));
        } catch (cause) {
            if (runRequest.current !== id) return;
            setBuilderOpen(true);
            setError(apiErrorToMessage(cause, t));
        } finally {
            if (runRequest.current === id) {
                runRequest.current = null;
                setActiveRequest(null);
            }
        }
    };

    const saveMutation = useMutation({
        onMutate: () => {
            setSavedFeedback(null);
            return draftEpoch.current;
        },
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
                    workbench,
                    pivotConfig,
                    financialPlan: Object.fromEntries(
                        [
                            "reportingCurrency",
                            "from",
                            "to",
                            "symbol",
                            "range",
                            "costBasisMethod",
                        ].map((key) => [
                            key,
                            plan[key as keyof VisualAnalysisPlan],
                        ]),
                    ),
                },
                charts: [chartSpec],
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
        onSuccess: (saved, _variables, epoch) => {
            if (epoch === draftEpoch.current) {
                setSelectedSaved(saved);
                setSavedFeedback({
                    error: false,
                    message: t("analysis.savedActionComplete"),
                });
            }
            queryClient.invalidateQueries({ queryKey: ["analysis", "saved"] });
        },
        onError: (cause, _variables, epoch) => {
            if (epoch === draftEpoch.current)
                setSavedFeedback({
                    error: true,
                    message: apiErrorToMessage(cause, t),
                });
        },
    });

    const loadSaved = useCallback(
        (saved: SavedAnalysis) => {
            draftEpoch.current += 1;
            runRequest.current = null;
            setActiveRequest(null);
            setSavedFeedback(null);
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
            const binding = normalizeAnalysisChartSpec(saved.charts[0]);
            setChartSpec({
                ...binding,
                x:
                    binding.x && (!saved.lastResult || ids.includes(binding.x))
                        ? binding.x
                        : ids[0] || "",
                y:
                    binding.y.length &&
                    (!saved.lastResult ||
                        binding.y.some((id) => numericIds.includes(id)))
                        ? binding.y.filter(
                              (id) =>
                                  !saved.lastResult || numericIds.includes(id),
                          )
                        : [numericIds[0]].filter(Boolean),
            });
            setWorkbench(
                (saved.parameters.workbench as AnalysisWorkbenchConfig) || {},
            );
            setPivotConfig(
                (saved.parameters.pivotConfig as AnalysisPivotConfig) || {
                    rows: source.plan?.groups.slice(0, 1) || [],
                    columns: source.plan?.groups.slice(1, 2) || [],
                    values: source.plan?.measures || [],
                    filters: [],
                },
            );
            if (source.plan)
                setPlan({
                    ...source.plan,
                    ...((saved.parameters
                        .financialPlan as Partial<VisualAnalysisPlan>) || {}),
                });
            setOffset(0);
            setExportInputsKnown(false);
            setResultInputs({
                formulasJson: JSON.stringify(
                    (
                        saved.parameters.formulaModel as
                            { formulas?: unknown[] } | undefined
                    )?.formulas ?? [],
                ),
                assumptionsJson: JSON.stringify(
                    (
                        saved.parameters.formulaModel as
                            { assumptions?: unknown[] } | undefined
                    )?.assumptions ?? [],
                ),
                assumptionValuesJson: JSON.stringify(
                    (
                        saved.parameters.formulaModel as
                            | { assumptionValues?: Record<string, unknown> }
                            | undefined
                    )?.assumptionValues ?? {},
                ),
                workbench:
                    (saved.parameters.workbench as AnalysisWorkbenchConfig) ||
                    {},
                scenarioModel: (saved.parameters
                    .scenarioModel as AnalysisScenarioModel) || {
                    attachments: [],
                    joins: [],
                },
            });
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
    draftSnapshot.current = JSON.stringify({
        currentQuery,
        name,
        formulasJson,
        assumptionsJson,
        assumptionValuesJson,
        workbench,
        scenarioModel,
        chartSpec,
        pivotConfig,
        sourceReferences,
        workspace,
    });
    const transformationsOutdated =
        analysisDraftSignature(resultInputs) !==
        analysisDraftSignature({
            formulasJson,
            assumptionsJson,
            assumptionValuesJson,
            workbench,
            scenarioModel,
        });
    const queryOutdated = resultQuery !== null && resultQuery !== currentQuery;

    return (
        <PageShell>
            <PageHeader
                title={t("analysis.title")}
                subtitle={t("analysis.subtitle")}
                icon={PAGE_ICONS["/analysis"]}
            />
            <nav
                aria-label={t("analysis.workflow.title")}
                className="mb-4 flex flex-wrap gap-2"
            >
                {["data", "prepare", "calculate", "present"].map((step) => (
                    <Button key={step} asChild variant="outline" size="sm">
                        <a
                            href={`#analysis-${step}`}
                            onClick={() => {
                                if (step === "prepare" || step === "calculate")
                                    setToolsOpen(true);
                            }}
                        >
                            {t(`analysis.workflow.${step}`)}
                        </a>
                    </Button>
                ))}
            </nav>
            <div className="space-y-4">
                <div className="min-w-0 space-y-4">
                    {dataset?.relation?.startsWith("service:") && (
                        <Card>
                            <CardContent
                                variant="compact"
                                className="grid gap-3 sm:grid-cols-3"
                            >
                                {(
                                    [
                                        "reportingCurrency",
                                        "from",
                                        "to",
                                        "symbol",
                                        "range",
                                        "costBasisMethod",
                                    ] as const
                                ).map((key) => (
                                    <div key={key} className="space-y-1.5">
                                        <Label
                                            htmlFor={`analysis-financial-${key}`}
                                        >
                                            {t(`analysis.ext.financial.${key}`)}
                                        </Label>
                                        <Input
                                            id={`analysis-financial-${key}`}
                                            type={
                                                key === "from" || key === "to"
                                                    ? "date"
                                                    : "text"
                                            }
                                            value={String(plan[key] ?? "")}
                                            onChange={(event) =>
                                                setPlan({
                                                    ...plan,
                                                    [key]:
                                                        event.target.value ||
                                                        undefined,
                                                })
                                            }
                                        />
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    )}
                    <Card>
                        <Disclosure
                            open={templatesOpen}
                            onToggle={(event) =>
                                setTemplatesOpen(event.currentTarget.open)
                            }
                        >
                            <DisclosureSummary
                                ref={templateSummaryRef}
                                className="rounded-card px-6 py-4"
                            >
                                {t(
                                    templatesOpen
                                        ? "analysis.startTitle"
                                        : "analysis.chooseTemplate",
                                )}
                            </DisclosureSummary>
                            <CardContent className="space-y-3">
                                <p className="max-w-prose type-callout text-label-secondary">
                                    {t("analysis.taskStartHelp")}
                                </p>
                                <div className="grid gap-3 md:grid-cols-3">
                                    {ANALYSIS_TEMPLATES.map((template) => (
                                        <Card
                                            key={template.id}
                                            asChild
                                            variant="interactive"
                                        >
                                            <button
                                                type="button"
                                                className="p-4 text-left focus-ring"
                                                onClick={() => {
                                                    resetPendingDraft();
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
                                                    setName(
                                                        t(template.titleKey),
                                                    );
                                                    setSelectedSaved(null);
                                                    setResult(null);
                                                    setLastUsableResult(null);
                                                    setExportContext(null);
                                                    setError(null);
                                                }}
                                            >
                                                <span className="block type-headline">
                                                    {t(template.titleKey)}
                                                </span>
                                                <span className="mt-1 block type-footnote text-label-secondary">
                                                    {t(template.descriptionKey)}
                                                </span>
                                            </button>
                                        </Card>
                                    ))}
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        resetPendingDraft();
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
                        </Disclosure>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle
                                id="analysis-data"
                                className="scroll-mt-4"
                            >
                                {t("analysis.workflow.data")}
                            </CardTitle>
                            <CardDescription className="max-w-2xl">
                                {t("analysis.buildHelp")}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {!builderOpen && mode === "visual" && dataset && (
                                <dl className="grid gap-3 type-body sm:grid-cols-2">
                                    <div>
                                        <dt className={helpClass}>
                                            {t("analysis.dataset")}
                                        </dt>
                                        <dd className="mt-1">
                                            {dataset.label}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className={helpClass}>
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
                                        <dt className={helpClass}>
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
                                        <dt className={helpClass}>
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
                            <Disclosure
                                open={builderOpen}
                                onToggle={(event) =>
                                    setBuilderOpen(event.currentTarget.open)
                                }
                            >
                                <DisclosureSummary ref={builderSummaryRef}>
                                    {t("analysis.editConfiguration")}
                                </DisclosureSummary>
                                <div className="mt-4 space-y-4">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <SegmentedControl
                                            aria-label={t("analysis.mode")}
                                            value={mode}
                                            onValueChange={(next) => {
                                                if (next === "visual") {
                                                    setMode("visual");
                                                    return;
                                                }
                                                if (
                                                    !sql &&
                                                    result?.generatedSql
                                                )
                                                    setSql(result.generatedSql);
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
                                            <SegmentedControlItem value="visual">
                                                {t("analysis.visual")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem value="sql">
                                                {t("analysis.sql")}
                                            </SegmentedControlItem>
                                        </SegmentedControl>
                                        <Select
                                            value={workspace}
                                            onValueChange={(value) =>
                                                setWorkspace(
                                                    value as AnalysisWorkspace,
                                                )
                                            }
                                        >
                                            <SelectTrigger
                                                aria-label={t(
                                                    "analysis.workspace",
                                                )}
                                                className="w-auto min-w-44"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {WORKSPACES.map((value) => (
                                                    <SelectItem
                                                        key={value}
                                                        value={value}
                                                    >
                                                        {t(
                                                            `analysis.workspace.${value}`,
                                                        )}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {catalogQuery.isLoading ? (
                                        <div
                                            role="status"
                                            aria-busy="true"
                                            aria-label={t(
                                                "analysis.catalogLoading",
                                            )}
                                            className="space-y-2"
                                        >
                                            <span className="sr-only">
                                                {t("analysis.catalogLoading")}
                                            </span>
                                            <Skeleton className="h-9 w-full rounded-control" />
                                            <Skeleton className="h-24 w-full rounded-card" />
                                        </div>
                                    ) : catalogQuery.isError ? (
                                        <Alert variant="destructive">
                                            <AlertDescription>
                                                {t("analysis.catalogError")}
                                            </AlertDescription>
                                        </Alert>
                                    ) : localizedDatasets.length === 0 ? (
                                        <EmptyState
                                            size="compact"
                                            headingLevel={3}
                                            icon={Database}
                                            title={t("analysis.catalogEmpty")}
                                        />
                                    ) : mode === "visual" && dataset ? (
                                        <>
                                            <div className="space-y-1.5">
                                                <Label htmlFor="analysis-dataset">
                                                    {t("analysis.dataset")}
                                                </Label>
                                                <Select
                                                    value={plan.datasetId}
                                                    onValueChange={(value) =>
                                                        setPlan({
                                                            ...EMPTY_PLAN,
                                                            datasetId: value,
                                                        })
                                                    }
                                                >
                                                    <SelectTrigger id="analysis-dataset">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {localizedDatasets.map(
                                                            (entry) => (
                                                                <SelectItem
                                                                    key={
                                                                        entry.id
                                                                    }
                                                                    value={
                                                                        entry.id
                                                                    }
                                                                >
                                                                    {
                                                                        entry.label
                                                                    }
                                                                </SelectItem>
                                                            ),
                                                        )}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="grid gap-4 lg:grid-cols-2">
                                                <fieldset>
                                                    <legend
                                                        className={legendClass}
                                                    >
                                                        {t("analysis.fields")}
                                                    </legend>
                                                    <p
                                                        className={`mt-1 ${helpClass}`}
                                                    >
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
                                                                    className={
                                                                        checkLabelClass
                                                                    }
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
                                                    <legend
                                                        className={legendClass}
                                                    >
                                                        {t("analysis.measures")}
                                                    </legend>
                                                    <p
                                                        className={`mt-1 ${helpClass}`}
                                                    >
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
                                                                    className={
                                                                        checkLabelClass
                                                                    }
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
                                                                    className={
                                                                        checkLabelClass
                                                                    }
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
                                                <p className={legendClass}>
                                                    {t("analysis.groups")}
                                                </p>
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    {plan.fields.map((id) => (
                                                        <label
                                                            key={id}
                                                            className={
                                                                chipLabelClass
                                                            }
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
                                                    <span
                                                        className={legendClass}
                                                    >
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
                                                                <Select
                                                                    value={
                                                                        filter.fieldId
                                                                    }
                                                                    onValueChange={(
                                                                        value,
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
                                                                                                          value,
                                                                                                  }
                                                                                                : item,
                                                                                    ),
                                                                            }),
                                                                        )
                                                                    }
                                                                >
                                                                    <SelectTrigger
                                                                        aria-label={t(
                                                                            "analysis.filterField",
                                                                            {
                                                                                number:
                                                                                    index +
                                                                                    1,
                                                                            },
                                                                        )}
                                                                    >
                                                                        <SelectValue />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        {dataset.fields.map(
                                                                            (
                                                                                field,
                                                                            ) => (
                                                                                <SelectItem
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
                                                                                </SelectItem>
                                                                            ),
                                                                        )}
                                                                    </SelectContent>
                                                                </Select>
                                                                <Select
                                                                    value={
                                                                        filter.operator
                                                                    }
                                                                    onValueChange={(
                                                                        value,
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
                                                                                                          value,
                                                                                                  }
                                                                                                : item,
                                                                                    ),
                                                                            }),
                                                                        )
                                                                    }
                                                                >
                                                                    <SelectTrigger
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
                                                                    >
                                                                        <SelectValue />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        {OPERATORS.map(
                                                                            (
                                                                                operator,
                                                                            ) => (
                                                                                <SelectItem
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
                                                                                </SelectItem>
                                                                            ),
                                                                        )}
                                                                    </SelectContent>
                                                                </Select>
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
                                                className="min-h-56 font-mono type-footnote"
                                                value={sql}
                                                onChange={(event) =>
                                                    setSql(event.target.value)
                                                }
                                                spellCheck={false}
                                            />
                                            <fieldset className="space-y-2 rounded-card corner-continuous border border-border/60 p-3">
                                                <legend
                                                    className={`px-1 ${legendClass}`}
                                                >
                                                    {t(
                                                        "analysis.approvedDatasets",
                                                    )}
                                                </legend>
                                                <div className="flex flex-wrap gap-2">
                                                    {localizedDatasets.map(
                                                        (entry) => (
                                                            <label
                                                                key={entry.id}
                                                                className={
                                                                    chipLabelClass
                                                                }
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
                                                    className="mt-1.5 font-mono type-footnote"
                                                    value={sqlValues}
                                                    onChange={(event) =>
                                                        setSqlValues(
                                                            event.target.value,
                                                        )
                                                    }
                                                    placeholder='["2026-01-01", 100]'
                                                />
                                                <p
                                                    className={`mt-1 ${helpClass}`}
                                                >
                                                    {t(
                                                        "analysis.sqlParametersHint",
                                                    )}
                                                </p>
                                            </div>
                                            <p className={helpClass}>
                                                {t("analysis.sqlHint")}
                                            </p>
                                            {sqlHistory.length > 0 && (
                                                <Disclosure>
                                                    <DisclosureSummary tone="subtle">
                                                        {t(
                                                            "analysis.queryHistory",
                                                        )}
                                                    </DisclosureSummary>
                                                    <div className="mt-1 flex flex-col">
                                                        {sqlHistory.map(
                                                            (entry, index) => (
                                                                <Button
                                                                    key={index}
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-auto max-w-full justify-start py-1 font-mono type-footnote font-normal text-label-secondary"
                                                                    onClick={() =>
                                                                        setSql(
                                                                            entry,
                                                                        )
                                                                    }
                                                                >
                                                                    <span className="truncate">
                                                                        {entry}
                                                                    </span>
                                                                </Button>
                                                            ),
                                                        )}
                                                    </div>
                                                </Disclosure>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </Disclosure>
                            <div className="flex gap-2">
                                <Button
                                    onClick={() => execute(0, plan, true)}
                                    disabled={!!activeRequest}
                                >
                                    {activeRequest ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                                    ) : (
                                        <Play className="mr-2 h-4 w-4" />
                                    )}
                                    {activeRequest
                                        ? t("analysis.running")
                                        : t("analysis.run")}
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
                                <Alert variant="destructive">
                                    <AlertDescription>
                                        {error}
                                        {lastUsableResult && (
                                            <p className="mt-1 type-footnote">
                                                {t(
                                                    "analysis.lastResultPreserved",
                                                )}
                                            </p>
                                        )}
                                    </AlertDescription>
                                </Alert>
                            )}
                        </CardContent>
                    </Card>

                    {displayedResult && (
                        <Card>
                            <CardHeader>
                                <CardTitle
                                    id="analysis-present"
                                    ref={resultHeadingRef}
                                    tabIndex={-1}
                                    className="flex scroll-mt-4 flex-wrap items-center gap-2"
                                >
                                    <Database
                                        aria-hidden="true"
                                        className="h-5 w-5 text-label-secondary"
                                    />
                                    {t("analysis.workflow.present")}
                                    <Badge variant="secondary">
                                        {displayedResult.window.returnedRows}
                                    </Badge>
                                </CardTitle>
                                <CardDescription>
                                    {t("analysis.resultsHelp")}
                                </CardDescription>
                            </CardHeader>
                            {(queryOutdated || transformationsOutdated) && (
                                <div className="px-6 pb-3">
                                    <Alert variant="warning">
                                        <AlertDescription>
                                            {t("analysis.resultsOutdated")}
                                        </AlertDescription>
                                    </Alert>
                                </div>
                            )}
                            {!!displayedResult.formulaErrors?.length && (
                                <Alert
                                    variant="warning"
                                    className="mx-6 mb-3 w-auto"
                                >
                                    <AlertDescription>
                                        <p>
                                            {t("analysis.formulaErrorsNotice")}
                                        </p>
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
                                    </AlertDescription>
                                </Alert>
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
                                        <div
                                            className={`flex items-center justify-between ${helpClass}`}
                                        >
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
                                        <Disclosure>
                                            <DisclosureSummary>
                                                {t("analysis.generatedSql")}
                                            </DisclosureSummary>
                                            <pre
                                                className={`mt-2 ${codeBlockClass}`}
                                            >
                                                {displayedResult.generatedSql}
                                            </pre>
                                        </Disclosure>
                                    </CardContent>
                                </TabsContent>
                                {displayedResult.coverage && (
                                    <div
                                        className={`px-6 pb-3 ${helpClass}`}
                                        role="status"
                                    >
                                        {t("analysis.ext.financial.coverage", {
                                            status:
                                                displayedResult.coverage
                                                    .status ?? "—",
                                            missing:
                                                displayedResult.coverage
                                                    .unavailableRows ?? 0,
                                        })}
                                    </div>
                                )}
                                {displayedResult.provenance && (
                                    <Disclosure
                                        className={`px-6 pb-3 ${helpClass}`}
                                    >
                                        <DisclosureSummary tone="footnote">
                                            {t(
                                                "analysis.ext.financial.provenance",
                                            )}
                                        </DisclosureSummary>
                                        {Object.entries(
                                            displayedResult.provenance,
                                        ).map(([key, value]) => (
                                            <div
                                                className="flex gap-2"
                                                key={key}
                                            >
                                                <span>{key}</span>
                                                <span>{String(value)}</span>
                                            </div>
                                        ))}
                                    </Disclosure>
                                )}
                                <TabsContent value="chart" className="mt-0">
                                    <CardContent>
                                        <AnalysisChartPanel
                                            result={{
                                                ...displayedResult,
                                                declaredColumns:
                                                    (displayedResult
                                                        .declaredColumns?.length
                                                        ? displayedResult.declaredColumns
                                                        : displayedResult.columns
                                                    ).map((column) => ({
                                                        ...column,
                                                        label: analysisColumnLabel(
                                                            displayedResult,
                                                            column.id,
                                                            presentationDatasets,
                                                            t,
                                                        ),
                                                        nullable: true,
                                                    })),
                                            }}
                                            spec={chartSpec}
                                            onChange={setChartSpec}
                                        />
                                    </CardContent>
                                </TabsContent>
                                <TabsContent value="pivot" className="mt-0">
                                    <CardContent>
                                        {mode === "visual" && dataset ? (
                                            <AnalysisPivotPanel
                                                plan={plan}
                                                dataset={dataset}
                                                config={pivotConfig}
                                                onChange={setPivotConfig}
                                                onDrill={async (
                                                    groups,
                                                    row,
                                                ) => {
                                                    try {
                                                        setDrillResult(
                                                            await apiClient.drillAnalysis(
                                                                {
                                                                    ...plan,
                                                                    groups,
                                                                    filters: [
                                                                        ...plan.filters,
                                                                        ...pivotConfig.filters,
                                                                    ],
                                                                },
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
                                                }}
                                            />
                                        ) : (
                                            <p className="type-callout text-label-secondary">
                                                {t("analysis.pivotHelp")}
                                            </p>
                                        )}
                                    </CardContent>
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
                    <Card>
                        <Disclosure
                            open={toolsOpen}
                            onToggle={(event) =>
                                setToolsOpen(event.currentTarget.open)
                            }
                        >
                            <DisclosureSummary className="rounded-card px-6 py-4">
                                {t("analysis.refineTitle")}
                                <span className="mt-1 block max-w-2xl type-callout font-normal text-label-secondary">
                                    {t("analysis.refineHelp")}
                                </span>
                            </DisclosureSummary>
                            <CardContent className="min-w-0 pt-2">
                                <AnalysisWorkbenchPanel
                                    result={
                                        displayedResult?.sourceResult ||
                                        displayedResult
                                    }
                                    formulasJson={formulasJson}
                                    onFormulasChange={setFormulasJson}
                                    assumptionsJson={assumptionsJson}
                                    onAssumptionsChange={setAssumptionsJson}
                                    assumptionValuesJson={assumptionValuesJson}
                                    onAssumptionValuesChange={
                                        setAssumptionValuesJson
                                    }
                                    config={workbench}
                                    onConfigChange={setWorkbench}
                                    attachments={scenarioModel.attachments}
                                    sourceStale={
                                        queryOutdated ||
                                        Boolean(activeRequest) ||
                                        JSON.stringify(
                                            resultInputs.scenarioModel,
                                        ) !== JSON.stringify(scenarioModel)
                                    }
                                    onResultChange={(next) => {
                                        setResultInputs({
                                            formulasJson,
                                            assumptionsJson,
                                            assumptionValuesJson,
                                            workbench,
                                            scenarioModel,
                                        });
                                        const updated = {
                                            ...next,
                                            sourceResult:
                                                displayedResult?.sourceResult ||
                                                displayedResult ||
                                                undefined,
                                        };
                                        setResult(updated);
                                        setLastUsableResult(updated);
                                    }}
                                />
                            </CardContent>
                        </Disclosure>
                    </Card>
                </div>

                <aside className="grid items-start gap-4 lg:grid-cols-2">
                    {(savedAction ||
                        saveMutation.isPending ||
                        savedFeedback) && (
                        <Alert
                            role={savedFeedback?.error ? "alert" : "status"}
                            variant={
                                savedFeedback?.error ? "destructive" : "default"
                            }
                            className="break-words lg:col-span-2"
                        >
                            <AlertDescription>
                                {savedAction || saveMutation.isPending
                                    ? t("analysis.savedActionWorking")
                                    : savedFeedback?.message}
                                {savedFeedback?.error && (
                                    <span className="mt-1 block type-footnote opacity-80">
                                        {t("analysis.savedActionRetry")}
                                    </span>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("analysis.saveTitle")}</CardTitle>
                            <CardDescription>
                                {t("analysis.saveHelp")}
                            </CardDescription>
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
                            <Disclosure variant="card">
                                <DisclosureSummary padded>
                                    {t("analysis.sourcesLabel")}
                                </DisclosureSummary>
                                <DisclosureContent className="space-y-2">
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
                                </DisclosureContent>
                            </Disclosure>
                            <Disclosure variant="card">
                                <DisclosureSummary padded>
                                    {t("analysis.runPreferences")}
                                </DisclosureSummary>
                                <DisclosureContent className="space-y-2">
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="analysis-run-currency">
                                                {t(
                                                    "analysis.reportingCurrency",
                                                )}
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
                                        <div className="space-y-1.5">
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
                                                    checked={
                                                        runWithoutBenchmark
                                                    }
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
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
                                        <SegmentedControl
                                            label={t("analysis.answerDepth")}
                                            size="sm"
                                            className="w-full"
                                            value={
                                                runAnswerDepth ||
                                                DEFAULT_PREFERENCE
                                            }
                                            onValueChange={(value) =>
                                                setRunAnswerDepth(
                                                    value === DEFAULT_PREFERENCE
                                                        ? ""
                                                        : value,
                                                )
                                            }
                                        >
                                            <SegmentedControlItem
                                                value={DEFAULT_PREFERENCE}
                                            >
                                                {t("analysis.useDefault")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem value="quick">
                                                {t("aiResearch.quick")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem value="detailed">
                                                {t("aiResearch.detailed")}
                                            </SegmentedControlItem>
                                        </SegmentedControl>
                                        <SegmentedControl
                                            label={t("analysis.language")}
                                            size="sm"
                                            className="w-full"
                                            value={
                                                runLanguage ||
                                                DEFAULT_PREFERENCE
                                            }
                                            onValueChange={(value) =>
                                                setRunLanguage(
                                                    value === DEFAULT_PREFERENCE
                                                        ? ""
                                                        : value,
                                                )
                                            }
                                        >
                                            <SegmentedControlItem
                                                value={DEFAULT_PREFERENCE}
                                            >
                                                {t("analysis.useDefault")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem value="en">
                                                {t("settings.general.lang.en")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem value="nl">
                                                {t("settings.general.lang.nl")}
                                            </SegmentedControlItem>
                                        </SegmentedControl>
                                    </div>
                                    <p className={helpClass}>
                                        {t("analysis.preferencePrecedence")}
                                    </p>
                                </DisclosureContent>
                            </Disclosure>
                            <Disclosure variant="card">
                                <DisclosureSummary padded>
                                    {t("analysis.filesAndScenarios")}
                                </DisclosureSummary>
                                <DisclosureContent className="space-y-2">
                                    {displayedResult &&
                                        (!exportInputsKnown ||
                                            queryOutdated ||
                                            transformationsOutdated) && (
                                            <p
                                                role="status"
                                                className="type-callout text-label-secondary"
                                            >
                                                {t("analysis.exportNeedsRun")}
                                            </p>
                                        )}
                                    <AnalysisInterchangePanel
                                        result={
                                            !exportInputsKnown ||
                                            queryOutdated ||
                                            transformationsOutdated
                                                ? null
                                                : displayedResult
                                        }
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
                                        assumptions={{
                                            definitions: JSON.parse(
                                                resultInputs.assumptionsJson,
                                            ),
                                            values: JSON.parse(
                                                resultInputs.assumptionValuesJson,
                                            ),
                                        }}
                                        formulas={JSON.parse(
                                            resultInputs.formulasJson,
                                        )}
                                        scenarioModel={scenarioModel}
                                        onScenarioModelChange={setScenarioModel}
                                    />
                                </DisclosureContent>
                            </Disclosure>
                            <Button
                                className="w-full"
                                onClick={() => saveMutation.mutate()}
                                disabled={
                                    !displayedResult ||
                                    saveMutation.isPending ||
                                    savedAction
                                }
                            >
                                <Save className="mr-2 h-4 w-4" />
                                {selectedSaved
                                    ? t("analysis.saveVersion")
                                    : t("analysis.save")}
                            </Button>
                            {selectedSaved && (
                                <div className="space-y-2">
                                    <p className={helpClass}>
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
                                                className="type-callout text-label-secondary"
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
                                                disabled={
                                                    savedAction ||
                                                    saveMutation.isPending
                                                }
                                                onClick={() =>
                                                    void savedOperation(
                                                        async (
                                                            _epoch,
                                                            canApply,
                                                        ) => {
                                                            const restored =
                                                                await apiClient.restoreSavedAnalysisVersion(
                                                                    selectedSaved.id,
                                                                    version,
                                                                    selectedSaved.version,
                                                                );
                                                            if (canApply())
                                                                loadSaved(
                                                                    restored,
                                                                );
                                                            queryClient.invalidateQueries(
                                                                {
                                                                    queryKey: [
                                                                        "analysis",
                                                                        "saved",
                                                                    ],
                                                                },
                                                            );
                                                        },
                                                    )
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
                                <Disclosure variant="card">
                                    <DisclosureSummary padded>
                                        {t("analysis.aiEditProposal")}
                                    </DisclosureSummary>
                                    <DisclosureContent className="space-y-2">
                                        <Textarea
                                            className="font-mono type-footnote"
                                            value={proposalJson}
                                            onChange={(event) => {
                                                setProposalJson(
                                                    event.target.value,
                                                );
                                                setProposalPreview(null);
                                            }}
                                            placeholder={t(
                                                "analysis.aiEditProposalPlaceholder",
                                            )}
                                        />
                                        <div className="flex flex-wrap gap-2">
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
                                                        const proposal =
                                                            JSON.parse(
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
                                                            cause instanceof
                                                                Error
                                                                ? cause.message
                                                                : t(
                                                                      "analysis.proposalInvalid",
                                                                  ),
                                                        );
                                                    }
                                                }}
                                            >
                                                {t(
                                                    "analysis.revalidateProposal",
                                                )}
                                            </Button>
                                            {proposalPreview && (
                                                <Button
                                                    size="sm"
                                                    disabled={
                                                        savedAction ||
                                                        saveMutation.isPending
                                                    }
                                                    onClick={() =>
                                                        void savedOperation(
                                                            async (
                                                                _epoch,
                                                                canApply,
                                                            ) => {
                                                                const applied =
                                                                    await apiClient.applyAnalysisProposal(
                                                                        proposalPreview.proposal,
                                                                    );
                                                                if (canApply())
                                                                    loadSaved(
                                                                        applied,
                                                                    );
                                                                queryClient.invalidateQueries(
                                                                    {
                                                                        queryKey:
                                                                            [
                                                                                "analysis",
                                                                                "saved",
                                                                            ],
                                                                    },
                                                                );
                                                            },
                                                        )
                                                    }
                                                >
                                                    {t(
                                                        "analysis.applyProposal",
                                                    )}
                                                </Button>
                                            )}
                                        </div>
                                        {proposalPreview && (
                                            <pre className={codeBlockClass}>
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
                                    </DisclosureContent>
                                </Disclosure>
                            )}
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("analysis.savedTitle")}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {!!savedQuery.data?.length && (
                                <List>
                                    {savedQuery.data?.map((saved) => {
                                        const active =
                                            selectedSaved?.id === saved.id;
                                        return (
                                            <ListRow
                                                key={saved.id}
                                                asChild
                                                selected={active}
                                                title={saved.name}
                                                subtitle={
                                                    <>
                                                        v{saved.version} ·{" "}
                                                        {saved.refreshStatus}
                                                        {saved.lastError && (
                                                            <span className="block whitespace-normal text-destructive">
                                                                {
                                                                    saved
                                                                        .lastError
                                                                        .message
                                                                }
                                                            </span>
                                                        )}
                                                    </>
                                                }
                                                actions={
                                                    <RowMenu
                                                        label={t(
                                                            "analysis.rowMenu",
                                                            {
                                                                name: saved.name,
                                                            },
                                                        )}
                                                    >
                                                        <DropdownMenuItem
                                                            disabled={
                                                                savedAction ||
                                                                saveMutation.isPending
                                                            }
                                                            onSelect={() =>
                                                                void savedOperation(
                                                                    async (
                                                                        _epoch,
                                                                        canApply,
                                                                    ) => {
                                                                        const refreshed =
                                                                            await apiClient.runSavedAnalysis(
                                                                                saved.id,
                                                                            );
                                                                        if (
                                                                            canApply()
                                                                        )
                                                                            loadSaved(
                                                                                refreshed,
                                                                            );
                                                                        queryClient.invalidateQueries(
                                                                            {
                                                                                queryKey:
                                                                                    [
                                                                                        "analysis",
                                                                                        "saved",
                                                                                    ],
                                                                            },
                                                                        );
                                                                    },
                                                                )
                                                            }
                                                        >
                                                            <Play
                                                                aria-hidden="true"
                                                                className="mr-2 h-4 w-4 text-label-secondary"
                                                            />
                                                            {t(
                                                                "analysis.refresh",
                                                            )}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            variant="destructive"
                                                            disabled={
                                                                savedAction ||
                                                                saveMutation.isPending
                                                            }
                                                            onSelect={() =>
                                                                void (async () => {
                                                                    const accepted =
                                                                        await confirm(
                                                                            {
                                                                                title: t(
                                                                                    "analysis.deleteConfirmTitle",
                                                                                ),
                                                                                description:
                                                                                    t(
                                                                                        "analysis.deleteConfirm",
                                                                                        {
                                                                                            name: saved.name,
                                                                                        },
                                                                                    ),
                                                                                confirmLabel:
                                                                                    t(
                                                                                        "common.delete",
                                                                                    ),
                                                                                cancelLabel:
                                                                                    t(
                                                                                        "common.cancel",
                                                                                    ),
                                                                                variant:
                                                                                    "destructive",
                                                                            },
                                                                        );
                                                                    if (
                                                                        !accepted
                                                                    )
                                                                        return;
                                                                    await savedOperation(
                                                                        async () => {
                                                                            await apiClient.deleteSavedAnalysis(
                                                                                saved.id,
                                                                            );
                                                                            setSelectedSaved(
                                                                                (
                                                                                    current,
                                                                                ) =>
                                                                                    current?.id ===
                                                                                    saved.id
                                                                                        ? null
                                                                                        : current,
                                                                            );
                                                                            queryClient.invalidateQueries(
                                                                                {
                                                                                    queryKey:
                                                                                        [
                                                                                            "analysis",
                                                                                            "saved",
                                                                                        ],
                                                                                },
                                                                            );
                                                                        },
                                                                    );
                                                                })()
                                                            }
                                                        >
                                                            <Trash2
                                                                aria-hidden="true"
                                                                className="mr-2 h-4 w-4"
                                                            />
                                                            {t(
                                                                "analysis.delete",
                                                            )}
                                                        </DropdownMenuItem>
                                                    </RowMenu>
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    aria-label={saved.name}
                                                    onClick={() =>
                                                        loadSaved(saved)
                                                    }
                                                />
                                            </ListRow>
                                        );
                                    })}
                                </List>
                            )}
                            {savedQuery.data?.length === 0 && (
                                <EmptyState
                                    size="compact"
                                    headingLevel={3}
                                    icon={Save}
                                    title={t("analysis.noneSaved")}
                                />
                            )}
                        </CardContent>
                    </Card>
                </aside>
            </div>
            <ConfirmDialog />
        </PageShell>
    );
}
