import { useEffect, useId, useState, useRef } from "react";
import type {
    AnalysisResult,
    AnalysisValue,
    AnalysisUnit,
} from "@/lib/api/analysis";
import { evaluateAnalysisExtension } from "@/lib/api/analysis";
import type { ScenarioAttachment } from "./analysisInterchange";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { SELECT_NONE, fromSelectValue, toSelectValue } from "@/lib/selectValue";
import { isAnalysisResultComplete } from "./analysisChartModel";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    analysisCatalogLabel,
    formatAnalysisValue,
} from "./analysisPresentation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List } from "@/components/ui/list";
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
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

const fieldLabelClass =
    "block min-w-0 type-callout font-medium [&>input]:mt-1 [&>input]:font-normal";
const hintClass = "max-w-prose type-callout text-label-secondary";
const nestedBoxClass =
    "space-y-3 rounded-card corner-continuous border border-border/60 bg-background/40 p-3";
interface Formula {
    id: string;
    label: string;
    expression: string;
    scope: "row" | "summary";
    unit?: string;
    resultType?: string;
}
interface Assumption {
    id: string;
    label: string;
    defaultValue: AnalysisValue;
    unit?: AnalysisUnit;
}
interface Scenario {
    id: string;
    name: string;
    assumptions: Record<string, AnalysisValue>;
}
export interface AnalysisWorkbenchConfig {
    steps?: Record<string, unknown>[];
    time?: {
        bucket: string;
        dateColumn: string;
        valueColumns: string[];
        groupColumns: string[];
        missing: string;
        rollingWindow: number;
        aggregation?: "sum" | "last" | "average";
    };
    scenarios?: Scenario[];
}
interface Props {
    result: AnalysisResult | null;
    sourceStale?: boolean;
    formulasJson: string;
    onFormulasChange: (json: string) => void;
    assumptionsJson: string;
    onAssumptionsChange: (json: string) => void;
    assumptionValuesJson: string;
    onAssumptionValuesChange: (json: string) => void;
    config: AnalysisWorkbenchConfig;
    onConfigChange: (config: AnalysisWorkbenchConfig) => void;
    attachments: ScenarioAttachment[];
    onResultChange: (result: AnalysisResult) => void;
}
interface ExtensionOutput {
    rows?: Array<Record<string, AnalysisValue>>;
    columns?: Array<{
        id: string;
        type: string;
        label?: string;
        unit?: AnalysisUnit;
    }>;
    summaries?: Record<string, AnalysisValue>;
    errors?: Array<{ message?: string; formulaId?: string; rowIndex?: number }>;
    lineage?: Array<Record<string, unknown>>;
    complete?: boolean;
    window?: AnalysisResult["window"];
    coverage?: AnalysisResult["coverage"];
    transformationCoverage?: AnalysisResult["transformationCoverage"];
    transformationErrors?: AnalysisResult["transformationErrors"];
    preparationLineage?: AnalysisResult["preparationLineage"];
    scenarios?: Array<{
        id: string;
        name: string;
        summaries?: Record<string, AnalysisValue>;
        errors?: Array<{ message?: string }>;
    }>;
    converged?: boolean;
    reason?: string;
    value?: AnalysisValue;
    outcome?: AnalysisValue;
    iterations?: number;
    formulaUnits?: Record<string, AnalysisUnit>;
}
function parse<T>(json: string, fallback: T): T {
    try {
        return JSON.parse(json) as T;
    } catch {
        return fallback;
    }
}
const functions = [
    "IF",
    "COALESCE",
    "ABS",
    "ROUND",
    "YEAR",
    "MONTH",
    "DATEADD",
    "DATEDIFF",
    "SUM",
    "AVERAGE",
    "MIN",
    "MAX",
    "COUNT",
    "COUNTIF",
    "SUMIF",
    "MEDIAN",
    "STDEV",
    "VARIANCE",
    "NPV",
    "PV",
    "FV",
    "PMT",
];
export function AnalysisWorkbenchPanel(props: Props) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const baseId = useId();
    const [fieldSearch, setFieldSearch] = useState("");
    const [scenarioTask, setScenarioTask] = useState("compare");
    const [addingStep, setAddingStep] = useState(false);
    const tr = (key: string) => t(`analysis.ext.workbench.${key}`);
    const formulas = parse<Formula[]>(props.formulasJson, []),
        definitions = parse<Assumption[]>(props.assumptionsJson, []),
        values = parse<Record<string, AnalysisValue>>(
            props.assumptionValuesJson,
            {},
        );
    const assumptions = Object.fromEntries(
        definitions.map((a) => [a.id, values[a.id] ?? a.defaultValue]),
    );
    const columns = props.result?.declaredColumns?.length
        ? props.result.declaredColumns
        : (props.result?.columns ?? []);
    const starterField = columns.find((c) =>
        /^(decimal|integer|number|numeric|float|double)$/.test(c.type),
    );
    const complete = props.result
        ? isAnalysisResultComplete(props.result)
        : false;
    const [output, setOutput] = useState<ExtensionOutput | null>(null),
        [preview, setPreview] = useState<ExtensionOutput | null>(null),
        [error, setError] = useState(""),
        [previewError, setPreviewError] = useState(""),
        [previewBusy, setPreviewBusy] = useState(false),
        [previewAttempt, setPreviewAttempt] = useState(0),
        [busy, setBusy] = useState(false),
        [active, setActive] = useState(0);
    const expressionInput = useRef<HTMLInputElement>(null);
    const focusNewFormula = useRef(false);
    useEffect(() => {
        if (focusNewFormula.current && expressionInput.current) {
            expressionInput.current.focus();
            focusNewFormula.current = false;
        }
    }, [active, props.formulasJson]);
    const [scenarioName, setScenarioName] = useState("");
    const [selectedFunction, setSelectedFunction] = useState("");
    const [outcome, setOutcome] = useState(""),
        [variable, setVariable] = useState(""),
        [variable2, setVariable2] = useState(""),
        [grid, setGrid] = useState("0, 0.05, 0.1"),
        [grid2, setGrid2] = useState("0, 1"),
        [target, setTarget] = useState("0"),
        [lower, setLower] = useState("0"),
        [upper, setUpper] = useState("1");
    const [stepType, setStepType] = useState("convert"),
        [column, setColumn] = useState(""),
        [inputId, setInputId] = useState(""),
        [inputKey, setInputKey] = useState(""),
        [targetType, setTargetType] = useState("decimal"),
        [outputId, setOutputId] = useState("derived"),
        [expression, setExpression] = useState(""),
        [selected, setSelected] = useState<string[]>([]),
        [group, setGroup] = useState<string[]>([]),
        [nameColumn, setNameColumn] = useState(""),
        [valueColumn, setValueColumn] = useState(""),
        [unpivotValueColumn, setUnpivotValueColumn] = useState("value"),
        [aggregate, setAggregate] = useState("sum");
    const time = props.config.time ?? {
        bucket: "month",
        dateColumn: columns.find((c) => c.type === "date")?.id ?? "",
        valueColumns: [],
        groupColumns: [],
        missing: "null",
        rollingWindow: 3,
    };
    const inputSignature = JSON.stringify([
        props.result,
        props.formulasJson,
        props.assumptionsJson,
        props.assumptionValuesJson,
        props.config,
        props.sourceStale,
    ]);
    const latestInputs = useRef(inputSignature);
    latestInputs.current = inputSignature;

    const base = () => ({
        rows: props.result?.rows ?? [],
        columns,
        window: props.result?.window,
        coverage: props.result?.coverage,
        complete: Boolean(complete),
        inputComplete: Boolean(complete),
        formulas,
        workbench: props.config,
        assumptions,
        assumptionUnits: Object.fromEntries(
            definitions.filter((a) => a.unit).map((a) => [a.id, a.unit]),
        ),
    });
    useEffect(() => {
        if (
            !props.result ||
            props.sourceStale ||
            !props.formulasJson ||
            props.formulasJson === "[]"
        ) {
            setPreview(null);
            setPreviewError("");
            setPreviewBusy(false);
            return;
        }
        setPreview(null);
        setPreviewError("");
        setPreviewBusy(true);
        let cancelled = false;
        const timer = setTimeout(() => {
            void evaluateAnalysisExtension({
                operation: "formulas",
                rows: props.result!.rows,
                window: props.result!.window,
                coverage: props.result!.coverage,
                columns: props.result!.declaredColumns?.length
                    ? props.result!.declaredColumns
                    : props.result!.columns,
                complete: Boolean(complete),
                inputComplete: Boolean(complete),
                formulas: parse(props.formulasJson, []),
                workbench: props.config,
                assumptionUnits: Object.fromEntries(
                    parse<Assumption[]>(props.assumptionsJson, [])
                        .filter((a) => a.unit)
                        .map((a) => [a.id, a.unit]),
                ),
                assumptions: Object.fromEntries(
                    parse<Assumption[]>(props.assumptionsJson, []).map((a) => [
                        a.id,
                        parse<Record<string, AnalysisValue>>(
                            props.assumptionValuesJson,
                            {},
                        )[a.id] ?? a.defaultValue,
                    ]),
                ),
            })
                .then((value) => {
                    if (!cancelled) {
                        setPreview(value as ExtensionOutput);
                        setPreviewError("");
                    }
                })
                .catch((cause) => {
                    if (!cancelled)
                        setPreviewError(
                            cause instanceof Error
                                ? cause.message
                                : String(cause),
                        );
                })
                .finally(() => {
                    if (!cancelled) setPreviewBusy(false);
                });
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [
        props.result,
        props.formulasJson,
        props.assumptionsJson,
        props.assumptionValuesJson,
        props.config,
        props.sourceStale,
        previewAttempt,
        complete,
    ]);
    useEffect(() => {
        setOutput(null);
        setError("");
    }, [
        props.result,
        props.sourceStale,
        props.config,
        props.formulasJson,
        props.assumptionsJson,
        props.assumptionValuesJson,
    ]);
    const run = async (
        operation: string,
        fields: Record<string, unknown> = {},
        apply = false,
    ) => {
        if (props.sourceStale) return;
        const startedInputs = inputSignature;
        // Every Apply uses the complete saved-run pipeline so displayed provenance stays exact.
        const appliedOperation = apply ? "formulas" : operation;
        setBusy(true);
        setError("");
        try {
            const response = (await evaluateAnalysisExtension({
                operation: appliedOperation,
                ...base(),
                ...(apply ? {} : fields),
            })) as ExtensionOutput;
            if (latestInputs.current !== startedInputs) return;
            setOutput(response);
            if (
                appliedOperation === "formulas" &&
                response.rows &&
                !response.columns
            ) {
                const ids = new Set(
                    formulas.filter((f) => f.scope === "row").map((f) => f.id),
                );
                response.columns = [
                    ...columns.filter((c) => !ids.has(c.id)),
                    ...formulas
                        .filter((f) => f.scope === "row")
                        .map((f) => ({
                            id: f.id,
                            label: f.label || f.id,
                            type: f.resultType || "decimal",
                            ...(response.formulaUnits?.[f.id]
                                ? { unit: response.formulaUnits[f.id] }
                                : {}),
                        })),
                ];
            }
            if (apply && response.rows && response.columns && props.result) {
                const appliedComplete =
                    complete &&
                    response.complete !== false &&
                    response.coverage?.complete !== false &&
                    response.coverage?.status !== "partial" &&
                    !(response.transformationCoverage ?? []).some(
                        (c) => c.complete === false,
                    ) &&
                    !(response.transformationErrors ?? []).length;
                props.onResultChange({
                    ...props.result,
                    rows: response.rows,
                    columns: response.columns,
                    declaredColumns: response.columns.map((c) => ({
                        ...c,
                        label: c.label ?? c.id,
                        nullable: true,
                    })),
                    complete: appliedComplete,
                    coverage: {
                        ...props.result.coverage,
                        ...response.coverage,
                        complete: appliedComplete,
                        status: appliedComplete ? "complete" : "partial",
                    },
                    transformationCoverage:
                        response.transformationCoverage ??
                        props.result.transformationCoverage,
                    transformationErrors:
                        response.transformationErrors ??
                        props.result.transformationErrors,
                    preparationLineage:
                        response.preparationLineage ??
                        response.lineage ??
                        props.result.preparationLineage,
                    window: response.window ?? {
                        ...props.result.window,
                        returnedRows: response.rows.length,
                    },
                    formulaErrors: response.errors
                        ?.filter((e) => e.formulaId)
                        .map((e) => ({
                            formulaId: e.formulaId!,
                            rowIndex: e.rowIndex,
                            code: "FORMULA_ERROR",
                            message: e.message ?? "",
                        })),
                    formulaSummaries: response.summaries,
                });
            }
        } catch (cause) {
            if (latestInputs.current === startedInputs)
                setError(
                    cause instanceof Error ? cause.message : String(cause),
                );
        } finally {
            setBusy(false);
        }
    };
    const fixedOptions = new Set([
        "money",
        "percentage",
        "quantity",
        "count",
        "duration",
        "ratio",
        "percent",
        "row",
        "summary",
        "convert",
        "lookup",
        "append",
        "calculate",
        "unpivot",
        "pivot",
        "string",
        "decimal",
        "integer",
        "date",
        "boolean",
        "sum",
        "last",
        "count",
        "average",
        "min",
        "max",
        "day",
        "week",
        "month",
        "quarter",
        "year",
        "null",
        "zero",
        "compare",
        "explore",
        "seek",
    ]);
    const fieldLabel = (id: string) => {
        const named =
            formulas.find((f) => f.id === id)?.label ||
            definitions.find((a) => a.id === id)?.label;
        if (named) return named;
        const c = columns.find((c) => c.id === id);
        return c && "label" in c
            ? analysisCatalogLabel(String(c.label), t)
            : id;
    };
    const optionLabel = (v: string) =>
        fixedOptions.has(v) ? tr(`option.${v}`) : fieldLabel(v);
    const select = (
        label: string,
        value: string,
        onChange: (value: string) => void,
        options: string[],
    ) => {
        const id = `${baseId}-${label}`;
        const clearable = !["step", "scenarioTask"].includes(label);
        return (
            <div className="min-w-0 space-y-1">
                <Label htmlFor={id} className="type-callout">
                    {tr(label)}
                </Label>
                <Select
                    value={clearable ? toSelectValue(value) : value}
                    onValueChange={(next) => onChange(fromSelectValue(next))}
                >
                    <SelectTrigger id={id}>
                        <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                        {clearable && (
                            <SelectItem value={SELECT_NONE}>—</SelectItem>
                        )}
                        {options.map((v) => (
                            <SelectItem key={v} value={v}>
                                {optionLabel(v)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        );
    };
    const segmented = (
        label: string,
        value: string,
        onChange: (value: string) => void,
        options: string[],
    ) => {
        return (
            <SegmentedControl
                label={<span className="type-callout">{tr(label)}</span>}
                wrapperClassName="min-w-0 space-y-1"
                value={value}
                onValueChange={onChange}
                className="w-full"
            >
                {options.map((v) => (
                    <SegmentedControlItem key={v} value={v}>
                        {optionLabel(v)}
                    </SegmentedControlItem>
                ))}
            </SegmentedControl>
        );
    };
    const checkFields = (
        label: string,
        ids: string[],
        change: (ids: string[]) => void,
    ) => (
        <fieldset className="min-w-0">
            <legend className="mb-2 type-callout font-medium">
                {tr(label)}
            </legend>
            <div className="flex flex-wrap gap-2">
                {columns.map((c) => (
                    <label
                        key={c.id}
                        className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-chip border border-border/60 bg-card/70 px-3 type-callout [overflow-wrap:anywhere]"
                    >
                        <Checkbox
                            aria-label={fieldLabel(c.id)}
                            checked={ids.includes(c.id)}
                            onCheckedChange={(checked) =>
                                change(
                                    checked === true
                                        ? [...ids, c.id]
                                        : ids.filter((id) => id !== c.id),
                                )
                            }
                        />
                        {fieldLabel(c.id)}
                    </label>
                ))}
            </div>
        </fieldset>
    );
    const matchingFields = columns.filter((c) =>
        `${fieldLabel(c.id)} ${c.id}`
            .toLowerCase()
            .includes(fieldSearch.trim().toLowerCase()),
    );
    const unpivotNameConflict =
        stepType === "unpivot" &&
        Boolean(
            outputId.trim() &&
            unpivotValueColumn.trim() &&
            (outputId.trim() === unpivotValueColumn.trim() ||
                columns.some((c) =>
                    [outputId.trim(), unpivotValueColumn.trim()].includes(c.id),
                )),
        );
    const stepValid =
        stepType === "convert"
            ? Boolean(column && targetType)
            : stepType === "lookup"
              ? Boolean(column && inputId && inputKey && outputId.trim())
              : stepType === "append"
                ? Boolean(inputId)
                : stepType === "calculate"
                  ? Boolean(outputId.trim() && expression.trim())
                  : stepType === "unpivot"
                    ? Boolean(
                          selected.length &&
                          outputId.trim() &&
                          unpivotValueColumn.trim() &&
                          outputId.trim() !== unpivotValueColumn.trim() &&
                          !columns.some((c) =>
                              [
                                  outputId.trim(),
                                  unpivotValueColumn.trim(),
                              ].includes(c.id),
                          ),
                      )
                    : Boolean(nameColumn && valueColumn && aggregate);
    const stepSummary = (step: Record<string, unknown>) => {
        const subject = step.columnId ?? step.nameColumn;
        const fields = Array.isArray(step.columnIds)
            ? step.columnIds.map(String).map(fieldLabel).join(", ")
            : "";
        return [
            tr(`option.${String(step.type)}`),
            subject ? fieldLabel(String(subject)) : fields,
            step.targetType ? tr(`option.${String(step.targetType)}`) : "",
            step.formula
                ? String(
                      (step.formula as { label?: string; id?: string }).label ||
                          (step.formula as { id?: string }).id ||
                          "",
                  )
                : "",
        ]
            .filter(Boolean)
            .join(" · ");
    };
    const displayValue = (
        value: AnalysisValue | undefined,
        type = "decimal",
        id = "",
    ) => formatAnalysisValue(value ?? null, type, id, appSettings.numberFormat);
    const addStep = () => {
        if (!stepValid) return;
        const attachment = props.attachments.find((a) => a.id === inputId);
        const input = attachment
            ? { rows: attachment.rows, columns: attachment.columns }
            : undefined;
        let step: Record<string, unknown>;
        if (stepType === "convert")
            step = {
                type: stepType,
                columnId: column,
                targetType,
                onError: "null",
            };
        else if (stepType === "lookup")
            step = {
                type: stepType,
                input,
                keys: [column],
                inputKeys: [inputKey],
                prefix: outputId,
            };
        else if (stepType === "append") step = { type: stepType, input };
        else if (stepType === "calculate")
            step = {
                type: stepType,
                formula: {
                    id: outputId,
                    label: outputId,
                    scope: "row",
                    expression,
                },
                assumptions,
            };
        else if (stepType === "unpivot")
            step = {
                type: stepType,
                columnIds: selected,
                nameColumn: outputId.trim(),
                valueColumn: unpivotValueColumn.trim(),
            };
        else
            step = {
                type: stepType,
                groupColumns: group,
                nameColumn,
                valueColumn,
                aggregate,
            };
        props.onConfigChange({
            ...props.config,
            steps: [...(props.config.steps ?? []), step],
        });
        setAddingStep(false);
    };
    const valuesList = (text: string) =>
        text
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
    const unitLabel = (unit?: AnalysisUnit) =>
        unit
            ? [
                  unit.kind === "money"
                      ? tr("option.money")
                      : tr(`option.${unit.kind}`),
                  unit.currency ||
                      (unit.currencyColumn
                          ? fieldLabel(unit.currencyColumn)
                          : ""),
                  unit.instrumentId ||
                      (unit.instrumentColumn
                          ? fieldLabel(unit.instrumentColumn)
                          : ""),
              ]
                  .filter(Boolean)
                  .join(" · ")
            : "";
    const report = (value: ExtensionOutput | null) =>
        value && (
            <div className="space-y-2">
                {value.errors?.map((e, i) => (
                    <p className="type-callout text-destructive" key={i}>
                        {e.formulaId}
                        {e.rowIndex !== undefined ? ` (${e.rowIndex + 1})` : ""}
                        : {e.message}
                    </p>
                ))}
                {value.summaries && (
                    <div className="overflow-hidden rounded-card corner-continuous border border-border/60">
                        <Table>
                            <TableBody>
                                {Object.entries(value.summaries).map(
                                    ([id, v]) => (
                                        <TableRow key={id}>
                                            <TableHead
                                                scope="row"
                                                className="h-auto py-2 type-body font-normal text-foreground"
                                            >
                                                {formulas.find(
                                                    (f) => f.id === id,
                                                )?.label || id}
                                            </TableHead>
                                            <TableCell className="py-2 text-right tabular-nums">
                                                {displayValue(v)}
                                            </TableCell>
                                        </TableRow>
                                    ),
                                )}
                            </TableBody>
                        </Table>
                    </div>
                )}
                {value.rows && (
                    <div className="space-y-2">
                        <div className="overflow-hidden rounded-card corner-continuous border border-border/60">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        {(
                                            value.columns ?? [
                                                ...columns,
                                                ...formulas
                                                    .filter(
                                                        (f) =>
                                                            f.scope === "row" &&
                                                            !columns.some(
                                                                (c) =>
                                                                    c.id ===
                                                                    f.id,
                                                            ),
                                                    )
                                                    .map((f) => ({
                                                        id: f.id,
                                                        label: f.label || f.id,
                                                        type:
                                                            f.resultType ||
                                                            "decimal",
                                                    })),
                                            ]
                                        ).map((c) => (
                                            <TableHead
                                                key={c.id}
                                                className="whitespace-nowrap"
                                            >
                                                {fieldLabel(c.id) !== c.id
                                                    ? fieldLabel(c.id)
                                                    : analysisCatalogLabel(
                                                          "label" in c
                                                              ? (c.label ??
                                                                    c.id)
                                                              : c.id,
                                                          t,
                                                      )}
                                                {"unit" in c && c.unit && (
                                                    <span className="block type-caption font-normal text-label-tertiary">
                                                        {unitLabel(
                                                            c.unit as AnalysisUnit,
                                                        )}
                                                    </span>
                                                )}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {value.rows.slice(0, 10).map((r, i) => (
                                        <TableRow key={i}>
                                            {(
                                                value.columns ?? [
                                                    ...columns,
                                                    ...formulas
                                                        .filter(
                                                            (f) =>
                                                                f.scope ===
                                                                    "row" &&
                                                                !columns.some(
                                                                    (c) =>
                                                                        c.id ===
                                                                        f.id,
                                                                ),
                                                        )
                                                        .map((f) => ({
                                                            id: f.id,
                                                            label:
                                                                f.label || f.id,
                                                            type:
                                                                f.resultType ||
                                                                "decimal",
                                                        })),
                                                ]
                                            ).map((c) => (
                                                <TableCell
                                                    key={c.id}
                                                    className="whitespace-nowrap py-2 tabular-nums"
                                                >
                                                    {displayValue(
                                                        r[c.id],
                                                        c.type,
                                                        c.id,
                                                    )}
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                        <p className="type-footnote text-label-secondary">
                            {tr("previewRows")}:{" "}
                            {Math.min(value.rows.length, 10)} /{" "}
                            {value.rows.length}
                        </p>
                    </div>
                )}
                {value.scenarios && (
                    <div className="max-w-full overflow-hidden rounded-card corner-continuous border border-border/60">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{tr("scenario")}</TableHead>
                                    {formulas
                                        .filter((f) => f.scope === "summary")
                                        .map((f) => (
                                            <TableHead
                                                key={f.id}
                                                className="text-right"
                                            >
                                                {f.label || f.id}
                                            </TableHead>
                                        ))}
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {value.scenarios.map((s) => (
                                    <TableRow key={s.id}>
                                        <TableHead
                                            scope="row"
                                            className="h-auto py-2 type-body font-normal text-foreground"
                                        >
                                            {s.name}
                                        </TableHead>
                                        {formulas
                                            .filter(
                                                (f) => f.scope === "summary",
                                            )
                                            .map((f) => (
                                                <TableCell
                                                    key={f.id}
                                                    className="py-2 text-right tabular-nums"
                                                >
                                                    {displayValue(
                                                        s.summaries?.[f.id],
                                                    )}
                                                </TableCell>
                                            ))}
                                        <TableCell className="py-2 type-footnote text-destructive">
                                            {s.errors
                                                ?.map((e) => e.message)
                                                .join("; ")}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
                {value.reason && (
                    <Card>
                        <CardContent variant="compact" className="space-y-2">
                            <p role="status" className="type-headline">
                                {tr(
                                    value.converged
                                        ? "converged"
                                        : "notConverged",
                                )}
                            </p>
                            <dl className="flex flex-wrap gap-6 type-body">
                                <div>
                                    <dt className="type-footnote text-label-secondary">
                                        {tr("value")}
                                    </dt>
                                    <dd className="tabular-nums">
                                        {displayValue(value.value)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="type-footnote text-label-secondary">
                                        {tr("outcome")}
                                    </dt>
                                    <dd className="tabular-nums">
                                        {displayValue(value.outcome)}
                                    </dd>
                                </div>
                            </dl>
                            <Disclosure className="type-footnote text-label-secondary">
                                <DisclosureSummary tone="footnote">
                                    {tr("technicalDetails")}
                                </DisclosureSummary>
                                <p className="pt-1">
                                    {value.reason} · {tr("iterations")}:{" "}
                                    {value.iterations}
                                </p>
                            </Disclosure>
                        </CardContent>
                    </Card>
                )}
                {value.lineage?.map((l, i) => (
                    <p key={i} className="type-footnote text-label-secondary">
                        {String(l.type)}: {String(l.inputRows ?? "")} /{" "}
                        {String(l.outputRows ?? "")} {tr("unmatched")}:{" "}
                        {String(l.unmatchedRows ?? 0)}
                    </p>
                ))}
            </div>
        );
    return (
        <div className="min-w-0 space-y-5">
            {props.sourceStale && (
                <Alert variant="warning">
                    <AlertDescription>{tr("sourceStale")}</AlertDescription>
                </Alert>
            )}
            <section id="analysis-prepare" className="scroll-mt-4 space-y-3">
                <h2 className="type-title-3">
                    {t("analysis.workflow.prepare")}
                </h2>
                <Card asChild>
                    <Disclosure open>
                        <DisclosureSummary
                            padded
                            className="flex items-center gap-2"
                        >
                            {tr("preparation")}
                        </DisclosureSummary>
                        <DisclosureContent className="space-y-3 pt-0">
                            <Button
                                variant="outline"
                                aria-expanded={addingStep}
                                onClick={() => setAddingStep(!addingStep)}
                            >
                                {tr(addingStep ? "cancelStep" : "newStep")}
                            </Button>
                            {addingStep && (
                                <div className={nestedBoxClass}>
                                    {select("step", stepType, setStepType, [
                                        "convert",
                                        "lookup",
                                        "append",
                                        "calculate",
                                        "unpivot",
                                        "pivot",
                                    ])}
                                    <p className={hintClass}>
                                        {tr(`stepHelp.${stepType}`)}
                                    </p>
                                    {["lookup", "append"].includes(stepType) &&
                                        !props.attachments.length && (
                                            <p
                                                role="status"
                                                className={hintClass}
                                            >
                                                {tr("attachmentRequired")}
                                            </p>
                                        )}
                                    {["convert", "lookup"].includes(stepType) &&
                                        select(
                                            "column",
                                            column,
                                            setColumn,
                                            columns.map((c) => c.id),
                                        )}
                                    {stepType === "convert" &&
                                        segmented(
                                            "targetType",
                                            targetType,
                                            setTargetType,
                                            [
                                                "string",
                                                "decimal",
                                                "integer",
                                                "date",
                                                "boolean",
                                            ],
                                        )}
                                    {["lookup", "append"].includes(stepType) &&
                                        select(
                                            "attachment",
                                            inputId,
                                            setInputId,
                                            props.attachments.map((a) => a.id),
                                        )}
                                    {stepType === "lookup" &&
                                        select(
                                            "inputKey",
                                            inputKey,
                                            setInputKey,
                                            props.attachments
                                                .find((a) => a.id === inputId)
                                                ?.columns.map((c) => c.id) ??
                                                [],
                                        )}
                                    {[
                                        "calculate",
                                        "lookup",
                                        "unpivot",
                                    ].includes(stepType) && (
                                        <label className={fieldLabelClass}>
                                            {tr("outputId")}
                                            <Input
                                                value={outputId}
                                                onChange={(e) =>
                                                    setOutputId(e.target.value)
                                                }
                                            />
                                        </label>
                                    )}
                                    {stepType === "calculate" && (
                                        <label className={fieldLabelClass}>
                                            {tr("expression")}
                                            <Input
                                                value={expression}
                                                onChange={(e) =>
                                                    setExpression(
                                                        e.target.value,
                                                    )
                                                }
                                            />
                                        </label>
                                    )}
                                    {stepType === "unpivot" &&
                                        checkFields(
                                            "values",
                                            selected,
                                            setSelected,
                                        )}
                                    {stepType === "pivot" && (
                                        <>
                                            {checkFields(
                                                "groups",
                                                group,
                                                setGroup,
                                            )}
                                            {select(
                                                "nameColumn",
                                                nameColumn,
                                                setNameColumn,
                                                columns.map((c) => c.id),
                                            )}
                                            {select(
                                                "aggregate",
                                                aggregate,
                                                setAggregate,
                                                [
                                                    "sum",
                                                    "last",
                                                    "count",
                                                    "average",
                                                    "min",
                                                    "max",
                                                ],
                                            )}
                                        </>
                                    )}
                                    {stepType === "unpivot" && (
                                        <label className={fieldLabelClass}>
                                            {tr("valueColumn")}
                                            <Input
                                                value={unpivotValueColumn}
                                                onChange={(e) =>
                                                    setUnpivotValueColumn(
                                                        e.target.value,
                                                    )
                                                }
                                            />
                                        </label>
                                    )}
                                    {stepType === "pivot" &&
                                        select(
                                            "valueColumn",
                                            valueColumn,
                                            setValueColumn,
                                            columns.map((c) => c.id),
                                        )}
                                    {unpivotNameConflict && (
                                        <p
                                            role="status"
                                            className="type-callout text-destructive"
                                        >
                                            {tr("outputNamesConflict")}
                                        </p>
                                    )}
                                    <Button
                                        variant="outline"
                                        disabled={!stepValid}
                                        onClick={addStep}
                                    >
                                        {tr("addStep")}
                                    </Button>
                                </div>
                            )}
                            {!!props.config.steps?.length && (
                                <List>
                                    {props.config.steps?.map((s, i) => (
                                        <li
                                            key={i}
                                            className="flex min-h-11 items-center justify-between gap-2 px-4 py-2 type-body"
                                        >
                                            <span className="min-w-0 flex-1 break-words">
                                                {i + 1}. {stepSummary(s)}
                                            </span>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    props.onConfigChange({
                                                        ...props.config,
                                                        steps: props.config.steps?.filter(
                                                            (_, n) => n !== i,
                                                        ),
                                                    })
                                                }
                                            >
                                                {tr("remove")}
                                            </Button>
                                        </li>
                                    ))}
                                </List>
                            )}
                            {!!props.config.steps?.length && (
                                <Button
                                    disabled={
                                        busy ||
                                        props.sourceStale ||
                                        !props.result ||
                                        !props.config.steps?.length
                                    }
                                    onClick={() =>
                                        void run(
                                            "prepare",
                                            { steps: props.config.steps },
                                            true,
                                        )
                                    }
                                >
                                    {tr("applySteps")}
                                </Button>
                            )}
                        </DisclosureContent>
                    </Disclosure>
                </Card>
                <Card asChild>
                    <Disclosure>
                        <DisclosureSummary
                            padded
                            className="flex items-center gap-2"
                        >
                            {tr("time")}
                        </DisclosureSummary>
                        <DisclosureContent className="space-y-3 pt-0">
                            {select(
                                "dateColumn",
                                time.dateColumn,
                                (v) =>
                                    props.onConfigChange({
                                        ...props.config,
                                        time: { ...time, dateColumn: v },
                                    }),
                                columns.map((c) => c.id),
                            )}
                            {segmented(
                                "bucket",
                                time.bucket,
                                (v) =>
                                    props.onConfigChange({
                                        ...props.config,
                                        time: { ...time, bucket: v },
                                    }),
                                ["day", "week", "month", "quarter", "year"],
                            )}
                            {segmented(
                                "aggregate",
                                time.aggregation ?? "sum",
                                (v) =>
                                    props.onConfigChange({
                                        ...props.config,
                                        time: {
                                            ...time,
                                            aggregation: v as
                                                "sum" | "last" | "average",
                                        },
                                    }),
                                ["sum", "last", "average"],
                            )}
                            {checkFields("values", time.valueColumns, (v) =>
                                props.onConfigChange({
                                    ...props.config,
                                    time: { ...time, valueColumns: v },
                                }),
                            )}
                            {checkFields("groups", time.groupColumns, (v) =>
                                props.onConfigChange({
                                    ...props.config,
                                    time: { ...time, groupColumns: v },
                                }),
                            )}
                            {segmented(
                                "missing",
                                time.missing,
                                (v) =>
                                    props.onConfigChange({
                                        ...props.config,
                                        time: { ...time, missing: v },
                                    }),
                                ["null", "zero"],
                            )}
                            <label className={fieldLabelClass}>
                                {tr("rollingWindow")}
                                <Input
                                    type="number"
                                    min="1"
                                    max="366"
                                    value={time.rollingWindow}
                                    onChange={(e) =>
                                        props.onConfigChange({
                                            ...props.config,
                                            time: {
                                                ...time,
                                                rollingWindow: Number(
                                                    e.target.value,
                                                ),
                                            },
                                        })
                                    }
                                />
                            </label>
                            <Button
                                disabled={
                                    busy ||
                                    props.sourceStale ||
                                    !complete ||
                                    !time.dateColumn ||
                                    !time.valueColumns.length
                                }
                                onClick={() => void run("time", time, true)}
                            >
                                {tr("compareTime")}
                            </Button>
                        </DisclosureContent>
                    </Disclosure>
                </Card>
            </section>
            <section id="analysis-calculate" className="scroll-mt-4 space-y-3">
                <h2 className="type-title-3">
                    {t("analysis.workflow.calculate")}
                </h2>
                {!complete && (
                    <p role="status" className={hintClass}>
                        {tr("complete")}
                    </p>
                )}
                {error && (
                    <Alert variant="destructive">
                        <AlertDescription className="break-words">
                            {error}
                        </AlertDescription>
                    </Alert>
                )}
                <Card asChild>
                    <Disclosure open>
                        <DisclosureSummary
                            padded
                            className="flex items-center gap-2"
                        >
                            {tr("formulas")}
                        </DisclosureSummary>
                        <DisclosureContent className="space-y-3 pt-0">
                            {formulas.map((f, i) => (
                                <div key={i} className={nestedBoxClass}>
                                    <Button
                                        variant="ghost"
                                        className="h-auto min-h-9 w-full justify-between gap-3 whitespace-normal text-left"
                                        aria-expanded={active === i}
                                        onClick={() => {
                                            setActive(active === i ? -1 : i);
                                            setFieldSearch("");
                                        }}
                                    >
                                        <span className="min-w-0 break-words">
                                            {f.label || f.id || tr("formula")}
                                        </span>
                                        <span
                                            aria-hidden="true"
                                            className="shrink-0 type-footnote text-label-secondary"
                                        >
                                            {tr(`option.${f.scope}`)}
                                        </span>
                                    </Button>
                                    {active === i && (
                                        <div className="space-y-3">
                                            <div className="grid gap-3 sm:grid-cols-2">
                                                {(["label"] as const).map(
                                                    (k) => (
                                                        <label
                                                            key={k}
                                                            className={
                                                                fieldLabelClass
                                                            }
                                                        >
                                                            {tr(k)}
                                                            <Input
                                                                value={f[k]}
                                                                onFocus={() =>
                                                                    setActive(i)
                                                                }
                                                                onChange={(e) =>
                                                                    props.onFormulasChange(
                                                                        JSON.stringify(
                                                                            formulas.map(
                                                                                (
                                                                                    v,
                                                                                    n,
                                                                                ) =>
                                                                                    n ===
                                                                                    i
                                                                                        ? {
                                                                                              ...v,
                                                                                              [k]: e
                                                                                                  .target
                                                                                                  .value,
                                                                                          }
                                                                                        : v,
                                                                            ),
                                                                        ),
                                                                    )
                                                                }
                                                            />
                                                        </label>
                                                    ),
                                                )}
                                                {segmented(
                                                    "scope",
                                                    f.scope,
                                                    (v) =>
                                                        props.onFormulasChange(
                                                            JSON.stringify(
                                                                formulas.map(
                                                                    (row, n) =>
                                                                        n === i
                                                                            ? {
                                                                                  ...row,
                                                                                  scope: v,
                                                                              }
                                                                            : row,
                                                                ),
                                                            ),
                                                        ),
                                                    ["row", "summary"],
                                                )}
                                                <label
                                                    className={`${fieldLabelClass} sm:col-span-2`}
                                                >
                                                    {tr("expression")}
                                                    <Input
                                                        ref={expressionInput}
                                                        list="analysis-expression-hints"
                                                        value={f.expression}
                                                        onChange={(e) =>
                                                            props.onFormulasChange(
                                                                JSON.stringify(
                                                                    formulas.map(
                                                                        (
                                                                            v,
                                                                            n,
                                                                        ) =>
                                                                            n ===
                                                                            i
                                                                                ? {
                                                                                      ...v,
                                                                                      expression:
                                                                                          e
                                                                                              .target
                                                                                              .value,
                                                                                  }
                                                                                : v,
                                                                    ),
                                                                ),
                                                            )
                                                        }
                                                    />
                                                </label>
                                            </div>
                                            <p className={hintClass}>
                                                {tr(`scopeHelp.${f.scope}`)}
                                            </p>
                                            {!f.expression.trim() &&
                                                f.scope === "row" &&
                                                starterField && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => {
                                                            props.onFormulasChange(
                                                                JSON.stringify(
                                                                    formulas.map(
                                                                        (
                                                                            v,
                                                                            n,
                                                                        ) =>
                                                                            n ===
                                                                            i
                                                                                ? {
                                                                                      ...v,
                                                                                      expression: `row.${starterField.id}`,
                                                                                  }
                                                                                : v,
                                                                    ),
                                                                ),
                                                            );
                                                            expressionInput.current?.focus();
                                                        }}
                                                    >
                                                        {tr("startWithField")} ·{" "}
                                                        {fieldLabel(
                                                            starterField.id,
                                                        )}
                                                    </Button>
                                                )}
                                            <Disclosure className="type-callout">
                                                <DisclosureSummary tone="subtle">
                                                    {tr("technicalDetails")}
                                                </DisclosureSummary>
                                                <label
                                                    className={`${fieldLabelClass} mt-2`}
                                                >
                                                    {tr("id")}
                                                    <Input
                                                        value={f.id}
                                                        onChange={(e) =>
                                                            props.onFormulasChange(
                                                                JSON.stringify(
                                                                    formulas.map(
                                                                        (
                                                                            v,
                                                                            n,
                                                                        ) =>
                                                                            n ===
                                                                            i
                                                                                ? {
                                                                                      ...v,
                                                                                      id: e
                                                                                          .target
                                                                                          .value,
                                                                                  }
                                                                                : v,
                                                                    ),
                                                                ),
                                                            )
                                                        }
                                                    />
                                                </label>
                                            </Disclosure>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    props.onFormulasChange(
                                                        JSON.stringify(
                                                            formulas.filter(
                                                                (_, n) =>
                                                                    n !== i,
                                                            ),
                                                        ),
                                                    )
                                                }
                                            >
                                                {tr("remove")}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ))}
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    focusNewFormula.current = true;
                                    setActive(formulas.length);
                                    props.onFormulasChange(
                                        JSON.stringify([
                                            ...formulas,
                                            {
                                                id: `formula_${formulas.length + 1}`,
                                                label: "",
                                                expression: "",
                                                scope: "row",
                                            },
                                        ]),
                                    );
                                }}
                            >
                                {tr("addFormula")}
                            </Button>
                            <datalist id="analysis-expression-hints">
                                {[
                                    ...columns.map((c) => `row.${c.id}`),
                                    ...definitions.map(
                                        (a) => `assumption.${a.id}`,
                                    ),
                                    ...functions.map((f) => `${f}(`),
                                ].map((v) => (
                                    <option key={v} value={v} />
                                ))}
                            </datalist>
                            {formulas[active] && (
                                <Disclosure>
                                    <DisclosureSummary tone="subtle">
                                        {tr("insertField")}
                                    </DisclosureSummary>
                                    <Input
                                        className="my-2"
                                        aria-label={tr("searchFields")}
                                        placeholder={tr("searchFields")}
                                        value={fieldSearch}
                                        onChange={(e) =>
                                            setFieldSearch(e.target.value)
                                        }
                                    />
                                    {!matchingFields.length && (
                                        <p role="status" className={hintClass}>
                                            {tr(
                                                columns.length
                                                    ? "noMatchingFields"
                                                    : "fieldsNeedResult",
                                            )}
                                        </p>
                                    )}
                                    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                                        {matchingFields.map((c) => (
                                            <Button
                                                key={c.id}
                                                size="sm"
                                                variant="outline"
                                                className="h-auto min-h-9 justify-start whitespace-normal break-words text-left"
                                                disabled={!formulas[active]}
                                                onClick={() => {
                                                    expressionInput.current?.focus();
                                                    props.onFormulasChange(
                                                        JSON.stringify(
                                                            formulas.map(
                                                                (f, i) =>
                                                                    i === active
                                                                        ? {
                                                                              ...f,
                                                                              expression:
                                                                                  `${f.expression} row.${c.id}`.trim(),
                                                                          }
                                                                        : f,
                                                            ),
                                                        ),
                                                    );
                                                }}
                                            >
                                                <span>{fieldLabel(c.id)}</span>
                                                {fieldLabel(c.id) !== c.id && (
                                                    <code
                                                        aria-hidden="true"
                                                        className="ml-2 min-w-0 break-all type-caption text-label-tertiary"
                                                    >
                                                        {c.id}
                                                    </code>
                                                )}
                                            </Button>
                                        ))}
                                    </div>
                                </Disclosure>
                            )}
                            {formulas[active] && (
                                <Disclosure>
                                    <DisclosureSummary tone="subtle">
                                        {tr("functionsHelp")}
                                    </DisclosureSummary>
                                    <div className="space-y-2 pt-2">
                                        {select(
                                            "function",
                                            "",
                                            (fn) => {
                                                if (!fn) return;
                                                setSelectedFunction(fn);
                                                if (formulas[active])
                                                    props.onFormulasChange(
                                                        JSON.stringify(
                                                            formulas.map(
                                                                (f, i) =>
                                                                    i === active
                                                                        ? {
                                                                              ...f,
                                                                              expression: `${f.expression}${fn}(`,
                                                                          }
                                                                        : f,
                                                            ),
                                                        ),
                                                    );
                                            },
                                            functions,
                                        )}
                                        <p className="type-footnote text-label-secondary">
                                            {tr("help")}
                                        </p>
                                        {selectedFunction && (
                                            <p className="type-footnote text-label-secondary">
                                                {selectedFunction}:{" "}
                                                {tr(
                                                    [
                                                        "MEDIAN",
                                                        "STDEV",
                                                        "VARIANCE",
                                                    ].includes(selectedFunction)
                                                        ? "statisticsHelp"
                                                        : [
                                                                "NPV",
                                                                "PV",
                                                                "FV",
                                                                "PMT",
                                                            ].includes(
                                                                selectedFunction,
                                                            )
                                                          ? "financialHelp"
                                                          : "help",
                                                )}
                                            </p>
                                        )}
                                    </div>
                                </Disclosure>
                            )}
                            <div aria-busy={previewBusy} className="min-w-0">
                                {previewBusy && (
                                    <p role="status" className={hintClass}>
                                        {tr("previewLoading")}
                                    </p>
                                )}
                                {previewError && (
                                    <Alert variant="destructive">
                                        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                                            <p className="break-words">
                                                {tr("previewFailed")}:{" "}
                                                {previewError}
                                            </p>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    setPreviewAttempt(
                                                        (n) => n + 1,
                                                    )
                                                }
                                            >
                                                {tr("retryPreview")}
                                            </Button>
                                        </AlertDescription>
                                    </Alert>
                                )}
                                {report(preview)}
                            </div>
                            {!!formulas.length && (
                                <Button
                                    disabled={
                                        busy ||
                                        props.sourceStale ||
                                        !props.result ||
                                        !formulas.length
                                    }
                                    onClick={() =>
                                        void run("formulas", {}, true)
                                    }
                                >
                                    {tr("applyFormulas")}
                                </Button>
                            )}
                        </DisclosureContent>
                    </Disclosure>
                </Card>
                <Card asChild>
                    <Disclosure>
                        <DisclosureSummary
                            padded
                            className="flex items-center gap-2"
                        >
                            {tr("assumptions")}
                        </DisclosureSummary>
                        <DisclosureContent className="space-y-3 pt-0">
                            <p className={hintClass}>{tr("assumptionsHelp")}</p>
                            {definitions.map((a, i) => (
                                <div
                                    key={i}
                                    className={`${nestedBoxClass} grid items-end sm:grid-cols-2 xl:grid-cols-4`}
                                >
                                    <label className={fieldLabelClass}>
                                        {tr("id")}
                                        <Input
                                            value={a.id}
                                            onChange={(e) =>
                                                props.onAssumptionsChange(
                                                    JSON.stringify(
                                                        definitions.map(
                                                            (v, n) =>
                                                                n === i
                                                                    ? {
                                                                          ...v,
                                                                          id: e
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : v,
                                                        ),
                                                    ),
                                                )
                                            }
                                        />
                                    </label>
                                    <label className={fieldLabelClass}>
                                        {tr("label")}
                                        <Input
                                            value={a.label}
                                            onChange={(e) =>
                                                props.onAssumptionsChange(
                                                    JSON.stringify(
                                                        definitions.map(
                                                            (v, n) =>
                                                                n === i
                                                                    ? {
                                                                          ...v,
                                                                          label: e
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : v,
                                                        ),
                                                    ),
                                                )
                                            }
                                        />
                                    </label>
                                    <label className={fieldLabelClass}>
                                        {tr("value")}
                                        <Input
                                            type="number"
                                            step="any"
                                            value={String(
                                                values[a.id] ??
                                                    a.defaultValue ??
                                                    "",
                                            )}
                                            onChange={(e) => {
                                                props.onAssumptionValuesChange(
                                                    JSON.stringify({
                                                        ...values,
                                                        [a.id]: e.target.value,
                                                    }),
                                                );
                                                props.onAssumptionsChange(
                                                    JSON.stringify(
                                                        definitions.map(
                                                            (v, n) =>
                                                                n === i
                                                                    ? {
                                                                          ...v,
                                                                          defaultValue:
                                                                              e
                                                                                  .target
                                                                                  .value,
                                                                      }
                                                                    : v,
                                                        ),
                                                    ),
                                                );
                                            }}
                                        />
                                    </label>
                                    {select(
                                        "unitKind",
                                        a.unit?.kind ?? "",
                                        (kind) =>
                                            props.onAssumptionsChange(
                                                JSON.stringify(
                                                    definitions.map((v, n) =>
                                                        n === i
                                                            ? {
                                                                  ...v,
                                                                  unit: kind
                                                                      ? {
                                                                            kind,
                                                                            ...(kind ===
                                                                            "money"
                                                                                ? {
                                                                                      currency:
                                                                                          a
                                                                                              .unit
                                                                                              ?.currency ??
                                                                                          "EUR",
                                                                                  }
                                                                                : kind ===
                                                                                    "percentage"
                                                                                  ? {
                                                                                        percentageBasis:
                                                                                            a
                                                                                                .unit
                                                                                                ?.percentageBasis ??
                                                                                            "ratio",
                                                                                    }
                                                                                  : {}),
                                                                        }
                                                                      : undefined,
                                                              }
                                                            : v,
                                                    ),
                                                ),
                                            ),
                                        [
                                            "money",
                                            "percentage",
                                            "quantity",
                                            "count",
                                            "duration",
                                        ],
                                    )}
                                    {a.unit?.kind === "money" && (
                                        <label className={fieldLabelClass}>
                                            {tr("currency")}
                                            <Input
                                                maxLength={3}
                                                value={a.unit.currency ?? ""}
                                                onChange={(e) =>
                                                    props.onAssumptionsChange(
                                                        JSON.stringify(
                                                            definitions.map(
                                                                (v, n) =>
                                                                    n === i
                                                                        ? {
                                                                              ...v,
                                                                              unit: {
                                                                                  ...a.unit,
                                                                                  currency:
                                                                                      e.target.value.toUpperCase(),
                                                                              },
                                                                          }
                                                                        : v,
                                                            ),
                                                        ),
                                                    )
                                                }
                                            />
                                        </label>
                                    )}
                                    {a.unit?.kind === "percentage" &&
                                        segmented(
                                            "percentageBasis",
                                            a.unit.percentageBasis ?? "ratio",
                                            (basis) =>
                                                props.onAssumptionsChange(
                                                    JSON.stringify(
                                                        definitions.map(
                                                            (v, n) =>
                                                                n === i
                                                                    ? {
                                                                          ...v,
                                                                          unit: {
                                                                              ...a.unit,
                                                                              percentageBasis:
                                                                                  basis,
                                                                          },
                                                                      }
                                                                    : v,
                                                        ),
                                                    ),
                                                ),
                                            ["ratio", "percent"],
                                        )}
                                    <Button
                                        variant="ghost"
                                        className="justify-self-start"
                                        onClick={() =>
                                            props.onAssumptionsChange(
                                                JSON.stringify(
                                                    definitions.filter(
                                                        (_, n) => n !== i,
                                                    ),
                                                ),
                                            )
                                        }
                                    >
                                        {tr("remove")}
                                    </Button>
                                </div>
                            ))}
                            <Button
                                variant="outline"
                                onClick={() =>
                                    props.onAssumptionsChange(
                                        JSON.stringify([
                                            ...definitions,
                                            {
                                                id: `input_${definitions.length + 1}`,
                                                label: "",
                                                defaultValue: "0",
                                            },
                                        ]),
                                    )
                                }
                            >
                                {tr("addAssumption")}
                            </Button>
                        </DisclosureContent>
                    </Disclosure>
                </Card>
                <Card asChild>
                    <Disclosure>
                        <DisclosureSummary
                            padded
                            className="flex items-center gap-2"
                        >
                            {tr("scenarios")}
                        </DisclosureSummary>
                        <DisclosureContent className="space-y-3 pt-0">
                            {(!definitions.length ||
                                !formulas.some(
                                    (f) => f.scope === "summary",
                                )) && (
                                <p role="status" className={hintClass}>
                                    {tr("scenarioPrerequisites")}
                                </p>
                            )}
                            {segmented(
                                "scenarioTask",
                                scenarioTask,
                                setScenarioTask,
                                ["compare", "explore", "seek"],
                            )}
                            <p className={hintClass}>
                                {tr(`scenarioHelp.${scenarioTask}`)}
                            </p>
                            {scenarioTask === "compare" && (
                                <div className="space-y-3">
                                    <label className={fieldLabelClass}>
                                        {tr("name")}
                                        <Input
                                            value={scenarioName}
                                            onChange={(e) =>
                                                setScenarioName(e.target.value)
                                            }
                                        />
                                    </label>
                                    <Button
                                        variant="outline"
                                        disabled={
                                            !scenarioName.trim() ||
                                            !definitions.length
                                        }
                                        onClick={() => {
                                            props.onConfigChange({
                                                ...props.config,
                                                scenarios: [
                                                    ...(props.config
                                                        .scenarios ?? []),
                                                    {
                                                        id: `scenario_${Date.now()}`,
                                                        name: scenarioName.trim(),
                                                        assumptions: {
                                                            ...assumptions,
                                                        },
                                                    },
                                                ],
                                            });
                                            setScenarioName("");
                                        }}
                                    >
                                        {tr("copyScenario")}
                                    </Button>
                                    {props.config.scenarios?.map((s, i) => (
                                        <fieldset
                                            key={s.id}
                                            className={nestedBoxClass}
                                        >
                                            <legend className="px-1 type-headline">
                                                {s.name}
                                            </legend>
                                            {definitions.map((a) => (
                                                <label
                                                    key={a.id}
                                                    className={fieldLabelClass}
                                                >
                                                    {a.label || a.id}
                                                    <Input
                                                        type="number"
                                                        step="any"
                                                        value={String(
                                                            s.assumptions[
                                                                a.id
                                                            ] ??
                                                                a.defaultValue ??
                                                                "",
                                                        )}
                                                        onChange={(e) =>
                                                            props.onConfigChange(
                                                                {
                                                                    ...props.config,
                                                                    scenarios:
                                                                        props.config.scenarios?.map(
                                                                            (
                                                                                v,
                                                                                n,
                                                                            ) =>
                                                                                n ===
                                                                                i
                                                                                    ? {
                                                                                          ...v,
                                                                                          assumptions:
                                                                                              {
                                                                                                  ...v.assumptions,
                                                                                                  [a.id]:
                                                                                                      e
                                                                                                          .target
                                                                                                          .value,
                                                                                              },
                                                                                      }
                                                                                    : v,
                                                                        ),
                                                                },
                                                            )
                                                        }
                                                    />
                                                </label>
                                            ))}
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                    props.onConfigChange({
                                                        ...props.config,
                                                        scenarios:
                                                            props.config.scenarios?.filter(
                                                                (_, n) =>
                                                                    n !== i,
                                                            ),
                                                    })
                                                }
                                            >
                                                {tr("remove")}
                                            </Button>
                                        </fieldset>
                                    ))}
                                    <Button
                                        disabled={
                                            busy ||
                                            props.sourceStale ||
                                            !complete ||
                                            !props.config.scenarios?.length ||
                                            !definitions.length ||
                                            !formulas.some(
                                                (f) => f.scope === "summary",
                                            )
                                        }
                                        onClick={() =>
                                            void run("scenarios", {
                                                scenarios:
                                                    props.config.scenarios,
                                            })
                                        }
                                    >
                                        {tr("compare")}
                                    </Button>
                                </div>
                            )}
                            {scenarioTask !== "compare" && (
                                <div className="space-y-3">
                                    {select(
                                        "outcome",
                                        outcome,
                                        setOutcome,
                                        formulas
                                            .filter(
                                                (f) => f.scope === "summary",
                                            )
                                            .map((f) => f.id),
                                    )}
                                    {select(
                                        "variable",
                                        variable,
                                        setVariable,
                                        definitions.map((a) => a.id),
                                    )}
                                    {scenarioTask === "explore" && (
                                        <>
                                            <label className={fieldLabelClass}>
                                                {tr("grid")}
                                                <Input
                                                    value={grid}
                                                    onChange={(e) =>
                                                        setGrid(e.target.value)
                                                    }
                                                />
                                            </label>
                                            {select(
                                                "variable2",
                                                variable2,
                                                setVariable2,
                                                definitions.map((a) => a.id),
                                            )}
                                            {variable2 && (
                                                <label
                                                    className={fieldLabelClass}
                                                >
                                                    {tr("grid")}
                                                    <Input
                                                        value={grid2}
                                                        onChange={(e) =>
                                                            setGrid2(
                                                                e.target.value,
                                                            )
                                                        }
                                                    />
                                                </label>
                                            )}
                                            <Button
                                                disabled={
                                                    busy ||
                                                    props.sourceStale ||
                                                    !complete ||
                                                    !formulas.some(
                                                        (f) =>
                                                            f.scope ===
                                                                "summary" &&
                                                            f.id === outcome,
                                                    ) ||
                                                    !definitions.some(
                                                        (a) =>
                                                            a.id === variable,
                                                    )
                                                }
                                                onClick={() =>
                                                    void run("sensitivity", {
                                                        outcomeId: outcome,
                                                        variables: [
                                                            {
                                                                id: variable,
                                                                values: valuesList(
                                                                    grid,
                                                                ),
                                                            },
                                                            ...(variable2
                                                                ? [
                                                                      {
                                                                          id: variable2,
                                                                          values: valuesList(
                                                                              grid2,
                                                                          ),
                                                                      },
                                                                  ]
                                                                : []),
                                                        ],
                                                    })
                                                }
                                            >
                                                {tr("sensitivity")}
                                            </Button>
                                        </>
                                    )}
                                    {scenarioTask === "seek" && (
                                        <>
                                            {(
                                                [
                                                    [
                                                        "target",
                                                        target,
                                                        setTarget,
                                                    ],
                                                    ["lower", lower, setLower],
                                                    ["upper", upper, setUpper],
                                                ] as const
                                            ).map(([id, v, set]) => (
                                                <label
                                                    key={id}
                                                    className={fieldLabelClass}
                                                >
                                                    {tr(id)}
                                                    <Input
                                                        type="number"
                                                        step="any"
                                                        value={v}
                                                        onChange={(e) =>
                                                            set(e.target.value)
                                                        }
                                                    />
                                                </label>
                                            ))}
                                            <Button
                                                disabled={
                                                    busy ||
                                                    props.sourceStale ||
                                                    !complete ||
                                                    !formulas.some(
                                                        (f) =>
                                                            f.scope ===
                                                                "summary" &&
                                                            f.id === outcome,
                                                    ) ||
                                                    !definitions.some(
                                                        (a) =>
                                                            a.id === variable,
                                                    )
                                                }
                                                onClick={() =>
                                                    void run("goal", {
                                                        outcomeId: outcome,
                                                        variableId: variable,
                                                        target,
                                                        lower,
                                                        upper,
                                                    })
                                                }
                                            >
                                                {tr("goal")}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            )}
                        </DisclosureContent>
                    </Disclosure>
                </Card>
            </section>
            {busy && (
                <p role="status" className={hintClass}>
                    {tr("applying")}
                </p>
            )}
            {report(output)}
        </div>
    );
}
