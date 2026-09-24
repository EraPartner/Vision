import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Save, Trash2 } from "lucide-react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { pageIcon } from "@/lib/pageIcons";
import type { SavedAnalysis } from "@/lib/api/analysis";
import type {
    MonitorCreate,
    MonitorKind,
    MonitorOperator,
    MonitorUpdate,
    MonitorObservation,
} from "@/lib/api/monitors";
import {
    useMonitorActions,
    useMonitorNotifications,
    useMonitorObservations,
    useMonitors,
    useMonitorTargets,
} from "@/hooks/useMonitors";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const numericType = /^(?:decimal|number|integer|currency)$/;
const knownReasonCodes = new Set([
    "baseline",
    "threshold-not-met",
    "threshold-crossed",
    "threshold-cooldown",
    "threshold-already-met",
    "evidence-changed",
    "evidence-cooldown",
    "evidence-unchanged",
    "analysis-deleted",
    "analysis-unavailable",
    "analysis-frozen",
    "analysis-execution-failed",
    "analysis-run-missing",
    "analysis-definition-changed",
    "analysis-field-changed",
    "analysis-run-incomplete",
    "analysis-window-incomplete",
    "analysis-formula-incomplete",
    "analysis-nonnumeric",
    "dossier-deleted",
    "dossier-unavailable",
    "dossier-evidence-invalid",
    "monitor-check-failed",
]);
function reasonLabel(
    reasonCode: string | null | undefined,
    reason: string | null,
    t: (key: string) => string,
) {
    return reasonCode && knownReasonCodes.has(reasonCode)
        ? t(`monitors.reason.${reasonCode}`)
        : reason;
}

function numericColumns(analysis: SavedAnalysis) {
    const result = analysis.lastResult;
    if (!result || result.rows.length !== 1) return [];
    return result.columns.filter(
        (column) =>
            numericType.test(column.type) &&
            (typeof result.rows[0][column.id] === "number" ||
                (typeof result.rows[0][column.id] === "string" &&
                    decimal.test(result.rows[0][column.id] as string))),
    );
}

function dateTime(value: string | null) {
    return value ? new Date(value).toLocaleString() : "—";
}

function Observation({ item }: { item: MonitorObservation }) {
    const { t } = useLanguage();
    return (
        <li className="rounded-lg border p-3 text-sm space-y-1">
            <p className="font-medium">
                {t(`monitors.status.${item.status}`)} ·{" "}
                {dateTime(item.checkedAt)}
            </p>
            {reasonLabel(item.reasonCode, item.reason, t) && (
                <p>{reasonLabel(item.reasonCode, item.reason, t)}</p>
            )}
            {(item.previousValue !== null || item.currentValue !== null) && (
                <p>
                    {t("monitors.valueChange", {
                        previous: item.previousValue ?? "—",
                        current: item.currentValue ?? "—",
                    })}
                </p>
            )}
            {(item.previousEvidenceVersion !== null ||
                item.currentEvidenceVersion !== null) && (
                <p>
                    {t("monitors.evidenceChange", {
                        previous: item.previousEvidenceVersion ?? "—",
                        current: item.currentEvidenceVersion ?? "—",
                    })}
                </p>
            )}
            {item.coverage?.status === "unknown" && (
                <p className="text-muted-foreground">
                    {t("monitors.coverage")}
                </p>
            )}
        </li>
    );
}

const blank: {
    kind: MonitorKind;
    title: string;
    savedAnalysisId: string;
    dossierId: string;
    fieldId: string;
    operator: MonitorOperator;
    threshold: string;
    intervalMinutes: number;
    cooldownMinutes: number;
} = {
    kind: "analysis-threshold",
    title: "",
    savedAnalysisId: "",
    dossierId: "",
    fieldId: "",
    operator: "above" as MonitorOperator,
    threshold: "",
    intervalMinutes: 1440,
    cooldownMinutes: 1440,
};

export default function AnalysisMonitorsPage() {
    const { t } = useLanguage();
    const [monitorOffset, setMonitorOffset] = useState(0);
    const [observationOffset, setObservationOffset] = useState(0);
    const [notificationOffset, setNotificationOffset] = useState(0);
    const [targetDossierOffset, setTargetDossierOffset] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [form, setForm] = useState({ ...blank });
    const [edit, setEdit] = useState<MonitorUpdate | null>(null);
    const loadedEdit = useRef<string | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const monitors = useMonitors(monitorOffset);
    const observations = useMonitorObservations(selectedId, observationOffset);
    const notifications = useMonitorNotifications(notificationOffset);
    const targets = useMonitorTargets(targetDossierOffset);
    const actions = useMonitorActions();
    const selected =
        monitors.data?.items.find((item) => item.id === selectedId) ?? null;
    const eligible = useMemo(
        () =>
            (targets.analyses.data ?? []).filter(
                (analysis) =>
                    analysis.refreshMode === "live" &&
                    numericColumns(analysis).length > 0,
            ),
        [targets.analyses.data],
    );
    const chosenAnalysis = eligible.find(
        (analysis) => analysis.id === form.savedAnalysisId,
    );
    const columns = chosenAnalysis ? numericColumns(chosenAnalysis) : [];
    const selectedAnalysis = targets.analyses.data?.find(
        (analysis) => analysis.id === selected?.savedAnalysisId,
    );
    const editColumns = selectedAnalysis
        ? numericColumns(selectedAnalysis)
        : [];
    const busy =
        actions.create.isPending ||
        actions.update.isPending ||
        actions.remove.isPending ||
        actions.check.isPending ||
        actions.read.isPending;

    useEffect(() => {
        if (!selected) {
            if (loadedEdit.current !== null) {
                loadedEdit.current = null;
                setEdit(null);
            }
            return;
        }
        const revision = `${selected.id}:${selected.updatedAt}`;
        if (loadedEdit.current === revision) return;
        loadedEdit.current = revision;
        setEdit({
            title: selected.title,
            enabled: selected.enabled,
            fieldId: selected.fieldId ?? undefined,
            operator: selected.operator ?? undefined,
            threshold: selected.threshold ?? undefined,
            intervalMinutes: selected.intervalMinutes,
            cooldownMinutes: selected.cooldownMinutes,
        });
    }, [selected]);

    const run = async (task: () => Promise<void>) => {
        setError("");
        setNotice("");
        try {
            await task();
        } catch (cause) {
            setError(apiErrorToMessage(cause, t));
        }
    };
    const create = () =>
        run(async () => {
            if (!form.title.trim()) {
                setError(t("monitors.titleRequired"));
                return;
            }
            let input: MonitorCreate;
            if (form.kind === "analysis-threshold") {
                if (
                    !form.savedAnalysisId ||
                    !columns.some((column) => column.id === form.fieldId) ||
                    !decimal.test(form.threshold)
                ) {
                    setError(t("monitors.thresholdRequired"));
                    return;
                }
                input = {
                    kind: "analysis-threshold",
                    title: form.title.trim(),
                    savedAnalysisId: form.savedAnalysisId,
                    fieldId: form.fieldId,
                    operator: form.operator,
                    threshold: form.threshold,
                    intervalMinutes: form.intervalMinutes,
                    cooldownMinutes: form.cooldownMinutes,
                };
            } else {
                if (!form.dossierId) {
                    setError(t("monitors.dossierRequired"));
                    return;
                }
                input = {
                    kind: "dossier-evidence",
                    title: form.title.trim(),
                    dossierId: form.dossierId,
                    intervalMinutes: form.intervalMinutes,
                    cooldownMinutes: form.cooldownMinutes,
                };
            }
            const created = await actions.create.mutateAsync(input);
            setForm({ ...blank });
            setMonitorOffset(0);
            setSelectedId(created.id);
            setNotice(t("monitors.created"));
        });
    const save = () =>
        run(async () => {
            if (!selected || !edit) return;
            if (!edit.title?.trim()) {
                setError(t("monitors.titleRequired"));
                return;
            }
            if (
                selected.kind === "analysis-threshold" &&
                (!edit.threshold || !decimal.test(edit.threshold))
            ) {
                setError(t("monitors.thresholdRequired"));
                return;
            }
            await actions.update.mutateAsync({ id: selected.id, patch: edit });
            setNotice(t("monitors.saved"));
        });
    const remove = () =>
        run(async () => {
            if (!selected || !window.confirm(t("monitors.deleteConfirm")))
                return;
            await actions.remove.mutateAsync(selected.id);
            setSelectedId(null);
            setNotice(t("monitors.deleted"));
        });
    const check = () =>
        run(async () => {
            if (!selected) return;
            const result = await actions.check.mutateAsync(selected.id);
            setObservationOffset(0);
            setNotice(
                t("monitors.checkResult", {
                    status: t(`monitors.status.${result.status}`),
                }),
            );
        });
    const markRead = (id: string) =>
        run(async () => {
            await actions.read.mutateAsync(id);
            setNotice(t("monitors.markedRead"));
        });

    return (
        <PageShell>
            <PageHeader
                title={t("monitors.title")}
                subtitle={t("monitors.subtitle")}
                icon={pageIcon("/analysis/monitors")}
            />
            {error && (
                <p
                    role="alert"
                    className="rounded-lg border border-destructive p-3 text-destructive"
                >
                    {error}
                </p>
            )}
            {notice && (
                <p role="status" className="rounded-lg border p-3">
                    {notice}
                </p>
            )}
            <div className="grid gap-6 xl:grid-cols-[minmax(19rem,23rem)_1fr]">
                <div className="space-y-6">
                    <form
                        className="space-y-3 rounded-xl border p-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void create();
                        }}
                    >
                        <h2 className="text-lg font-semibold">
                            {t("monitors.newRule")}
                        </h2>
                        <div className="space-y-1">
                            <Label htmlFor="monitor-kind">
                                {t("monitors.kind")}
                            </Label>
                            <select
                                id="monitor-kind"
                                className="h-10 w-full rounded-lg border bg-background px-3"
                                value={form.kind}
                                onChange={(event) =>
                                    setForm({
                                        ...blank,
                                        kind: event.target
                                            .value as typeof form.kind,
                                    })
                                }
                            >
                                <option value="analysis-threshold">
                                    {t("monitors.kind.threshold")}
                                </option>
                                <option value="dossier-evidence">
                                    {t("monitors.kind.evidence")}
                                </option>
                            </select>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="monitor-title">
                                {t("monitors.ruleTitle")}
                            </Label>
                            <Input
                                id="monitor-title"
                                required
                                value={form.title}
                                onChange={(event) =>
                                    setForm((current) => ({
                                        ...current,
                                        title: event.target.value,
                                    }))
                                }
                            />
                        </div>
                        {form.kind === "analysis-threshold" ? (
                            <>
                                <div className="space-y-1">
                                    <Label htmlFor="monitor-analysis">
                                        {t("monitors.analysis")}
                                    </Label>
                                    <select
                                        id="monitor-analysis"
                                        className="h-10 w-full rounded-lg border bg-background px-3"
                                        value={form.savedAnalysisId}
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                savedAnalysisId:
                                                    event.target.value,
                                                fieldId: "",
                                            }))
                                        }
                                    >
                                        <option value="">
                                            {t("monitors.selectAnalysis")}
                                        </option>
                                        {eligible.map((analysis) => (
                                            <option
                                                key={analysis.id}
                                                value={analysis.id}
                                            >
                                                {analysis.name}
                                            </option>
                                        ))}
                                    </select>
                                    {targets.analyses.isError && (
                                        <p role="alert">
                                            {t("monitors.targetsFailed")}
                                        </p>
                                    )}
                                    {targets.analyses.isLoading && (
                                        <p>{t("monitors.targetsLoading")}</p>
                                    )}
                                    {!targets.analyses.isLoading &&
                                        !targets.analyses.isError &&
                                        eligible.length === 0 && (
                                            <p>
                                                {t(
                                                    "monitors.noEligibleAnalyses",
                                                )}
                                            </p>
                                        )}
                                    <p className="text-xs text-muted-foreground">
                                        {t("monitors.analysisHint")}
                                    </p>
                                </div>
                                <div className="space-y-1">
                                    <Label htmlFor="monitor-field">
                                        {t("monitors.field")}
                                    </Label>
                                    <select
                                        id="monitor-field"
                                        className="h-10 w-full rounded-lg border bg-background px-3"
                                        value={form.fieldId}
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                fieldId: event.target.value,
                                            }))
                                        }
                                    >
                                        <option value="">
                                            {t("monitors.selectField")}
                                        </option>
                                        {columns.map((column) => (
                                            <option
                                                key={column.id}
                                                value={column.id}
                                            >
                                                {column.id}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <Label htmlFor="monitor-operator">
                                            {t("monitors.operator")}
                                        </Label>
                                        <select
                                            id="monitor-operator"
                                            className="h-10 w-full rounded-lg border bg-background px-3"
                                            value={form.operator}
                                            onChange={(event) =>
                                                setForm((current) => ({
                                                    ...current,
                                                    operator: event.target
                                                        .value as MonitorOperator,
                                                }))
                                            }
                                        >
                                            <option value="above">
                                                {t("monitors.above")}
                                            </option>
                                            <option value="below">
                                                {t("monitors.below")}
                                            </option>
                                        </select>
                                    </div>
                                    <div className="space-y-1">
                                        <Label htmlFor="monitor-threshold">
                                            {t("monitors.threshold")}
                                        </Label>
                                        <Input
                                            id="monitor-threshold"
                                            inputMode="decimal"
                                            value={form.threshold}
                                            onChange={(event) =>
                                                setForm((current) => ({
                                                    ...current,
                                                    threshold:
                                                        event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="space-y-1">
                                <Label htmlFor="monitor-dossier">
                                    {t("monitors.dossier")}
                                </Label>
                                <select
                                    id="monitor-dossier"
                                    className="h-10 w-full rounded-lg border bg-background px-3"
                                    value={form.dossierId}
                                    onChange={(event) =>
                                        setForm((current) => ({
                                            ...current,
                                            dossierId: event.target.value,
                                        }))
                                    }
                                >
                                    <option value="">
                                        {t("monitors.selectDossier")}
                                    </option>
                                    {targets.dossiers.data?.items.map(
                                        (dossier) => (
                                            <option
                                                key={dossier.id}
                                                value={dossier.id}
                                            >
                                                {dossier.title}
                                            </option>
                                        ),
                                    )}
                                </select>
                                {targets.dossiers.isError && (
                                    <p role="alert">
                                        {t("monitors.targetsFailed")}
                                    </p>
                                )}
                                {targets.dossiers.isLoading && (
                                    <p>{t("monitors.targetsLoading")}</p>
                                )}
                                {!targets.dossiers.isLoading &&
                                    !targets.dossiers.isError &&
                                    targets.dossiers.data?.total === 0 && (
                                        <p>{t("monitors.noDossiers")}</p>
                                    )}
                                {(targets.dossiers.data?.total ?? 0) > 500 && (
                                    <div className="flex items-center gap-2 text-xs">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            disabled={targetDossierOffset === 0}
                                            onClick={() => {
                                                setTargetDossierOffset(
                                                    Math.max(
                                                        0,
                                                        targetDossierOffset -
                                                            500,
                                                    ),
                                                );
                                                setForm((current) => ({
                                                    ...current,
                                                    dossierId: "",
                                                }));
                                            }}
                                        >
                                            {t("monitors.previous")}
                                        </Button>
                                        <span>
                                            {t("monitors.pageRange", {
                                                first: targetDossierOffset + 1,
                                                last: Math.min(
                                                    targetDossierOffset + 500,
                                                    targets.dossiers.data!
                                                        .total,
                                                ),
                                                total: targets.dossiers.data!
                                                    .total,
                                            })}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            disabled={
                                                targetDossierOffset + 500 >=
                                                targets.dossiers.data!.total
                                            }
                                            onClick={() => {
                                                setTargetDossierOffset(
                                                    targetDossierOffset + 500,
                                                );
                                                setForm((current) => ({
                                                    ...current,
                                                    dossierId: "",
                                                }));
                                            }}
                                        >
                                            {t("monitors.next")}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                                <Label htmlFor="monitor-interval">
                                    {t("monitors.interval")}
                                </Label>
                                <Input
                                    id="monitor-interval"
                                    type="number"
                                    min={15}
                                    max={10080}
                                    value={form.intervalMinutes}
                                    onChange={(event) =>
                                        setForm((current) => ({
                                            ...current,
                                            intervalMinutes: Number(
                                                event.target.value,
                                            ),
                                        }))
                                    }
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="monitor-cooldown">
                                    {t("monitors.cooldown")}
                                </Label>
                                <Input
                                    id="monitor-cooldown"
                                    type="number"
                                    min={0}
                                    max={10080}
                                    value={form.cooldownMinutes}
                                    onChange={(event) =>
                                        setForm((current) => ({
                                            ...current,
                                            cooldownMinutes: Number(
                                                event.target.value,
                                            ),
                                        }))
                                    }
                                />
                            </div>
                        </div>
                        <Button type="submit" disabled={busy}>
                            <Plus className="mr-2 size-4" />
                            {t("monitors.create")}
                        </Button>
                    </form>
                    <section className="space-y-2">
                        <h2 className="text-lg font-semibold">
                            {t("monitors.rules")}
                        </h2>
                        {monitors.isError && (
                            <p role="alert">{t("monitors.loadFailed")}</p>
                        )}
                        {!monitors.isLoading &&
                            !monitors.data?.items.length && (
                                <p>{t("monitors.empty")}</p>
                            )}
                        {monitors.data?.items.map((monitor) => (
                            <button
                                key={monitor.id}
                                type="button"
                                aria-current={
                                    monitor.id === selectedId
                                        ? "page"
                                        : undefined
                                }
                                onClick={() => {
                                    setSelectedId(monitor.id);
                                    setObservationOffset(0);
                                }}
                                className="w-full rounded-lg border p-3 text-left hover:bg-accent aria-[current=page]:border-primary"
                            >
                                <span className="block font-medium">
                                    {monitor.title}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                    {monitor.targetLabel} ·{" "}
                                    {t(
                                        `monitors.status.${monitor.lastStatus ?? "never"}`,
                                    )}{" "}
                                    ·{" "}
                                    {monitor.enabled
                                        ? t("monitors.enabled")
                                        : t("monitors.disabled")}
                                </span>
                            </button>
                        ))}
                        {monitors.data && monitors.data.total > 200 && (
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={monitorOffset === 0}
                                    onClick={() =>
                                        setMonitorOffset(
                                            Math.max(0, monitorOffset - 200),
                                        )
                                    }
                                >
                                    {t("monitors.previous")}
                                </Button>
                                <span>
                                    {t("monitors.pageRange", {
                                        first: monitorOffset + 1,
                                        last: Math.min(
                                            monitorOffset + 200,
                                            monitors.data.total,
                                        ),
                                        total: monitors.data.total,
                                    })}
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={
                                        monitorOffset + 200 >=
                                        monitors.data.total
                                    }
                                    onClick={() =>
                                        setMonitorOffset(monitorOffset + 200)
                                    }
                                >
                                    {t("monitors.next")}
                                </Button>
                            </div>
                        )}
                    </section>
                </div>
                <div className="space-y-6">
                    {selected && edit && (
                        <section className="space-y-4 rounded-xl border p-4">
                            <h2 className="text-lg font-semibold">
                                {t("monitors.ruleDetails")}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {t(
                                    `monitors.kind.${selected.kind === "analysis-threshold" ? "threshold" : "evidence"}`,
                                )}{" "}
                                · {selected.targetLabel}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => void check()}
                                >
                                    <Play className="mr-2 size-4" />
                                    {t("monitors.checkNow")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() => void remove()}
                                >
                                    <Trash2 className="mr-2 size-4" />
                                    {t("monitors.delete")}
                                </Button>
                            </div>
                            <form
                                className="space-y-3"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void save();
                                }}
                            >
                                <div className="space-y-1">
                                    <Label htmlFor="edit-title">
                                        {t("monitors.ruleTitle")}
                                    </Label>
                                    <Input
                                        id="edit-title"
                                        value={edit.title ?? ""}
                                        onChange={(event) =>
                                            setEdit((current) => ({
                                                ...current,
                                                title: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={edit.enabled ?? false}
                                        onChange={(event) =>
                                            setEdit((current) => ({
                                                ...current,
                                                enabled: event.target.checked,
                                            }))
                                        }
                                    />
                                    {t("monitors.enabled")}
                                </label>
                                {selected.kind === "analysis-threshold" && (
                                    <>
                                        <div className="space-y-1">
                                            <Label htmlFor="edit-field">
                                                {t("monitors.field")}
                                            </Label>
                                            <select
                                                id="edit-field"
                                                className="h-10 w-full rounded-lg border bg-background px-3"
                                                value={edit.fieldId ?? ""}
                                                onChange={(event) =>
                                                    setEdit((current) => ({
                                                        ...current,
                                                        fieldId:
                                                            event.target.value,
                                                    }))
                                                }
                                            >
                                                {editColumns.map((column) => (
                                                    <option
                                                        key={column.id}
                                                        value={column.id}
                                                    >
                                                        {column.id}
                                                    </option>
                                                ))}
                                                {edit.fieldId &&
                                                    !editColumns.some(
                                                        (column) =>
                                                            column.id ===
                                                            edit.fieldId,
                                                    ) && (
                                                        <option
                                                            value={edit.fieldId}
                                                        >
                                                            {edit.fieldId}
                                                        </option>
                                                    )}
                                            </select>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="space-y-1">
                                                <Label htmlFor="edit-operator">
                                                    {t("monitors.operator")}
                                                </Label>
                                                <select
                                                    id="edit-operator"
                                                    className="h-10 w-full rounded-lg border bg-background px-3"
                                                    value={
                                                        edit.operator ?? "above"
                                                    }
                                                    onChange={(event) =>
                                                        setEdit((current) => ({
                                                            ...current,
                                                            operator: event
                                                                .target
                                                                .value as MonitorOperator,
                                                        }))
                                                    }
                                                >
                                                    <option value="above">
                                                        {t("monitors.above")}
                                                    </option>
                                                    <option value="below">
                                                        {t("monitors.below")}
                                                    </option>
                                                </select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label htmlFor="edit-threshold">
                                                    {t("monitors.threshold")}
                                                </Label>
                                                <Input
                                                    id="edit-threshold"
                                                    inputMode="decimal"
                                                    value={edit.threshold ?? ""}
                                                    onChange={(event) =>
                                                        setEdit((current) => ({
                                                            ...current,
                                                            threshold:
                                                                event.target
                                                                    .value,
                                                        }))
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <Label htmlFor="edit-interval">
                                            {t("monitors.interval")}
                                        </Label>
                                        <Input
                                            id="edit-interval"
                                            type="number"
                                            min={15}
                                            max={10080}
                                            value={edit.intervalMinutes ?? 1440}
                                            onChange={(event) =>
                                                setEdit((current) => ({
                                                    ...current,
                                                    intervalMinutes: Number(
                                                        event.target.value,
                                                    ),
                                                }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label htmlFor="edit-cooldown">
                                            {t("monitors.cooldown")}
                                        </Label>
                                        <Input
                                            id="edit-cooldown"
                                            type="number"
                                            min={0}
                                            max={10080}
                                            value={edit.cooldownMinutes ?? 1440}
                                            onChange={(event) =>
                                                setEdit((current) => ({
                                                    ...current,
                                                    cooldownMinutes: Number(
                                                        event.target.value,
                                                    ),
                                                }))
                                            }
                                        />
                                    </div>
                                </div>
                                <Button type="submit" disabled={busy}>
                                    <Save className="mr-2 size-4" />
                                    {t("monitors.save")}
                                </Button>
                            </form>
                            <div className="grid gap-2 text-sm md:grid-cols-2">
                                <p>
                                    {t("monitors.nextDue")}:{" "}
                                    {dateTime(selected.nextDueAt)}
                                </p>
                                <p>
                                    {t("monitors.lastChecked")}:{" "}
                                    {dateTime(selected.lastCheckedAt)}
                                </p>
                                <p>
                                    {t("monitors.lastStatus")}:{" "}
                                    {t(
                                        `monitors.status.${selected.lastStatus ?? "never"}`,
                                    )}
                                </p>
                            </div>
                            {selected.lastObservation && (
                                <ul>
                                    <Observation
                                        item={selected.lastObservation}
                                    />
                                </ul>
                            )}
                        </section>
                    )}
                    <section className="space-y-2">
                        <h2 className="text-lg font-semibold">
                            {t("monitors.observations")}
                        </h2>
                        {selectedId ? (
                            <>
                                {observations.isError && (
                                    <p role="alert">
                                        {t("monitors.observationsFailed")}
                                    </p>
                                )}
                                {observations.data &&
                                    !observations.data.items.length && (
                                        <p>{t("monitors.noObservations")}</p>
                                    )}
                                <ul className="space-y-2">
                                    {observations.data?.items.map((item) => (
                                        <Observation
                                            key={item.id}
                                            item={item}
                                        />
                                    ))}
                                </ul>
                                {observations.data &&
                                    observations.data.total > 200 && (
                                        <div className="flex gap-2">
                                            <Button
                                                variant="outline"
                                                disabled={
                                                    observationOffset === 0
                                                }
                                                onClick={() =>
                                                    setObservationOffset(
                                                        Math.max(
                                                            0,
                                                            observationOffset -
                                                                200,
                                                        ),
                                                    )
                                                }
                                            >
                                                {t("monitors.previous")}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                disabled={
                                                    observationOffset + 200 >=
                                                    observations.data.total
                                                }
                                                onClick={() =>
                                                    setObservationOffset(
                                                        observationOffset + 200,
                                                    )
                                                }
                                            >
                                                {t("monitors.next")}
                                            </Button>
                                        </div>
                                    )}
                            </>
                        ) : (
                            <p className="text-muted-foreground">
                                {t("monitors.selectRule")}
                            </p>
                        )}
                    </section>
                    <section className="space-y-2">
                        <h2 className="text-lg font-semibold">
                            {t("monitors.inbox")}
                        </h2>
                        {notifications.isError && (
                            <p role="alert">{t("monitors.inboxFailed")}</p>
                        )}
                        {notifications.data &&
                            !notifications.data.items.length && (
                                <p>{t("monitors.noNotifications")}</p>
                            )}
                        <ul className="space-y-2">
                            {notifications.data?.items.map((item) => (
                                <li
                                    key={item.id}
                                    className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                                >
                                    <div>
                                        <p className="font-medium">
                                            {item.title} ·{" "}
                                            {dateTime(item.createdAt)}
                                        </p>
                                        <p>
                                            {reasonLabel(
                                                item.reasonCode,
                                                item.reason,
                                                t,
                                            ) ??
                                                t(
                                                    "monitors.notificationReasonUnknown",
                                                )}
                                        </p>
                                        {(item.previousValue !== null ||
                                            item.currentValue !== null) && (
                                            <p>
                                                {t("monitors.valueChange", {
                                                    previous:
                                                        item.previousValue ??
                                                        "—",
                                                    current:
                                                        item.currentValue ??
                                                        "—",
                                                })}
                                            </p>
                                        )}
                                    </div>
                                    {!item.readAt && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            disabled={busy}
                                            onClick={() =>
                                                void markRead(item.id)
                                            }
                                        >
                                            {t("monitors.markRead")}
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                        {notifications.data &&
                            notifications.data.total > 200 && (
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={notificationOffset === 0}
                                        onClick={() =>
                                            setNotificationOffset(
                                                Math.max(
                                                    0,
                                                    notificationOffset - 200,
                                                ),
                                            )
                                        }
                                    >
                                        {t("monitors.previous")}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        disabled={
                                            notificationOffset + 200 >=
                                            notifications.data.total
                                        }
                                        onClick={() =>
                                            setNotificationOffset(
                                                notificationOffset + 200,
                                            )
                                        }
                                    >
                                        {t("monitors.next")}
                                    </Button>
                                </div>
                            )}
                    </section>
                </div>
            </div>
        </PageShell>
    );
}
