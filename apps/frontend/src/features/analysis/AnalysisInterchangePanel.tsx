import {
    analysisResultWorkbook,
    importAnalysisWorkbook,
} from "./analysisWorkbook";
import { useId, useMemo, useRef, useState } from "react";
import {
    Download,
    FileSpreadsheet,
    Paperclip,
    Trash2,
    Upload,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
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
    const workbookInputRef = useRef<HTMLInputElement>(null);
    const scenarioInputRef = useRef<HTMLInputElement>(null);
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
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
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
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    {t("analysis.ext.workbook.export")}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => workbookInputRef.current?.click()}
                >
                    <Upload className="mr-2 h-4 w-4" />
                    {t("analysis.ext.workbook.import")}
                </Button>
                <input
                    ref={workbookInputRef}
                    className="sr-only"
                    tabIndex={-1}
                    type="file"
                    id={workbookInputId}
                    aria-label={t("analysis.ext.workbook.import")}
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
                                    .map((v) => v.toString(16).padStart(2, "0"))
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
                                                        typeof v === "number" &&
                                                        Number.isSafeInteger(v),
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
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => scenarioInputRef.current?.click()}
                >
                    <Paperclip className="mr-2 h-4 w-4" />
                    {t("analysis.attachScenarioCsv")}
                </Button>
                <input
                    ref={scenarioInputRef}
                    id={scenarioInputId}
                    className="sr-only"
                    tabIndex={-1}
                    type="file"
                    aria-label={t("analysis.attachScenarioCsv")}
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
                                            ({ id }) => id !== attachment.id,
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
            </div>
            <p className="type-footnote text-label-secondary">
                {t("analysis.ext.workbook.scope")}
            </p>
            <p className="type-footnote text-label-secondary">
                {t("analysis.csvSafety")}
            </p>
            {error && (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
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
                    <Card key={attachment.id}>
                        <CardContent
                            variant="compact"
                            className="min-w-0 space-y-3"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <span className="min-w-0 break-words type-headline">
                                    {attachment.fileName} ·{" "}
                                    {attachment.rows.length}{" "}
                                    {t("analysis.rows")}
                                </span>
                                <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    className="icon-touch-target shrink-0 text-destructive hover:text-destructive"
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
                            <Disclosure>
                                <DisclosureSummary tone="subtle">
                                    {t("analysis.ext.workbook.preview")}
                                </DisclosureSummary>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            {attachment.columns.map(
                                                (column) => (
                                                    <TableHead key={column.id}>
                                                        {column.label} (
                                                        {column.type})
                                                    </TableHead>
                                                ),
                                            )}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {attachment.rows
                                            .slice(0, 5)
                                            .map((row, i) => (
                                                <TableRow key={i}>
                                                    {attachment.columns.map(
                                                        (column) => (
                                                            <TableCell
                                                                className="py-2"
                                                                key={column.id}
                                                            >
                                                                {String(
                                                                    row[
                                                                        column
                                                                            .id
                                                                    ] ?? "—",
                                                                )}
                                                            </TableCell>
                                                        ),
                                                    )}
                                                </TableRow>
                                            ))}
                                    </TableBody>
                                </Table>
                            </Disclosure>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="min-w-0 space-y-1.5">
                                    <Label htmlFor={resultFieldId}>
                                        {t("analysis.interchange.resultField")}
                                    </Label>
                                    <Select
                                        value={resultColumn}
                                        onValueChange={(value) =>
                                            setJoinColumns((current) => ({
                                                ...current,
                                                [`${attachment.id}:result`]:
                                                    value,
                                            }))
                                        }
                                    >
                                        <SelectTrigger id={resultFieldId}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {resultColumns.map((column) => (
                                                <SelectItem
                                                    key={column.id}
                                                    value={column.id}
                                                >
                                                    {"label" in column &&
                                                    typeof column.label ===
                                                        "string"
                                                        ? column.label
                                                        : column.id}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="min-w-0 space-y-1.5">
                                    <Label htmlFor={importedFieldId}>
                                        {t(
                                            "analysis.interchange.importedField",
                                        )}
                                    </Label>
                                    <Select
                                        value={inputColumn}
                                        onValueChange={(value) =>
                                            setJoinColumns((current) => ({
                                                ...current,
                                                [`${attachment.id}:input`]:
                                                    value,
                                            }))
                                        }
                                    >
                                        <SelectTrigger id={importedFieldId}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {attachment.columns.map(
                                                ({ id, label }) => (
                                                    <SelectItem
                                                        key={id}
                                                        value={id}
                                                    >
                                                        {label}
                                                    </SelectItem>
                                                ),
                                            )}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <p className="type-footnote text-label-secondary">
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
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}
