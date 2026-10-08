import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type ReactNode,
} from "react";
import { Link } from "react-router";
import {
    Activity,
    Bell,
    ListChecks,
    Pause,
    Play,
    Plus,
    Save,
    Trash2,
} from "lucide-react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { cn } from "@/lib/utils";
import type { SavedAnalysis } from "@/lib/api/analysis";
import type {
    AnalysisMonitor,
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
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { RowMenu } from "@/components/shared/RowMenu";
import { PageShell } from "@/components/shared/PageShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
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
import { Switch } from "@/components/ui/switch";

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

function revealInvalidSchedule(event: FormEvent<HTMLDetailsElement>) {
    // Reveal before the browser tries to focus a hidden invalid input.
    event.currentTarget.open = true;
    const input = event.target;
    if (
        input instanceof HTMLInputElement &&
        Array.from(input.form?.elements ?? []).find(
            (element) =>
                element instanceof HTMLInputElement && !element.validity.valid,
        ) === input
    ) {
        input.focus();
    }
}

function dateTime(value: string | null) {
    return value ? new Date(value).toLocaleString() : "—";
}

const statusTone: Record<string, BadgeProps["variant"]> = {
    triggered: "warning",
    failed: "destructive",
    partial: "warning",
    stale: "warning",
    "cooldown-pending": "secondary",
    baseline: "secondary",
    unchanged: "muted",
    never: "muted",
};

function StatusBadge({ status }: { status: string | null | undefined }) {
    const { t } = useLanguage();
    const key = status ?? "never";
    return (
        <Badge variant={statusTone[key] ?? "muted"} size="sm">
            {t(`monitors.status.${key}`)}
        </Badge>
    );
}

const PAGE_SIZE = 200;
const TARGET_PAGE_SIZE = 500;

function Pager({
    offset,
    total,
    pageSize,
    onChange,
    showRange = true,
}: {
    offset: number;
    total: number;
    pageSize: number;
    onChange: (offset: number) => void;
    showRange?: boolean;
}) {
    const { t } = useLanguage();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => onChange(Math.max(0, offset - pageSize))}
            >
                {t("monitors.previous")}
            </Button>
            {showRange && (
                <span className="type-footnote text-label-secondary tabular-nums">
                    {t("monitors.pageRange", {
                        first: offset + 1,
                        last: Math.min(offset + pageSize, total),
                        total,
                    })}
                </span>
            )}
            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset + pageSize >= total}
                onClick={() => onChange(offset + pageSize)}
            >
                {t("monitors.next")}
            </Button>
        </div>
    );
}

function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
    const { t } = useLanguage();
    return (
        <div
            role="status"
            aria-busy="true"
            aria-label={label}
            className="space-y-2"
        >
            <span className="sr-only">{t("common.loading")}</span>
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-11 w-full rounded-card" />
            ))}
        </div>
    );
}

function RetryAlert({
    message,
    pending,
    onRetry,
}: {
    message: string;
    pending: boolean;
    onRetry: () => void;
}) {
    const { t } = useLanguage();
    return (
        <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <p>{message}</p>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={onRetry}
                >
                    {t("common.retry")}
                </Button>
            </AlertDescription>
        </Alert>
    );
}

function Field({
    id,
    label,
    children,
    className,
}: {
    id: string;
    label: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("space-y-1.5", className)}>
            <Label htmlFor={id}>{label}</Label>
            {children}
        </div>
    );
}

function ScheduleFields({
    idPrefix,
    interval,
    cooldown,
    onInterval,
    onCooldown,
}: {
    idPrefix: string;
    interval: number;
    cooldown: number;
    onInterval: (value: number) => void;
    onCooldown: (value: number) => void;
}) {
    const { t } = useLanguage();
    return (
        <Card asChild>
            <Disclosure onInvalidCapture={revealInvalidSchedule}>
                <DisclosureSummary
                    padded
                    className="flex items-center rounded-card"
                >
                    {t("monitors.schedule")}
                </DisclosureSummary>
                <div className="grid grid-cols-2 gap-3 px-4 pb-4">
                    <Field
                        id={`${idPrefix}-interval`}
                        label={t("monitors.interval")}
                    >
                        <Input
                            id={`${idPrefix}-interval`}
                            type="number"
                            min={15}
                            max={10080}
                            value={interval}
                            onChange={(event) =>
                                onInterval(Number(event.target.value))
                            }
                        />
                    </Field>
                    <Field
                        id={`${idPrefix}-cooldown`}
                        label={t("monitors.cooldown")}
                    >
                        <Input
                            id={`${idPrefix}-cooldown`}
                            type="number"
                            min={0}
                            max={10080}
                            value={cooldown}
                            onChange={(event) =>
                                onCooldown(Number(event.target.value))
                            }
                        />
                    </Field>
                </div>
            </Disclosure>
        </Card>
    );
}

function OperatorControl({
    value,
    onChange,
}: {
    value: MonitorOperator;
    onChange: (value: MonitorOperator) => void;
}) {
    const { t } = useLanguage();
    return (
        <SegmentedControl
            label={t("monitors.operator")}
            value={value}
            onValueChange={(next) => onChange(next as MonitorOperator)}
            className="w-full"
        >
            <SegmentedControlItem value="above">
                {t("monitors.above")}
            </SegmentedControlItem>
            <SegmentedControlItem value="below">
                {t("monitors.below")}
            </SegmentedControlItem>
        </SegmentedControl>
    );
}

function Observation({ item }: { item: MonitorObservation }) {
    const { t } = useLanguage();
    const reason = reasonLabel(item.reasonCode, item.reason, t);
    return (
        <li className="space-y-1 px-4 py-3 type-body">
            <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={item.status} />
                <span className="type-footnote text-label-secondary tabular-nums">
                    {dateTime(item.checkedAt)}
                </span>
            </div>
            {reason && <p>{reason}</p>}
            {(item.previousValue !== null || item.currentValue !== null) && (
                <p className="tabular-nums">
                    {t("monitors.valueChange", {
                        previous: item.previousValue ?? "—",
                        current: item.currentValue ?? "—",
                    })}
                </p>
            )}
            {(item.previousEvidenceVersion !== null ||
                item.currentEvidenceVersion !== null) && (
                <p className="tabular-nums">
                    {t("monitors.evidenceChange", {
                        previous: item.previousEvidenceVersion ?? "—",
                        current: item.currentEvidenceVersion ?? "—",
                    })}
                </p>
            )}
            {item.coverage?.status === "unknown" && (
                <p className="type-footnote text-label-secondary">
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
    const { confirm, ConfirmDialog } = useConfirmDialog();
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
    const hasTarget =
        form.kind === "analysis-threshold"
            ? Boolean(chosenAnalysis)
            : Boolean(form.dossierId);
    const duration = (minutes: number) =>
        minutes > 0 && minutes % 1440 === 0
            ? t("monitors.durationDays", { count: minutes / 1440 })
            : minutes > 0 && minutes % 60 === 0
              ? t("monitors.durationHours", { count: minutes / 60 })
              : t("monitors.durationMinutes", { count: minutes });
    const cadence = (interval: number, cooldown: number) =>
        t("monitors.scheduleSummary", {
            interval: duration(interval),
            cooldown: duration(cooldown),
        });
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
    const remove = (monitor: AnalysisMonitor) =>
        run(async () => {
            const accepted = await confirm({
                title: t("monitors.deleteTitle"),
                description: t("monitors.deleteConfirm"),
                confirmLabel: t("common.delete"),
                cancelLabel: t("common.cancel"),
                variant: "destructive",
            });
            if (!accepted) return;
            await actions.remove.mutateAsync(monitor.id);
            if (monitor.id === selectedId) setSelectedId(null);
            setNotice(t("monitors.deleted"));
        });
    const check = (monitor: AnalysisMonitor) =>
        run(async () => {
            const result = await actions.check.mutateAsync(monitor.id);
            setObservationOffset(0);
            setNotice(
                t("monitors.checkResult", {
                    status: t(`monitors.status.${result.status}`),
                }),
            );
        });
    const toggleEnabled = (monitor: AnalysisMonitor) =>
        run(async () => {
            await actions.update.mutateAsync({
                id: monitor.id,
                patch: { enabled: !monitor.enabled },
            });
            setNotice(t("monitors.saved"));
        });
    const markRead = (id: string) =>
        run(async () => {
            await actions.read.mutateAsync(id);
            setNotice(t("monitors.markedRead"));
        });

    const selectMonitor = (id: string) => {
        setSelectedId(id);
        setObservationOffset(0);
    };

    return (
        <PageShell>
            <PageHeader
                title={t("monitors.title")}
                subtitle={t("monitors.intro")}
                icon={PAGE_ICONS["/analysis/monitors"]}
            />
            {error && (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {notice && (
                <Alert>
                    <AlertDescription>{notice}</AlertDescription>
                </Alert>
            )}
            <div className="grid gap-6 xl:grid-cols-[minmax(19rem,23rem)_1fr]">
                <div className="space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("monitors.newRule")}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form
                                className="space-y-4"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void create();
                                }}
                            >
                                <SegmentedControl
                                    label={t("monitors.kind")}
                                    value={form.kind}
                                    onValueChange={(next) =>
                                        setForm({
                                            ...blank,
                                            kind: next as MonitorKind,
                                        })
                                    }
                                    className="w-full"
                                >
                                    <SegmentedControlItem value="analysis-threshold">
                                        {t("monitors.kind.threshold")}
                                    </SegmentedControlItem>
                                    <SegmentedControlItem value="dossier-evidence">
                                        {t("monitors.kind.evidence")}
                                    </SegmentedControlItem>
                                </SegmentedControl>
                                {form.kind === "analysis-threshold" ? (
                                    <>
                                        <div className="space-y-2">
                                            <Field
                                                id="monitor-analysis"
                                                label={t("monitors.analysis")}
                                            >
                                                <Select
                                                    value={form.savedAnalysisId}
                                                    onValueChange={(value) =>
                                                        setForm((current) => ({
                                                            ...current,
                                                            savedAnalysisId:
                                                                value,
                                                            fieldId: "",
                                                        }))
                                                    }
                                                >
                                                    <SelectTrigger id="monitor-analysis">
                                                        <SelectValue
                                                            placeholder={t(
                                                                "monitors.selectAnalysis",
                                                            )}
                                                        />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {eligible.map(
                                                            (analysis) => (
                                                                <SelectItem
                                                                    key={
                                                                        analysis.id
                                                                    }
                                                                    value={
                                                                        analysis.id
                                                                    }
                                                                >
                                                                    {
                                                                        analysis.name
                                                                    }
                                                                </SelectItem>
                                                            ),
                                                        )}
                                                    </SelectContent>
                                                </Select>
                                            </Field>
                                            {targets.analyses.isError && (
                                                <RetryAlert
                                                    message={t(
                                                        "monitors.targetsFailed",
                                                    )}
                                                    pending={
                                                        targets.analyses
                                                            .isFetching
                                                    }
                                                    onRetry={() =>
                                                        void targets.analyses.refetch()
                                                    }
                                                />
                                            )}
                                            {targets.analyses.isLoading && (
                                                <div
                                                    role="status"
                                                    aria-busy="true"
                                                    aria-label={t(
                                                        "monitors.analysis",
                                                    )}
                                                >
                                                    <span className="sr-only">
                                                        {t(
                                                            "monitors.targetsLoading",
                                                        )}
                                                    </span>
                                                    <Skeleton className="h-9 w-full rounded-control" />
                                                </div>
                                            )}
                                            {!targets.analyses.isLoading &&
                                                !targets.analyses.isError &&
                                                eligible.length === 0 && (
                                                    <Alert>
                                                        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                                                            <p>
                                                                {t(
                                                                    "monitors.noEligibleAnalyses",
                                                                )}
                                                            </p>
                                                            <Button
                                                                asChild
                                                                variant="outline"
                                                                size="sm"
                                                            >
                                                                <Link to="/analysis">
                                                                    {t(
                                                                        "monitors.openAnalysis",
                                                                    )}
                                                                </Link>
                                                            </Button>
                                                        </AlertDescription>
                                                    </Alert>
                                                )}
                                            <Disclosure className="type-footnote text-label-secondary">
                                                <DisclosureSummary tone="footnote">
                                                    {t(
                                                        "monitors.howAlertsWork",
                                                    )}
                                                </DisclosureSummary>
                                                <p className="pt-2">
                                                    {t("monitors.analysisHint")}
                                                </p>
                                            </Disclosure>
                                        </div>
                                        {chosenAnalysis && (
                                            <>
                                                <Field
                                                    id="monitor-field"
                                                    label={t("monitors.field")}
                                                >
                                                    <Select
                                                        value={form.fieldId}
                                                        onValueChange={(
                                                            value,
                                                        ) =>
                                                            setForm(
                                                                (current) => ({
                                                                    ...current,
                                                                    fieldId:
                                                                        value,
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        <SelectTrigger id="monitor-field">
                                                            <SelectValue
                                                                placeholder={t(
                                                                    "monitors.selectField",
                                                                )}
                                                            />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {columns.map(
                                                                (column) => (
                                                                    <SelectItem
                                                                        key={
                                                                            column.id
                                                                        }
                                                                        value={
                                                                            column.id
                                                                        }
                                                                    >
                                                                        {
                                                                            column.id
                                                                        }
                                                                    </SelectItem>
                                                                ),
                                                            )}
                                                        </SelectContent>
                                                    </Select>
                                                </Field>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <OperatorControl
                                                        value={form.operator}
                                                        onChange={(operator) =>
                                                            setForm(
                                                                (current) => ({
                                                                    ...current,
                                                                    operator,
                                                                }),
                                                            )
                                                        }
                                                    />
                                                    <Field
                                                        id="monitor-threshold"
                                                        label={t(
                                                            "monitors.threshold",
                                                        )}
                                                    >
                                                        <Input
                                                            id="monitor-threshold"
                                                            inputMode="decimal"
                                                            value={
                                                                form.threshold
                                                            }
                                                            onChange={(event) =>
                                                                setForm(
                                                                    (
                                                                        current,
                                                                    ) => ({
                                                                        ...current,
                                                                        threshold:
                                                                            event
                                                                                .target
                                                                                .value,
                                                                    }),
                                                                )
                                                            }
                                                        />
                                                    </Field>
                                                </div>
                                            </>
                                        )}
                                    </>
                                ) : (
                                    <div className="space-y-2">
                                        <Field
                                            id="monitor-dossier"
                                            label={t("monitors.dossier")}
                                        >
                                            <Select
                                                value={form.dossierId}
                                                onValueChange={(value) =>
                                                    setForm((current) => ({
                                                        ...current,
                                                        dossierId: value,
                                                    }))
                                                }
                                            >
                                                <SelectTrigger id="monitor-dossier">
                                                    <SelectValue
                                                        placeholder={t(
                                                            "monitors.selectDossier",
                                                        )}
                                                    />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {targets.dossiers.data?.items.map(
                                                        (dossier) => (
                                                            <SelectItem
                                                                key={dossier.id}
                                                                value={
                                                                    dossier.id
                                                                }
                                                            >
                                                                {dossier.title}
                                                            </SelectItem>
                                                        ),
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </Field>
                                        {targets.dossiers.isError && (
                                            <RetryAlert
                                                message={t(
                                                    "monitors.targetsFailed",
                                                )}
                                                pending={
                                                    targets.dossiers.isFetching
                                                }
                                                onRetry={() =>
                                                    void targets.dossiers.refetch()
                                                }
                                            />
                                        )}
                                        {targets.dossiers.isLoading && (
                                            <div
                                                role="status"
                                                aria-busy="true"
                                                aria-label={t(
                                                    "monitors.dossier",
                                                )}
                                            >
                                                <span className="sr-only">
                                                    {t(
                                                        "monitors.targetsLoading",
                                                    )}
                                                </span>
                                                <Skeleton className="h-9 w-full rounded-control" />
                                            </div>
                                        )}
                                        {!targets.dossiers.isLoading &&
                                            !targets.dossiers.isError &&
                                            targets.dossiers.data?.total ===
                                                0 && (
                                                <Alert>
                                                    <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                                                        <p>
                                                            {t(
                                                                "monitors.noDossiers",
                                                            )}
                                                        </p>
                                                        <Button
                                                            asChild
                                                            variant="outline"
                                                            size="sm"
                                                        >
                                                            <Link to="/research/dossiers">
                                                                {t(
                                                                    "monitors.openDossiers",
                                                                )}
                                                            </Link>
                                                        </Button>
                                                    </AlertDescription>
                                                </Alert>
                                            )}
                                        {(targets.dossiers.data?.total ?? 0) >
                                            TARGET_PAGE_SIZE && (
                                            <Pager
                                                offset={targetDossierOffset}
                                                total={
                                                    targets.dossiers.data!.total
                                                }
                                                pageSize={TARGET_PAGE_SIZE}
                                                onChange={(offset) => {
                                                    setTargetDossierOffset(
                                                        offset,
                                                    );
                                                    setForm((current) => ({
                                                        ...current,
                                                        dossierId: "",
                                                    }));
                                                }}
                                            />
                                        )}
                                    </div>
                                )}
                                {hasTarget && (
                                    <>
                                        <Field
                                            id="monitor-title"
                                            label={t("monitors.ruleTitle")}
                                        >
                                            <Input
                                                id="monitor-title"
                                                required
                                                value={form.title}
                                                onChange={(event) =>
                                                    setForm((current) => ({
                                                        ...current,
                                                        title: event.target
                                                            .value,
                                                    }))
                                                }
                                            />
                                        </Field>
                                        <p className="type-footnote text-label-secondary">
                                            {t("monitors.baselineHint")}
                                        </p>
                                        <ScheduleFields
                                            idPrefix="monitor"
                                            interval={form.intervalMinutes}
                                            cooldown={form.cooldownMinutes}
                                            onInterval={(intervalMinutes) =>
                                                setForm((current) => ({
                                                    ...current,
                                                    intervalMinutes,
                                                }))
                                            }
                                            onCooldown={(cooldownMinutes) =>
                                                setForm((current) => ({
                                                    ...current,
                                                    cooldownMinutes,
                                                }))
                                            }
                                        />
                                        <p className="type-footnote text-label-secondary">
                                            {cadence(
                                                form.intervalMinutes,
                                                form.cooldownMinutes,
                                            )}
                                        </p>
                                        <Button type="submit" disabled={busy}>
                                            <Plus className="mr-2 size-4" />
                                            {t("monitors.create")}
                                        </Button>
                                    </>
                                )}
                            </form>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("monitors.rules")}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {monitors.isLoading && (
                                <LoadingRows label={t("monitors.rules")} />
                            )}
                            {monitors.isError && (
                                <RetryAlert
                                    message={t("monitors.loadFailed")}
                                    pending={monitors.isFetching}
                                    onRetry={() => void monitors.refetch()}
                                />
                            )}
                            {!monitors.isLoading &&
                                !monitors.isError &&
                                !monitors.data?.items.length && (
                                    <EmptyState
                                        size="compact"
                                        headingLevel={3}
                                        icon={ListChecks}
                                        title={t("monitors.empty")}
                                    />
                                )}
                            {monitors.data &&
                                monitors.data.items.length > 0 && (
                                    <List>
                                        {monitors.data.items.map((monitor) => {
                                            const active =
                                                monitor.id === selectedId;
                                            return (
                                                <ListRow
                                                    key={monitor.id}
                                                    selected={active}
                                                    title={monitor.title}
                                                    subtitle={
                                                        <>
                                                            {
                                                                monitor.targetLabel
                                                            }{" "}
                                                            ·{" "}
                                                            {t(
                                                                `monitors.status.${monitor.lastStatus ?? "never"}`,
                                                            )}{" "}
                                                            ·{" "}
                                                            {monitor.enabled
                                                                ? t(
                                                                      "monitors.enabled",
                                                                  )
                                                                : t(
                                                                      "monitors.disabled",
                                                                  )}
                                                        </>
                                                    }
                                                    onActivate={() =>
                                                        selectMonitor(
                                                            monitor.id,
                                                        )
                                                    }
                                                    actions={
                                                        <RowMenu
                                                            label={t(
                                                                "monitors.rowMenu",
                                                                {
                                                                    name: monitor.title,
                                                                },
                                                            )}
                                                            disabled={busy}
                                                        >
                                                            <DropdownMenuItem
                                                                onSelect={() =>
                                                                    void check(
                                                                        monitor,
                                                                    )
                                                                }
                                                            >
                                                                <Play
                                                                    className="mr-2 h-4 w-4 text-label-secondary"
                                                                    aria-hidden="true"
                                                                />
                                                                {t(
                                                                    "monitors.checkNow",
                                                                )}
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem
                                                                onSelect={() =>
                                                                    void toggleEnabled(
                                                                        monitor,
                                                                    )
                                                                }
                                                            >
                                                                {monitor.enabled ? (
                                                                    <Pause
                                                                        className="mr-2 h-4 w-4 text-label-secondary"
                                                                        aria-hidden="true"
                                                                    />
                                                                ) : (
                                                                    <Play
                                                                        className="mr-2 h-4 w-4 text-label-secondary"
                                                                        aria-hidden="true"
                                                                    />
                                                                )}
                                                                {monitor.enabled
                                                                    ? t(
                                                                          "monitors.disable",
                                                                      )
                                                                    : t(
                                                                          "monitors.enable",
                                                                      )}
                                                            </DropdownMenuItem>
                                                            <DropdownMenuSeparator />
                                                            <DropdownMenuItem
                                                                variant="destructive"
                                                                onSelect={() =>
                                                                    void remove(
                                                                        monitor,
                                                                    )
                                                                }
                                                            >
                                                                <Trash2
                                                                    className="mr-2 h-4 w-4"
                                                                    aria-hidden="true"
                                                                />
                                                                {t(
                                                                    "monitors.delete",
                                                                )}
                                                            </DropdownMenuItem>
                                                        </RowMenu>
                                                    }
                                                />
                                            );
                                        })}
                                    </List>
                                )}
                            {monitors.data &&
                                monitors.data.total > PAGE_SIZE && (
                                    <Pager
                                        offset={monitorOffset}
                                        total={monitors.data.total}
                                        pageSize={PAGE_SIZE}
                                        onChange={setMonitorOffset}
                                    />
                                )}
                        </CardContent>
                    </Card>
                </div>
                <div className="space-y-6">
                    {selected && edit && (
                        <Card>
                            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
                                <div className="space-y-1.5">
                                    <CardTitle variant="sm">
                                        {t("monitors.ruleDetails")}
                                    </CardTitle>
                                    <CardDescription>
                                        {t(
                                            `monitors.kind.${selected.kind === "analysis-threshold" ? "threshold" : "evidence"}`,
                                        )}{" "}
                                        · {selected.targetLabel}
                                    </CardDescription>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => void check(selected)}
                                    >
                                        <Play className="mr-2 size-4" />
                                        {t("monitors.checkNow")}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => void remove(selected)}
                                        className="text-destructive hover:text-destructive"
                                    >
                                        <Trash2 className="mr-2 size-4" />
                                        {t("monitors.delete")}
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <form
                                    className="space-y-4"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void save();
                                    }}
                                >
                                    <Field
                                        id="edit-title"
                                        label={t("monitors.ruleTitle")}
                                    >
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
                                    </Field>
                                    <div className="flex items-center justify-between gap-3 rounded-card corner-continuous border border-border/60 px-4 py-2.5">
                                        <Label htmlFor="edit-enabled">
                                            {t("monitors.enabled")}
                                        </Label>
                                        <Switch
                                            id="edit-enabled"
                                            checked={edit.enabled ?? false}
                                            onCheckedChange={(enabled) =>
                                                setEdit((current) => ({
                                                    ...current,
                                                    enabled,
                                                }))
                                            }
                                        />
                                    </div>
                                    {selected.kind === "analysis-threshold" && (
                                        <>
                                            <Field
                                                id="edit-field"
                                                label={t("monitors.field")}
                                            >
                                                <Select
                                                    value={edit.fieldId ?? ""}
                                                    onValueChange={(value) =>
                                                        setEdit((current) => ({
                                                            ...current,
                                                            fieldId: value,
                                                        }))
                                                    }
                                                >
                                                    <SelectTrigger id="edit-field">
                                                        <SelectValue
                                                            placeholder={t(
                                                                "monitors.selectField",
                                                            )}
                                                        />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {editColumns.map(
                                                            (column) => (
                                                                <SelectItem
                                                                    key={
                                                                        column.id
                                                                    }
                                                                    value={
                                                                        column.id
                                                                    }
                                                                >
                                                                    {column.id}
                                                                </SelectItem>
                                                            ),
                                                        )}
                                                        {edit.fieldId &&
                                                            !editColumns.some(
                                                                (column) =>
                                                                    column.id ===
                                                                    edit.fieldId,
                                                            ) && (
                                                                <SelectItem
                                                                    value={
                                                                        edit.fieldId
                                                                    }
                                                                >
                                                                    {
                                                                        edit.fieldId
                                                                    }
                                                                </SelectItem>
                                                            )}
                                                    </SelectContent>
                                                </Select>
                                            </Field>
                                            <div className="grid grid-cols-2 gap-3">
                                                <OperatorControl
                                                    value={
                                                        edit.operator ?? "above"
                                                    }
                                                    onChange={(operator) =>
                                                        setEdit((current) => ({
                                                            ...current,
                                                            operator,
                                                        }))
                                                    }
                                                />
                                                <Field
                                                    id="edit-threshold"
                                                    label={t(
                                                        "monitors.threshold",
                                                    )}
                                                >
                                                    <Input
                                                        id="edit-threshold"
                                                        inputMode="decimal"
                                                        value={
                                                            edit.threshold ?? ""
                                                        }
                                                        onChange={(event) =>
                                                            setEdit(
                                                                (current) => ({
                                                                    ...current,
                                                                    threshold:
                                                                        event
                                                                            .target
                                                                            .value,
                                                                }),
                                                            )
                                                        }
                                                    />
                                                </Field>
                                            </div>
                                        </>
                                    )}
                                    <ScheduleFields
                                        idPrefix="edit"
                                        interval={edit.intervalMinutes ?? 1440}
                                        cooldown={edit.cooldownMinutes ?? 1440}
                                        onInterval={(intervalMinutes) =>
                                            setEdit((current) => ({
                                                ...current,
                                                intervalMinutes,
                                            }))
                                        }
                                        onCooldown={(cooldownMinutes) =>
                                            setEdit((current) => ({
                                                ...current,
                                                cooldownMinutes,
                                            }))
                                        }
                                    />
                                    <p className="type-footnote text-label-secondary">
                                        {cadence(
                                            edit.intervalMinutes ?? 1440,
                                            edit.cooldownMinutes ?? 1440,
                                        )}
                                    </p>
                                    <Button type="submit" disabled={busy}>
                                        <Save className="mr-2 size-4" />
                                        {t("monitors.save")}
                                    </Button>
                                </form>
                                <dl className="grid gap-x-6 gap-y-2 type-footnote md:grid-cols-3">
                                    <div>
                                        <dt className="text-label-secondary">
                                            {t("monitors.nextDue")}
                                        </dt>
                                        <dd className="tabular-nums">
                                            {dateTime(selected.nextDueAt)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-label-secondary">
                                            {t("monitors.lastChecked")}
                                        </dt>
                                        <dd className="tabular-nums">
                                            {dateTime(selected.lastCheckedAt)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-label-secondary">
                                            {t("monitors.lastStatus")}
                                        </dt>
                                        <dd>
                                            <StatusBadge
                                                status={selected.lastStatus}
                                            />
                                        </dd>
                                    </div>
                                </dl>
                                {selected.lastObservation && (
                                    <List>
                                        <Observation
                                            item={selected.lastObservation}
                                        />
                                    </List>
                                )}
                            </CardContent>
                        </Card>
                    )}
                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("monitors.observations")}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {selectedId ? (
                                <>
                                    {observations.isLoading && (
                                        <LoadingRows
                                            label={t("monitors.observations")}
                                        />
                                    )}
                                    {observations.isError && (
                                        <RetryAlert
                                            message={t(
                                                "monitors.observationsFailed",
                                            )}
                                            pending={observations.isFetching}
                                            onRetry={() =>
                                                void observations.refetch()
                                            }
                                        />
                                    )}
                                    {!observations.isError &&
                                        observations.data &&
                                        !observations.data.items.length && (
                                            <EmptyState
                                                size="compact"
                                                headingLevel={3}
                                                icon={Activity}
                                                title={t(
                                                    "monitors.noObservations",
                                                )}
                                            />
                                        )}
                                    {observations.data &&
                                        observations.data.items.length > 0 && (
                                            <List>
                                                {observations.data.items.map(
                                                    (item) => (
                                                        <Observation
                                                            key={item.id}
                                                            item={item}
                                                        />
                                                    ),
                                                )}
                                            </List>
                                        )}
                                    {!observations.isError &&
                                        observations.data &&
                                        observations.data.total > PAGE_SIZE && (
                                            <Pager
                                                offset={observationOffset}
                                                total={observations.data.total}
                                                pageSize={PAGE_SIZE}
                                                onChange={setObservationOffset}
                                                showRange={false}
                                            />
                                        )}
                                </>
                            ) : (
                                <EmptyState
                                    size="compact"
                                    headingLevel={3}
                                    icon={Activity}
                                    title={t("monitors.selectRule")}
                                />
                            )}
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("monitors.inbox")}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {notifications.isLoading && (
                                <LoadingRows label={t("monitors.inbox")} />
                            )}
                            {notifications.isError && (
                                <RetryAlert
                                    message={t("monitors.inboxFailed")}
                                    pending={notifications.isFetching}
                                    onRetry={() => void notifications.refetch()}
                                />
                            )}
                            {!notifications.isError &&
                                notifications.data &&
                                !notifications.data.items.length && (
                                    <EmptyState
                                        size="compact"
                                        headingLevel={3}
                                        icon={Bell}
                                        title={t("monitors.noNotifications")}
                                    />
                                )}
                            {notifications.data &&
                                notifications.data.items.length > 0 && (
                                    <List>
                                        {notifications.data.items.map(
                                            (item) => {
                                                const unread = !item.readAt;
                                                return (
                                                    <ListRow
                                                        key={item.id}
                                                        className={cn(
                                                            unread &&
                                                                "bg-primary/[0.04]",
                                                        )}
                                                        leading={
                                                            <span
                                                                aria-hidden={
                                                                    unread
                                                                        ? undefined
                                                                        : "true"
                                                                }
                                                                role={
                                                                    unread
                                                                        ? "img"
                                                                        : undefined
                                                                }
                                                                aria-label={
                                                                    unread
                                                                        ? t(
                                                                              "monitors.unread",
                                                                          )
                                                                        : undefined
                                                                }
                                                                className={cn(
                                                                    "inline-flex h-2 w-2 shrink-0 rounded-full",
                                                                    unread
                                                                        ? "bg-primary"
                                                                        : "bg-transparent",
                                                                )}
                                                            />
                                                        }
                                                        title={
                                                            <span
                                                                className={cn(
                                                                    "flex flex-wrap items-baseline gap-x-2",
                                                                    unread &&
                                                                        "font-medium",
                                                                )}
                                                            >
                                                                <span className="truncate">
                                                                    {item.title}
                                                                </span>
                                                                <span className="type-footnote font-normal text-label-secondary tabular-nums">
                                                                    {dateTime(
                                                                        item.createdAt,
                                                                    )}
                                                                </span>
                                                            </span>
                                                        }
                                                        subtitle={
                                                            <span className="block whitespace-normal type-body text-foreground">
                                                                {reasonLabel(
                                                                    item.reasonCode,
                                                                    item.reason,
                                                                    t,
                                                                ) ??
                                                                    t(
                                                                        "monitors.notificationReasonUnknown",
                                                                    )}
                                                                {(item.previousValue !==
                                                                    null ||
                                                                    item.currentValue !==
                                                                        null) && (
                                                                    <span className="block type-footnote text-label-secondary tabular-nums">
                                                                        {t(
                                                                            "monitors.valueChange",
                                                                            {
                                                                                previous:
                                                                                    item.previousValue ??
                                                                                    "—",
                                                                                current:
                                                                                    item.currentValue ??
                                                                                    "—",
                                                                            },
                                                                        )}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        }
                                                        actions={
                                                            unread && (
                                                                <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="sm"
                                                                    disabled={
                                                                        busy
                                                                    }
                                                                    onClick={() =>
                                                                        void markRead(
                                                                            item.id,
                                                                        )
                                                                    }
                                                                >
                                                                    {t(
                                                                        "monitors.markRead",
                                                                    )}
                                                                </Button>
                                                            )
                                                        }
                                                    />
                                                );
                                            },
                                        )}
                                    </List>
                                )}
                            {!notifications.isError &&
                                notifications.data &&
                                notifications.data.total > PAGE_SIZE && (
                                    <Pager
                                        offset={notificationOffset}
                                        total={notifications.data.total}
                                        pageSize={PAGE_SIZE}
                                        onChange={setNotificationOffset}
                                        showRange={false}
                                    />
                                )}
                        </CardContent>
                    </Card>
                </div>
            </div>
            <ConfirmDialog />
        </PageShell>
    );
}
