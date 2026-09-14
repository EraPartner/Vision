import { useId, useMemo, useState } from "react";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}: {
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
                    className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm"
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
                {t("analysis.csvSafety")}
            </p>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {scenarioModel.attachments.map((attachment) => {
                const inputColumn =
                    joinColumns[`${attachment.id}:input`] ??
                    attachment.columns[0]?.id ??
                    "";
                const resultColumn =
                    joinColumns[`${attachment.id}:result`] ??
                    resultColumns[0]?.id ??
                    "";
                const joined = scenarioModel.joins.some(
                    (join) => join.inputId === attachment.id,
                );
                return (
                    <div
                        key={attachment.id}
                        className="space-y-2 rounded-md bg-muted/50 p-2 text-xs"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span>
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
                        <div className="grid gap-2 sm:grid-cols-2">
                            <select
                                aria-label={t("analysis.resultJoinColumn")}
                                value={resultColumn}
                                onChange={(event) =>
                                    setJoinColumns((current) => ({
                                        ...current,
                                        [`${attachment.id}:result`]:
                                            event.target.value,
                                    }))
                                }
                                className="rounded border bg-background p-1"
                            >
                                {resultColumns.map(({ id }) => (
                                    <option key={id} value={id}>
                                        {id}
                                    </option>
                                ))}
                            </select>
                            <select
                                aria-label={t("analysis.scenarioJoinColumn")}
                                value={inputColumn}
                                onChange={(event) =>
                                    setJoinColumns((current) => ({
                                        ...current,
                                        [`${attachment.id}:input`]:
                                            event.target.value,
                                    }))
                                }
                                className="rounded border bg-background p-1"
                            >
                                {attachment.columns.map(({ id, label }) => (
                                    <option key={id} value={id}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </div>
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
