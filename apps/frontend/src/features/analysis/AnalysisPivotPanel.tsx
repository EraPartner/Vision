import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useRef, useState } from "react";
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
                        <legend className="font-medium">
                            {t(`analysis.ext.pivot.${axis}`)}
                        </legend>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t(`analysis.ext.pivot.${axis}Help`)}
                        </p>
                        <ol className="my-2 space-y-1">
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
                                        className="flex items-center gap-1 rounded-md bg-muted/30 px-2 py-1 text-sm"
                                    >
                                        <span className="min-w-0 flex-1 break-words">
                                            {index + 1}. {field}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="w-9 shrink-0 px-0"
                                            disabled={index === 0}
                                            aria-label={t(
                                                "analysis.ext.pivot.moveUp",
                                                { field },
                                            )}
                                            onClick={() =>
                                                move(axis, index, -1)
                                            }
                                        >
                                            ↑
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="w-9 shrink-0 px-0"
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
                                            ↓
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="w-9 shrink-0 px-0"
                                            aria-label={t(
                                                "analysis.ext.pivot.removeField",
                                                { field },
                                            )}
                                            onClick={() =>
                                                choose(axis, id, false)
                                            }
                                        >
                                            ×
                                        </Button>
                                    </li>
                                );
                            })}
                        </ol>
                        <Button
                            ref={(node) => {
                                addButtons.current[axis] = node;
                            }}
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
                                className="mt-2 space-y-2 rounded-lg border p-2"
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
                                                variant="ghost"
                                                className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
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
                                            className="p-2 text-sm text-muted-foreground"
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
            <p className="text-xs text-muted-foreground">
                {t("analysis.ext.pivot.filtersHelp")}
            </p>
            <div className="flex flex-wrap gap-3">
                <label className="grid min-w-0 max-w-full gap-2 text-sm">
                    {t("analysis.ext.pivot.filterField")}
                    <select
                        className="h-9 w-full min-w-0 rounded-control border border-input bg-background px-3 focus-ring"
                        value=""
                        onChange={(e) =>
                            e.target.value &&
                            onChange({
                                ...config,
                                filters: [
                                    ...config.filters,
                                    {
                                        fieldId: e.target.value,
                                        operator: "eq",
                                        value: "",
                                    },
                                ],
                            })
                        }
                    >
                        <option value="">—</option>
                        {dataset.fields.map((f) => (
                            <option key={f.id} value={f.id}>
                                {f.label}
                            </option>
                        ))}
                    </select>
                </label>
                {config.filters.map((filter, i) => (
                    <label
                        key={i}
                        className="flex flex-wrap items-center gap-2 text-sm"
                    >
                        {dataset.fields.find(
                            (field) => field.id === filter.fieldId,
                        )?.label ?? filter.fieldId}
                        <Input
                            className="w-40"
                            value={String(filter.value ?? "")}
                            onChange={(e) =>
                                onChange({
                                    ...config,
                                    filters: config.filters.map((f, index) =>
                                        index === i
                                            ? {
                                                  ...f,
                                                  value:
                                                      dataset.fields.find(
                                                          (field) =>
                                                              field.id ===
                                                              f.fieldId,
                                                      )?.type === "boolean"
                                                          ? e.target.value ===
                                                            "true"
                                                          : e.target.value,
                                              }
                                            : f,
                                    ),
                                })
                            }
                        />
                        <Button
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
                    </label>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Button
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
                <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                        checked={share}
                        onCheckedChange={(checked) =>
                            setShare(checked === true)
                        }
                    />
                    {t("analysis.ext.pivot.share")}
                </label>
            </div>
            {error && (
                <div
                    role="alert"
                    className="rounded-lg border border-destructive/30 p-3 text-sm"
                >
                    <p>{t("analysis.ext.pivot.failed")}</p>
                    <details className="mt-2 text-muted-foreground">
                        <summary className="cursor-pointer">
                            {t("analysis.ext.pivot.errorDetails")}
                        </summary>
                        <p className="mt-2 break-words">{error}</p>
                    </details>
                </div>
            )}
            {!busy && !error && !currentResult && (
                <p role="status" className="text-sm text-muted-foreground">
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
                <p
                    role="status"
                    className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground"
                >
                    {t("analysis.ext.pivot.empty")}
                </p>
            )}
            {currentResult?.coverage.financialComplete === false && (
                <p role="status">
                    {t("analysis.ext.pivot.partial", {
                        missing: currentResult.coverage.unavailableRows ?? 0,
                    })}
                </p>
            )}
            {currentResult && (
                <p className="text-xs text-muted-foreground">
                    {t("analysis.ext.pivot.complete", {
                        rows: currentResult.coverage.rows,
                    })}
                </p>
            )}
            {level && (
                <div className="max-w-full overflow-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                {displayRowIds.map((id) => (
                                    <th key={id} className="p-2 text-left">
                                        {dataset.fields.find((f) => f.id === id)
                                            ?.label ?? id}
                                    </th>
                                ))}
                                {matrixColumns.flatMap(
                                    ({ column, columnLevel }) =>
                                        config.values.map((id) => (
                                            <th
                                                key={`${columnKey(column, columnLevel)}:${id}`}
                                                className="p-2 text-right"
                                            >
                                                {columnLevel <
                                                    config.columns.length && (
                                                    <button
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
                                                        className="mr-2 rounded px-1 focus-ring"
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
                                                        )
                                                            ? "−"
                                                            : "+"}
                                                    </button>
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
                                            </th>
                                        )),
                                )}
                                {columnIds.length > 0 &&
                                    config.values.map((id) => (
                                        <th
                                            key={`total:${id}`}
                                            className="p-2 text-right"
                                        >
                                            {t("analysis.ext.pivot.total")} ·{" "}
                                            {dataset.measures.find(
                                                (f) => f.id === id,
                                            )?.label ?? id}
                                        </th>
                                    ))}
                            </tr>
                        </thead>
                        <tbody>
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
                                    <tr
                                        key={groupKey(row, depth)}
                                        className={
                                            depth < config.rows.length
                                                ? "bg-muted/30"
                                                : ""
                                        }
                                    >
                                        {displayRowIds.map((id) => (
                                            <th
                                                key={id}
                                                className="p-2 text-left font-normal"
                                                scope="row"
                                            >
                                                {id ===
                                                    config.rows[depth - 1] &&
                                                    depth <
                                                        config.rows.length && (
                                                        <button
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
                                                            className="mr-2 rounded px-1 focus-ring"
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
                                                            )
                                                                ? "−"
                                                                : "+"}
                                                        </button>
                                                    )}
                                                {depth === 0 &&
                                                id === config.rows[0]
                                                    ? t(
                                                          "analysis.ext.pivot.total",
                                                      )
                                                    : String(row[id] ?? "—")}
                                            </th>
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
                                                        <td
                                                            key={`${columnKey(column, columnLevel)}:${id}`}
                                                            className="p-2 text-right tabular-nums"
                                                        >
                                                            <button
                                                                className="rounded px-1 underline-offset-2 hover:underline focus-ring"
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
                                                            </button>
                                                        </td>
                                                    );
                                                }),
                                        )}
                                        {columnIds.length > 0 &&
                                            config.values.map((id) => (
                                                <td
                                                    key={`total:${id}`}
                                                    className="p-2 text-right font-medium"
                                                >
                                                    {displayCell(
                                                        totals?.rows.find(
                                                            matches,
                                                        ),
                                                        id,
                                                    )}
                                                </td>
                                            ))}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
