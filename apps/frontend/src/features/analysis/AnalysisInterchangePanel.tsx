import {
    analysisResultWorkbook,
    importAnalysisWorkbook,
} from "./analysisWorkbook";
import { useId, useMemo, useState } from "react";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { downloadBlob } from "@/lib/downloadBlob";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { AnalysisResult } from "@/lib/api/analysis";
import {
    analysisResultCsv,
    parseScenarioCsv,
    type AnalysisScenarioModel,
} from "./analysisInterchange";

export function AnalysisInterchangePanel({
    result,
    name,
    timezone,
    workspace,
    definitionId,
    definitionVersion,
    datasetIds,
    sourceReferences,
    scenarioModel,
    onScenarioModelChange,
    assumptions,
    formulas,
}: {
    assumptions?: unknown;
    formulas?: unknown;
    result: AnalysisResult | null;
    name: string;
    timezone: string;
    workspace: string;
    definitionId?: string;
    definitionVersion?: number;
    datasetIds: string[];
    sourceReferences: string[];
    scenarioModel: AnalysisScenarioModel;
    onScenarioModelChange: (value: AnalysisScenarioModel) => void;
}) {
    const { t } = useLanguage();
    const scenarioInputId = useId();
    const workbookInputId = useId();
    const [error, setError] = useState<string | null>(null);
    const [joinColumns, setJoinColumns] = useState<Record<string, string>>({});
    const resultColumns = useMemo(
        () =>
            result
                ? result.declaredColumns?.length
                    ? result.declaredColumns
                    : result.columns
                : [],
        [result],
    );

    return (
        <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    disabled={!result}
                    onClick={() => {
                        if (!result) return;
                        const bytes = analysisResultWorkbook(result, {
                            name: name || "analysis",
                            timezone,
                            workspace,
                            definitionId,
                            definitionVersion,
                            datasetIds,
                            sourceReferences,
                            assumptions,
                            formulas,
                        });
                        downloadBlob(
                            new Blob([bytes as BlobPart], {
                                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            }),
                            `${name || "analysis"}.xlsx`,
                        );
                    }}
                >
                    {t("analysis.ext.workbook.export")}
                </Button>
                <Label
                    htmlFor={workbookInputId}
                    className={buttonVariants({
                        variant: "outline",
                        className:
                            "cursor-pointer whitespace-normal has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70 has-[:focus-visible]:ring-offset-2",
                    })}
                >
                    {t("analysis.ext.workbook.import")}
                    <input
                        className="sr-only"
                        type="file"
                        id={workbookInputId}
                        accept=".xlsx"
                        onChange={async (event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            try {
                                if (file.size > 10 * 1024 * 1024)
                                    throw new Error(
                                        t("analysis.ext.workbook.limit"),
                                    );
                                if (scenarioModel.attachments.length >= 5)
                                    throw new Error(
                                        t("analysis.ext.workbook.limit"),
                                    );
                                const bytes = new Uint8Array(
                                    await file.arrayBuffer(),
                                );
                                const imported = importAnalysisWorkbook(bytes);
                                if (
                                    imported.rows.length > 1000 ||
                                    imported.columns.length > 32
                                )
                                    throw new Error(
                                        t("analysis.ext.workbook.limit"),
                                    );
                                const digest = await crypto.subtle.digest(
                                    "SHA-256",
                                    bytes,
                                );
                                const attachment = {
                                    id: `workbook_${crypto.randomUUID().replace(/-/g, "")}`,
                                    fileName: file.name,
                                    importedAt: new Date().toISOString(),
                                    sha256: Array.from(new Uint8Array(digest))
                                        .map((v) =>
                                            v.toString(16).padStart(2, "0"),
                                        )
                                        .join(""),
                                    rows: imported.rows,
                                    columns: imported.columns.map((id) => {
                                        const values = imported.rows
                                            .map((r) => r[id])
                                            .filter((v) => v != null);
                                        const type:
                                            | "string"
                                            | "integer"
                                            | "decimal"
                                            | "boolean"
                                            | "date" =
                                            values.length &&
                                            values.every(
                                                (v) => typeof v === "boolean",
                                            )
                                                ? "boolean"
                                                : values.length &&
                                                    values.every(
                                                        (v) =>
                                                            typeof v ===
                                                                "number" &&
                                                            Number.isSafeInteger(
                                                                v,
                                                            ),
                                                    )
                                                  ? "integer"
                                                  : values.length &&
                                                      values.every((v) =>
                                                          /^-?\d+(\.\d+)?$/.test(
                                                              String(v),
                                                          ),
                                                      )
                                                    ? "decimal"
                                                    : values.length &&
                                                        values.every((v) =>
                                                            /^\d{4}-\d{2}-\d{2}$/.test(
                                                                String(v),
                                                            ),
                                                        )
                                                      ? "date"
                                                      : "string";
                                        return { id, label: id, type };
                                    }),
                                };
                                onScenarioModelChange({
                                    ...scenarioModel,
                                    attachments: [
                                        ...scenarioModel.attachments,
                                        attachment,
                                    ],
                                });
                                setError(null);
                            } catch (cause) {
                                setError(
                                    cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                );
                            }
                        }}
                    />
                </Label>
                <Button
                    type="button"
                    variant="outline"
                    disabled={!result}
                    onClick={() => {
                        if (!result) return;
                        const csv = analysisResultCsv(result, {
                            name: name || "analysis",
                            timezone,
                            workspace,
                            definitionId,
                            definitionVersion,
                            datasetIds,
                            sourceReferences,
                        });
                        downloadBlob(
                            new Blob([csv], { type: "text/csv;charset=utf-8" }),
                            `${(name || "analysis").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}.csv`,
                        );
                    }}
                >
                    <Download className="mr-2 h-4 w-4" />
                    {t("analysis.exportCsv")}
                </Button>
                <Label
                    htmlFor={scenarioInputId}
                    className={buttonVariants({
                        variant: "outline",
                        className:
                            "cursor-pointer whitespace-normal has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70 has-[:focus-visible]:ring-offset-2",
                    })}
                >
                    <Paperclip className="mr-2 h-4 w-4" />
                    {t("analysis.attachScenarioCsv")}
                    <input
                        id={scenarioInputId}
                        className="sr-only"
                        type="file"
                        accept="text/csv,.csv"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            if (scenarioModel.attachments.length >= 5) {
                                setError(t("analysis.ext.workbook.limit"));
                                return;
                            }
                            void parseScenarioCsv(file)
                                .then((attachment) => {
                                    setError(null);
                                    onScenarioModelChange({
                                        ...scenarioModel,
                                        attachments: [
                                            ...scenarioModel.attachments.filter(
                                                ({ id }) =>
                                                    id !== attachment.id,
                                            ),
                                            attachment,
                                        ],
                                    });
                                })
                                .catch((cause) =>
                                    setError(
                                        cause instanceof Error
                                            ? cause.message
                                            : t("analysis.scenarioInvalid"),
                                    ),
                                );
                        }}
                    />
                </Label>
            </div>
            <p className="text-xs text-muted-foreground">
                {t("analysis.ext.workbook.scope")}
            </p>
            <p className="text-xs text-muted-foreground">
                {t("analysis.csvSafety")}
            </p>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {scenarioModel.attachments.map((attachment) => {
                const existingJoin = scenarioModel.joins.find(
                    (join) => join.inputId === attachment.id,
                );
                const inputColumn =
                    joinColumns[`${attachment.id}:input`] ??
                    existingJoin?.inputColumn ??
                    attachment.columns[0]?.id ??
                    "";
                const resultColumn =
                    joinColumns[`${attachment.id}:result`] ??
                    existingJoin?.resultColumn ??
                    resultColumns[0]?.id ??
                    "";
                const joined = Boolean(existingJoin);
                const resultFieldId = `${scenarioInputId}-${attachment.id}-result`;
                const importedFieldId = `${scenarioInputId}-${attachment.id}-imported`;
                return (
                    <div
                        key={attachment.id}
                        className="min-w-0 space-y-3 rounded-lg bg-muted/30 p-3 text-sm"
                    >
                        <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 break-words font-medium text-sm">
                                {attachment.fileName} · {attachment.rows.length}{" "}
                                {t("analysis.rows")}
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={t("analysis.removeScenario")}
                                onClick={() =>
                                    onScenarioModelChange({
                                        attachments:
                                            scenarioModel.attachments.filter(
                                                ({ id }) =>
                                                    id !== attachment.id,
                                            ),
                                        joins: scenarioModel.joins.filter(
                                            ({ inputId }) =>
                                                inputId !== attachment.id,
                                        ),
                                    })
                                }
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                        <details>
                            <summary className="cursor-pointer rounded text-sm text-muted-foreground focus-ring">
                                {t("analysis.ext.workbook.preview")}
                            </summary>
                            <div className="overflow-auto">
                                <table>
                                    <thead>
                                        <tr>
                                            {attachment.columns.map(
                                                (column) => (
                                                    <th
                                                        className="p-2"
                                                        key={column.id}
                                                    >
                                                        {column.label} (
                                                        {column.type})
                                                    </th>
                                                ),
                                            )}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {attachment.rows
                                            .slice(0, 5)
                                            .map((row, i) => (
                                                <tr key={i}>
                                                    {attachment.columns.map(
                                                        (column) => (
                                                            <td
                                                                className="p-2"
                                                                key={column.id}
                                                            >
                                                                {String(
                                                                    row[
                                                                        column
                                                                            .id
                                                                    ] ?? "—",
                                                                )}
                                                            </td>
                                                        ),
                                                    )}
                                                </tr>
                                            ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="min-w-0 space-y-1.5">
                                <Label htmlFor={resultFieldId}>
                                    {t("analysis.interchange.resultField")}
                                </Label>
                                <select
                                    id={resultFieldId}
                                    value={resultColumn}
                                    onChange={(event) =>
                                        setJoinColumns((current) => ({
                                            ...current,
                                            [`${attachment.id}:result`]:
                                                event.target.value,
                                        }))
                                    }
                                    className="h-9 w-full min-w-0 rounded-control border border-input/70 bg-background/80 px-3 text-sm focus-ring"
                                >
                                    {resultColumns.map((column) => (
                                        <option
                                            key={column.id}
                                            value={column.id}
                                        >
                                            {"label" in column && typeof column.label === "string"
                                                ? column.label
                                                : column.id}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="min-w-0 space-y-1.5">
                                <Label htmlFor={importedFieldId}>
                                    {t("analysis.interchange.importedField")}
                                </Label>
                                <select
                                    id={importedFieldId}
                                    value={inputColumn}
                                    onChange={(event) =>
                                        setJoinColumns((current) => ({
                                            ...current,
                                            [`${attachment.id}:input`]:
                                                event.target.value,
                                        }))
                                    }
                                    className="h-9 w-full min-w-0 rounded-control border border-input/70 bg-background/80 px-3 text-sm focus-ring"
                                >
                                    {attachment.columns.map(({ id, label }) => (
                                        <option key={id} value={id}>
                                            {label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("analysis.interchange.matchHint")}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant={joined ? "secondary" : "outline"}
                            disabled={!resultColumn || !inputColumn}
                            onClick={() =>
                                onScenarioModelChange({
                                    ...scenarioModel,
                                    joins: [
                                        ...scenarioModel.joins.filter(
                                            ({ inputId }) =>
                                                inputId !== attachment.id,
                                        ),
                                        {
                                            inputId: attachment.id,
                                            resultColumn,
                                            inputColumn,
                                        },
                                    ],
                                })
                            }
                        >
                            {joined
                                ? t("analysis.updateScenarioJoin")
                                : t("analysis.addScenarioJoin")}
                        </Button>
                    </div>
                );
            })}
        </div>
    );
}
