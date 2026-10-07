import { Input } from "@/components/ui/input";
import { useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Plus, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { List } from "@/components/ui/list";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    executeAnalysisPivot,
    type AnalysisDataset,
    type AnalysisPivotConfig,
    type AnalysisPivotResult,
    type AnalysisValue,
    type VisualAnalysisPlan,
} from "@/lib/api/analysis";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatAnalysisValue } from "./analysisPresentation";

export function AnalysisPivotPanel({
    plan,
    dataset,
    config,
    onChange,
    onDrill,
}: {
    plan: VisualAnalysisPlan;
    dataset: AnalysisDataset;
    config: AnalysisPivotConfig;
    onChange: (config: AnalysisPivotConfig) => void;
    onDrill: (groups: string[], row: Record<string, AnalysisValue>) => void;
}) {
    const { t } = useLanguage();
    const filterFieldId = useId();
    const shareId = useId();
    const [addingAxis, setAddingAxis] = useState<string | null>(null);
    const [fieldSearch, setFieldSearch] = useState("");
    const addButtons = useRef<Record<string, HTMLButtonElement | null>>({});
    const closePicker = (axis: string) => {
        setAddingAxis(null);
        setFieldSearch("");
        addButtons.current[axis]?.focus();
    };
    const { appSettings } = useAppSettings();
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [result, setResult] = useState<AnalysisPivotResult | null>(null);
    const [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [share, setShare] = useState(false);
    const [expandedColumns, setExpandedColumns] = useState<Set<string>>(
        new Set(),
    );
    const columnDepth = Math.min(1, config.columns.length);
    const rowDepth = Math.min(1, config.rows.length);
    const [signature, setSignature] = useState("");
    const current = JSON.stringify({ plan, config });
    const currentResult = signature === current ? result : null;
    const choose = (
        axis: "rows" | "columns" | "values",
        id: string,
        checked: boolean,
    ) =>
        onChange({
            ...config,
            [axis]: checked
                ? [...config[axis], id]
                : config[axis].filter((value) => value !== id),
        });
    const level = currentResult?.levels.find(
        (l) =>
            l.rowDepth === Math.min(rowDepth, config.rows.length) &&
            l.columnDepth === Math.min(columnDepth, config.columns.length),
    );
    const columnIds = level ? config.columns.slice(0, level.columnDepth) : [];
    const columnKey = (row: Record<string, unknown>, depth = columnDepth) =>
        JSON.stringify([
            depth,
            ...config.columns.slice(0, depth).map((id) => row[id]),
        ]);
    const compare =
        (ids: string[]) =>
        (a: Record<string, unknown>, b: Record<string, unknown>) => {
            for (const id of ids) {
                const order = String(a[id] ?? "").localeCompare(
                    String(b[id] ?? ""),
                    undefined,
                    { numeric: true },
                );
                if (order) return order;
            }
            return 0;
        };
    const matrixColumns: Array<{
        column: Record<string, unknown>;
        columnLevel: number;
    }> = [];
    const collectColumns = (
        depth: number,
        parent?: Record<string, unknown>,
    ) => {
        const source = currentResult?.levels.find(
            (item) => item.rowDepth === rowDepth && item.columnDepth === depth,
        );
        const ids = config.columns.slice(0, depth);
        const candidates =
            source?.rows.filter(
                (row) =>
                    !parent ||
                    config.columns
                        .slice(0, depth - 1)
                        .every((id) => row[id] === parent[id]),
            ) ?? [];
        const unique = [
            ...new Map(
                candidates.map((row) => [columnKey(row, depth), row]),
            ).values(),
        ].sort(compare(ids));
        for (const column of unique) {
            matrixColumns.push({ column, columnLevel: depth });
            if (
                depth < config.columns.length &&
                expandedColumns.has(current + columnKey(column, depth))
            )
                collectColumns(depth + 1, column);
        }
    };
    if (level) collectColumns(columnDepth);
    const visibleRows: Array<{
        row: Record<string, unknown>;
        depth: number;
    }> = [];
    const groupKey = (row: Record<string, unknown>, depth: number) =>
        JSON.stringify([
            current,
            depth,
            ...(currentResult?.partitions ?? []).map((id) => row[id]),
            ...config.rows.slice(0, depth).map((id) => row[id]),
        ]);
    const collect = (depth: number, parent?: Record<string, unknown>) => {
        const source = currentResult?.levels.find(
            (item) =>
                item.rowDepth === depth &&
                item.columnDepth === level?.columnDepth,
        );
        const ids = [
            ...new Set([
                ...(currentResult?.partitions ?? []),
                ...config.rows.slice(0, depth),
            ]),
        ];
        const parentIds = [
            ...new Set([
                ...(currentResult?.partitions ?? []),
                ...config.rows.slice(0, depth - 1),
            ]),
        ];
        const candidates =
            source?.rows.filter(
                (row) =>
                    !parent || parentIds.every((id) => row[id] === parent[id]),
            ) ?? [];
        const unique = [
            ...new Map(
                candidates.map((row) => [groupKey(row, depth), row]),
            ).values(),
        ].sort(compare(ids));
        for (const row of unique) {
            visibleRows.push({ row, depth });
            if (
                depth < config.rows.length &&
                expanded.has(groupKey(row, depth))
            )
                collect(depth + 1, row);
        }
    };
    if (level) {
        collect(rowDepth);
        if (config.rows.length) collect(0);
    }
    const displayRowIds = [
        ...new Set([...(currentResult?.partitions ?? []), ...config.rows]),
    ];
    const move = (
        axis: "rows" | "columns" | "values",
        index: number,
        direction: number,
    ) => {
        const ids = [...config[axis]];
        [ids[index], ids[index + direction]] = [
            ids[index + direction],
            ids[index],
        ];
        onChange({ ...config, [axis]: ids });
    };
    const displayCell = (
        row: Record<string, unknown> | undefined,
        id: string,
    ) =>
        share
            ? row?.__percentages &&
              typeof row.__percentages === "object" &&
              (row.__percentages as Record<string, unknown>)[id] != null
                ? `${formatAnalysisValue((Number((row.__percentages as Record<string, unknown>)[id]) * 100).toFixed(2), "decimal", id, appSettings.numberFormat)}%`
                : "—"
            : formatAnalysisValue(
                  row?.[id] as AnalysisValue,
                  dataset.measures.find((field) => field.id === id)?.type ??
                      "decimal",
                  id,
                  appSettings.numberFormat,
              );
    return (
        <div className="min-w-0 space-y-4" aria-busy={busy}>
            <div className="grid gap-4 xl:grid-cols-3">
                {(["rows", "columns", "values"] as const).map((axis) => (
                    <fieldset key={axis} className="min-w-0">
                        <legend className="type-headline">
                            {t(`analysis.ext.pivot.${axis}`)}
                        </legend>
                        <p className="mt-1 type-footnote text-label-secondary">
                            {t(`analysis.ext.pivot.${axis}Help`)}
                        </p>
                        <List className="my-2">
                            {config[axis].map((id, index) => {
                                const field =
                                    [
                                        ...dataset.fields,
                                        ...dataset.measures,
                                    ].find((item) => item.id === id)?.label ??
                                    id;
                                return (
                                    <li
                                        key={id}
                                        className="flex min-h-10 items-center gap-0.5 py-1 pl-3 pr-1 type-callout"
                                    >
                                        <span className="min-w-0 flex-1 break-words">
                                            {index + 1}. {field}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="icon-touch-target h-8 w-8 shrink-0"
                                            disabled={index === 0}
                                            aria-label={t(
                                                "analysis.ext.pivot.moveUp",
                                                { field },
                                            )}
                                            onClick={() =>
                                                move(axis, index, -1)
                                            }
                                        >
                                            <ChevronUp className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="icon-touch-target h-8 w-8 shrink-0"
                                            disabled={
                                                index ===
                                                config[axis].length - 1
                                            }
                                            aria-label={t(
                                                "analysis.ext.pivot.moveDown",
                                                { field },
                                            )}
                                            onClick={() => move(axis, index, 1)}
                                        >
                                            <ChevronDown className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="icon-touch-target h-8 w-8 shrink-0"
                                            aria-label={t(
                                                "analysis.ext.pivot.removeField",
                                                { field },
                                            )}
                                            onClick={() =>
                                                choose(axis, id, false)
                                            }
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </li>
                                );
                            })}
                        </List>
                        <Button
                            ref={(node) => {
                                addButtons.current[axis] = node;
                            }}
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={addingAxis === axis}
                            onClick={() => {
                                setAddingAxis(
                                    addingAxis === axis ? null : axis,
                                );
                                setFieldSearch("");
                            }}
                        >
                            {t("analysis.ext.pivot.addField")}
                        </Button>
                        {addingAxis === axis && (
                            <div
                                className="mt-2 space-y-2 rounded-card corner-continuous border border-border/60 bg-card/70 p-2"
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        closePicker(axis);
                                    }
                                }}
                            >
                                <Input
                                    autoFocus
                                    value={fieldSearch}
                                    onChange={(e) =>
                                        setFieldSearch(e.target.value)
                                    }
                                    aria-label={t(
                                        "analysis.ext.pivot.searchFields",
                                    )}
                                    placeholder={t(
                                        "analysis.ext.pivot.searchFields",
                                    )}
                                />
                                <div className="max-h-48 overflow-auto">
                                    {(axis === "values"
                                        ? dataset.measures
                                        : dataset.fields
                                    )
                                        .filter(
                                            (field) =>
                                                !config[axis].includes(
                                                    field.id,
                                                ) &&
                                                field.label
                                                    .toLocaleLowerCase()
                                                    .includes(
                                                        fieldSearch.toLocaleLowerCase(),
                                                    ),
                                        )
                                        .map((field) => (
                                            <Button
                                                key={field.id}
                                                type="button"
                                                variant="ghost"
                                                className="h-auto min-h-9 w-full justify-start whitespace-normal text-left font-normal"
                                                onClick={() => {
                                                    choose(
                                                        axis,
                                                        field.id,
                                                        true,
                                                    );
                                                    closePicker(axis);
                                                }}
                                            >
                                                {field.label}
                                            </Button>
                                        ))}
                                    {!(
                                        axis === "values"
                                            ? dataset.measures
                                            : dataset.fields
                                    ).some(
                                        (field) =>
                                            !config[axis].includes(field.id) &&
                                            field.label
                                                .toLocaleLowerCase()
                                                .includes(
                                                    fieldSearch.toLocaleLowerCase(),
                                                ),
                                    ) && (
                                        <p
                                            role="status"
                                            className="p-2 type-callout text-label-secondary"
                                        >
                                            {t("analysis.ext.pivot.noFields")}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </fieldset>
                ))}
            </div>
            <p className="type-footnote text-label-secondary">
                {t("analysis.ext.pivot.filtersHelp")}
            </p>
            <div className="flex flex-wrap items-end gap-3">
                <div className="grid min-w-0 max-w-full gap-1.5">
                    <Label htmlFor={filterFieldId}>
                        {t("analysis.ext.pivot.filterField")}
                    </Label>
                    <Select
                        value=""
                        onValueChange={(value) =>
                            value &&
                            onChange({
                                ...config,
                                filters: [
                                    ...config.filters,
                                    {
                                        fieldId: value,
                                        operator: "eq",
                                        value: "",
                                    },
                                ],
                            })
                        }
                    >
                        <SelectTrigger
                            id={filterFieldId}
                            className="w-auto min-w-40"
                        >
                            <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                            {dataset.fields.map((f) => (
                                <SelectItem key={f.id} value={f.id}>
                                    {f.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {config.filters.map((filter, i) => (
                    <div key={i} className="grid min-w-0 gap-1.5">
                        <Label htmlFor={`${filterFieldId}-${i}`}>
                            {dataset.fields.find(
                                (field) => field.id === filter.fieldId,
                            )?.label ?? filter.fieldId}
                        </Label>
                        <div className="flex items-center gap-1">
                            <Input
                                id={`${filterFieldId}-${i}`}
                                className="w-40"
                                value={String(filter.value ?? "")}
                                onChange={(e) =>
                                    onChange({
                                        ...config,
                                        filters: config.filters.map(
                                            (f, index) =>
                                                index === i
                                                    ? {
                                                          ...f,
                                                          value:
                                                              dataset.fields.find(
                                                                  (field) =>
                                                                      field.id ===
                                                                      f.fieldId,
                                                              )?.type ===
                                                              "boolean"
                                                                  ? e.target
                                                                        .value ===
                                                                    "true"
                                                                  : e.target
                                                                        .value,
                                                      }
                                                    : f,
                                        ),
                                    })
                                }
                            />
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    onChange({
                                        ...config,
                                        filters: config.filters.filter(
                                            (_, index) => index !== i,
                                        ),
                                    })
                                }
                            >
                                {t("analysis.ext.remove")}
                            </Button>
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-4">
                <Button
                    type="button"
                    disabled={busy || !config.values.length}
                    onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                            const next = await executeAnalysisPivot(
                                plan,
                                config,
                                `pivot-${crypto.randomUUID()}`,
                            );
                            setResult(next);
                            setSignature(current);
                        } catch (cause) {
                            setError(
                                cause instanceof Error
                                    ? cause.message
                                    : String(cause),
                            );
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {t(
                        busy
                            ? "analysis.ext.pivot.running"
                            : "analysis.ext.pivot.run",
                    )}
                </Button>
                <div className="flex items-center gap-2">
                    <Switch
                        id={shareId}
                        checked={share}
                        onCheckedChange={setShare}
                    />
                    <Label htmlFor={shareId} className="font-normal">
                        {t("analysis.ext.pivot.share")}
                    </Label>
                </div>
            </div>
            {error && (
                <Alert variant="destructive">
                    <AlertDescription>
                        <p>{t("analysis.ext.pivot.failed")}</p>
                        <details className="mt-2">
                            <summary className="cursor-pointer rounded-control focus-ring">
                                {t("analysis.ext.pivot.errorDetails")}
                            </summary>
                            <p className="mt-2 break-words">{error}</p>
                        </details>
                    </AlertDescription>
                </Alert>
            )}
            {!busy && !error && !currentResult && (
                <p role="status" className="type-callout text-label-secondary">
                    {t(
                        !config.values.length
                            ? "analysis.ext.pivot.chooseValue"
                            : result
                              ? "analysis.ext.pivot.rerun"
                              : "analysis.ext.pivot.ready",
                    )}
                </p>
            )}
            {currentResult && !visibleRows.length && (
                <Alert role="status">
                    <AlertDescription>
                        {t("analysis.ext.pivot.empty")}
                    </AlertDescription>
                </Alert>
            )}
            {currentResult?.coverage.financialComplete === false && (
                <p role="status" className="type-callout text-warning">
                    {t("analysis.ext.pivot.partial", {
                        missing: currentResult.coverage.unavailableRows ?? 0,
                    })}
                </p>
            )}
            {currentResult && (
                <p className="type-footnote text-label-secondary">
                    {t("analysis.ext.pivot.complete", {
                        rows: currentResult.coverage.rows,
                    })}
                </p>
            )}
            {level && (
                <div className="max-w-full overflow-hidden rounded-card corner-continuous border border-border/60">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {displayRowIds.map((id) => (
                                    <TableHead key={id}>
                                        {dataset.fields.find((f) => f.id === id)
                                            ?.label ?? id}
                                    </TableHead>
                                ))}
                                {matrixColumns.flatMap(
                                    ({ column, columnLevel }) =>
                                        config.values.map((id) => (
                                            <TableHead
                                                key={`${columnKey(column, columnLevel)}:${id}`}
                                                className="text-right"
                                            >
                                                {columnLevel <
                                                    config.columns.length && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-expanded={expandedColumns.has(
                                                            current +
                                                                columnKey(
                                                                    column,
                                                                    columnLevel,
                                                                ),
                                                        )}
                                                        aria-label={t(
                                                            expandedColumns.has(
                                                                current +
                                                                    columnKey(
                                                                        column,
                                                                        columnLevel,
                                                                    ),
                                                            )
                                                                ? "analysis.ext.pivot.collapse"
                                                                : "analysis.ext.pivot.expand",
                                                            {
                                                                field: config.columns
                                                                    .slice(
                                                                        0,
                                                                        columnLevel,
                                                                    )
                                                                    .map(
                                                                        (key) =>
                                                                            String(
                                                                                column[
                                                                                    key
                                                                                ] ??
                                                                                    "—",
                                                                            ),
                                                                    )
                                                                    .join(
                                                                        " / ",
                                                                    ),
                                                            },
                                                        )}
                                                        className="mr-1 h-6 w-6"
                                                        onClick={() =>
                                                            setExpandedColumns(
                                                                (previous) => {
                                                                    const next =
                                                                        new Set(
                                                                            previous,
                                                                        );
                                                                    const key =
                                                                        current +
                                                                        columnKey(
                                                                            column,
                                                                            columnLevel,
                                                                        );
                                                                    if (
                                                                        next.has(
                                                                            key,
                                                                        )
                                                                    )
                                                                        next.delete(
                                                                            key,
                                                                        );
                                                                    else
                                                                        next.add(
                                                                            key,
                                                                        );
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                    >
                                                        {expandedColumns.has(
                                                            current +
                                                                columnKey(
                                                                    column,
                                                                    columnLevel,
                                                                ),
                                                        ) ? (
                                                            <Minus className="h-3.5 w-3.5" />
                                                        ) : (
                                                            <Plus className="h-3.5 w-3.5" />
                                                        )}
                                                    </Button>
                                                )}
                                                {config.columns
                                                    .slice(0, columnLevel)
                                                    .map((key) =>
                                                        String(
                                                            column[key] ?? "—",
                                                        ),
                                                    )
                                                    .join(" / ")}{" "}
                                                ·{" "}
                                                {dataset.measures.find(
                                                    (f) => f.id === id,
                                                )?.label ?? id}
                                            </TableHead>
                                        )),
                                )}
                                {columnIds.length > 0 &&
                                    config.values.map((id) => (
                                        <TableHead
                                            key={`total:${id}`}
                                            className="text-right"
                                        >
                                            {t("analysis.ext.pivot.total")} ·{" "}
                                            {dataset.measures.find(
                                                (f) => f.id === id,
                                            )?.label ?? id}
                                        </TableHead>
                                    ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visibleRows.map(({ row, depth }) => {
                                const ids = [
                                    ...new Set([
                                        ...(currentResult?.partitions ?? []),
                                        ...config.rows.slice(0, depth),
                                    ]),
                                ];
                                const totals = currentResult?.levels.find(
                                    (item) =>
                                        item.rowDepth === depth &&
                                        item.columnDepth === 0,
                                );
                                const matches = (
                                    item: Record<string, unknown>,
                                ) => ids.every((id) => item[id] === row[id]);
                                return (
                                    <TableRow
                                        key={groupKey(row, depth)}
                                        className={
                                            depth < config.rows.length
                                                ? "bg-foreground/[0.03] font-medium"
                                                : ""
                                        }
                                    >
                                        {displayRowIds.map((id) => (
                                            <TableHead
                                                key={id}
                                                className="h-auto py-2 type-body font-normal text-foreground"
                                                scope="row"
                                            >
                                                {id ===
                                                    config.rows[depth - 1] &&
                                                    depth <
                                                        config.rows.length && (
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-expanded={expanded.has(
                                                                groupKey(
                                                                    row,
                                                                    depth,
                                                                ),
                                                            )}
                                                            aria-label={t(
                                                                expanded.has(
                                                                    groupKey(
                                                                        row,
                                                                        depth,
                                                                    ),
                                                                )
                                                                    ? "analysis.ext.pivot.collapse"
                                                                    : "analysis.ext.pivot.expand",
                                                                {
                                                                    field: String(
                                                                        row[
                                                                            id
                                                                        ] ??
                                                                            "—",
                                                                    ),
                                                                },
                                                            )}
                                                            className="mr-1 h-6 w-6"
                                                            onClick={() =>
                                                                setExpanded(
                                                                    (
                                                                        previous,
                                                                    ) => {
                                                                        const next =
                                                                            new Set(
                                                                                previous,
                                                                            );
                                                                        const key =
                                                                            groupKey(
                                                                                row,
                                                                                depth,
                                                                            );
                                                                        if (
                                                                            next.has(
                                                                                key,
                                                                            )
                                                                        )
                                                                            next.delete(
                                                                                key,
                                                                            );
                                                                        else
                                                                            next.add(
                                                                                key,
                                                                            );
                                                                        return next;
                                                                    },
                                                                )
                                                            }
                                                        >
                                                            {expanded.has(
                                                                groupKey(
                                                                    row,
                                                                    depth,
                                                                ),
                                                            ) ? (
                                                                <Minus className="h-3.5 w-3.5" />
                                                            ) : (
                                                                <Plus className="h-3.5 w-3.5" />
                                                            )}
                                                        </Button>
                                                    )}
                                                {depth === 0 &&
                                                id === config.rows[0]
                                                    ? t(
                                                          "analysis.ext.pivot.total",
                                                      )
                                                    : String(row[id] ?? "—")}
                                            </TableHead>
                                        ))}
                                        {matrixColumns.flatMap(
                                            ({ column, columnLevel }) =>
                                                config.values.map((id) => {
                                                    const source =
                                                        currentResult?.levels.find(
                                                            (item) =>
                                                                item.rowDepth ===
                                                                    depth &&
                                                                item.columnDepth ===
                                                                    columnLevel,
                                                        );
                                                    const cell =
                                                        source?.rows.find(
                                                            (item) =>
                                                                matches(item) &&
                                                                columnKey(
                                                                    item,
                                                                    columnLevel,
                                                                ) ===
                                                                    columnKey(
                                                                        column,
                                                                        columnLevel,
                                                                    ),
                                                        );
                                                    return (
                                                        <TableCell
                                                            key={`${columnKey(column, columnLevel)}:${id}`}
                                                            className="py-1.5 text-right tabular-nums"
                                                        >
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 px-1.5 font-normal tabular-nums"
                                                                title={t(
                                                                    "analysis.ext.pivot.drill",
                                                                )}
                                                                disabled={!cell}
                                                                onClick={() =>
                                                                    cell &&
                                                                    onDrill(
                                                                        source!
                                                                            .groups,
                                                                        Object.fromEntries(
                                                                            source!.groups.map(
                                                                                (
                                                                                    key,
                                                                                ) => [
                                                                                    key,
                                                                                    cell[
                                                                                        key
                                                                                    ] as AnalysisValue,
                                                                                ],
                                                                            ),
                                                                        ),
                                                                    )
                                                                }
                                                            >
                                                                {displayCell(
                                                                    cell,
                                                                    id,
                                                                )}
                                                            </Button>
                                                        </TableCell>
                                                    );
                                                }),
                                        )}
                                        {columnIds.length > 0 &&
                                            config.values.map((id) => (
                                                <TableCell
                                                    key={`total:${id}`}
                                                    className="py-1.5 text-right font-medium tabular-nums"
                                                >
                                                    {displayCell(
                                                        totals?.rows.find(
                                                            matches,
                                                        ),
                                                        id,
                                                    )}
                                                </TableCell>
                                            ))}
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}
