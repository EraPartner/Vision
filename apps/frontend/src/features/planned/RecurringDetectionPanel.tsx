import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { List } from "@/components/ui/list";
import {
    Repeat,
    AlertTriangle,
    CheckCircle2,
    TrendingUp,
    TrendingDown,
    Calendar,
    Sparkles,
    ChevronDown,
    ChevronUp,
    Plus,
    X,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { cn } from "@/lib/utils";
import { SectionLoader } from "@/components/shared/SectionLoader";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { useRecurringPatterns } from "@/hooks/usePlannedMatchSuggestions";
import { useCategoryTree } from "@/hooks/useCategories";

const DISMISSED_PATTERNS_STORAGE_KEY = "dismissed_recurring_patterns";

function safeDateLabel(
    value: string,
    appDateFormat: string,
    t: (key: string) => string,
): string {
    if (!value || typeof value !== "string") return t("common.unknownDate");
    return formatDateStringWithAppSettings(value, appDateFormat);
}

type RecurringPattern = Awaited<
    ReturnType<typeof apiClient.getRecurringPatterns>
>["patterns"][number];

interface Props {
    onCreatePlanned?: (pattern: RecurringPattern) => void;
}

export function RecurringDetectionPanel({ onCreatePlanned }: Props) {
    const formatPercent = usePercentFormatter();
    const formatCurrency = useCurrencyFormatter();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: categoryTree } = useCategoryTree();
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(false);
    const [amountAlertsExpanded, setAmountAlertsExpanded] = useState(false);
    const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
    const [dismissedLoaded, setDismissedLoaded] = useState(false);

    const PATTERN_LABELS: Record<string, string> = {
        weekly: t("recurring.pattern.weekly"),
        biweekly: t("recurring.pattern.biweekly"),
        monthly: t("recurring.pattern.monthly"),
        quarterly: t("recurring.pattern.quarterly"),
        yearly: t("recurring.pattern.yearly"),
        custom: t("recurring.pattern.custom"),
    };

    const loadDismissedFromLocalStorage = () => {
        try {
            const raw = window.localStorage.getItem(
                DISMISSED_PATTERNS_STORAGE_KEY,
            );
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((v) => Number(v))
                    .filter((v) => Number.isInteger(v) && v > 0);
            }
            return [];
        } catch {
            // Ignore invalid localStorage payloads.
            return [];
        }
    };

    const persistDismissedToLocalStorage = (values: Set<number>) => {
        try {
            window.localStorage.setItem(
                DISMISSED_PATTERNS_STORAGE_KEY,
                JSON.stringify([...values]),
            );
        } catch {
            // Ignore storage write failures.
        }
    };

    const persistDismissed = (values: Set<number>) => {
        setDismissedIds(values);
        persistDismissedToLocalStorage(values);
        void apiClient
            .saveSetting(DISMISSED_PATTERNS_STORAGE_KEY, [...values])
            .catch(() => {
                // Keep local fallback even if backend settings save fails.
            });
    };

    useEffect(() => {
        let cancelled = false;

        const loadDismissed = async () => {
            const localValues = loadDismissedFromLocalStorage();

            try {
                const setting = await apiClient.getSetting(
                    DISMISSED_PATTERNS_STORAGE_KEY,
                );
                const settingValues = Array.isArray(setting?.value)
                    ? setting.value
                          .map((v) => Number(v))
                          .filter((v) => Number.isInteger(v) && v > 0)
                    : [];

                const merged = new Set<number>([
                    ...localValues,
                    ...settingValues,
                ]);

                if (!cancelled) {
                    setDismissedIds(merged);
                    persistDismissedToLocalStorage(merged);
                    setDismissedLoaded(true);
                }
                return;
            } catch {
                // Fallback to local storage only.
            }

            if (!cancelled) {
                setDismissedIds(new Set(localValues));
                setDismissedLoaded(true);
            }
        };

        void loadDismissed();

        return () => {
            cancelled = true;
        };
    }, []);

    const { data, isLoading, error } = useRecurringPatterns();

    const dismiss = (recipientId: number) => {
        const next = new Set(dismissedIds);
        next.add(recipientId);
        persistDismissed(next);
    };

    const handleCreatePlanned = async (pattern: RecurringPattern) => {
        if (onCreatePlanned) {
            onCreatePlanned(pattern);
            return;
        }

        try {
            await apiClient.createPlannedTransaction({
                planned_date: pattern.predictedNext,
                recipient_id: pattern.recipientId,
                memo: t("recurring.autoDetectedMemo", {
                    name: pattern.recipientName,
                }),
                // Detected amounts are .abs()'d server-side; the pattern's
                // `direction` carries the dominant sign of the source
                // transactions. Planned sign convention: money out negative,
                // money in positive — hardcoding the expense sign here turned a
                // detected salary into a negative planned payment that
                // plannedMatchService could never auto-match (sign mismatch).
                amount:
                    pattern.direction === "income"
                        ? Math.abs(pattern.latestAmount)
                        : -Math.abs(pattern.latestAmount),
                currency: pattern.currency,
                category_id: pattern.categoryId ?? undefined,
                account_id: pattern.accountId!,
                is_recurring: true,
                recurrence_pattern:
                    pattern.detectedPattern === "custom"
                        ? `every ${pattern.intervalDays} days`
                        : pattern.detectedPattern,
            });
            queryClient.invalidateQueries({
                queryKey: plannedKeys.recurringPatterns,
            });
            queryClient.invalidateQueries({
                queryKey: plannedKeys.transactionsAll,
            });
            queryClient.invalidateQueries({
                queryKey: plannedKeys.upcomingAll,
            });
            queryClient.invalidateQueries({
                queryKey: plannedKeys.accountTransactionsAll,
            });
            toast.success(
                t("recurring.toast.created", { name: pattern.recipientName }),
            );
        } catch (err: unknown) {
            toast.error(
                t("recurring.toast.failed", { msg: apiErrorToMessage(err, t) }),
            );
        }
    };

    const patterns = (data?.patterns ?? []).filter(
        (p) => !p.isAlreadyPlanned && !dismissedIds.has(p.recipientId),
    );

    const amountAlerts = (data?.patterns ?? []).filter(
        (p) => p.amountChanges.length > 0 && !dismissedIds.has(p.recipientId),
    );

    if (!dismissedLoaded) {
        return null;
    }

    if (isLoading) {
        return (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle
                        variant="label"
                        className="flex items-center gap-2"
                    >
                        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                        {t("recurring.loading")}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <SectionLoader />
                </CardContent>
            </Card>
        );
    }

    if (error || !data) return null;

    if (patterns.length === 0 && amountAlerts.length === 0) {
        return (
            <p
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 type-body text-label-secondary"
                role="status"
            >
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t("recurring.allCaughtUp")}</span>
                <span className="type-footnote">{t("recurring.noPatterns")}</span>
            </p>
        );
    }

    return (
        <div className="space-y-4">
            {/* Amount Change Alerts */}
            {amountAlerts.length > 0 && (
                <Card className="border-warning/40 bg-warning/5">
                    <CardHeader className="p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <CardTitle
                                    variant="label"
                                    className="flex items-center gap-2 text-warning"
                                >
                                    <AlertTriangle
                                        className="h-4 w-4"
                                        aria-hidden
                                    />
                                    {t("recurring.amountChanges")}
                                    <Badge
                                        variant="outline"
                                        className="ml-1 border-warning/40 text-warning"
                                    >
                                        {amountAlerts.length}
                                    </Badge>
                                </CardTitle>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                aria-label={`${t(amountAlertsExpanded ? "recurring.hide" : "recurring.review")}: ${t("recurring.amountChanges")}`}
                                aria-expanded={amountAlertsExpanded}
                                onClick={() =>
                                    setAmountAlertsExpanded((value) => !value)
                                }
                            >
                                {t(
                                    amountAlertsExpanded
                                        ? "recurring.hide"
                                        : "recurring.review",
                                )}
                                {amountAlertsExpanded ? (
                                    <ChevronUp
                                        className="mt-0.5 h-4 w-4 shrink-0"
                                        aria-hidden
                                    />
                                ) : (
                                    <ChevronDown
                                        className="mt-0.5 h-4 w-4 shrink-0"
                                        aria-hidden
                                    />
                                )}
                            </Button>
                        </div>
                    </CardHeader>
                    {amountAlertsExpanded && (
                        <CardContent className="px-4 pb-4">
                            <p className="mb-3 type-body text-label-secondary">
                                {t("recurring.amountChangesDesc")}
                            </p>
                            <List>
                                {amountAlerts.slice(0, 5).map((pattern) => {
                                    const lastChange =
                                        pattern.amountChanges[
                                            pattern.amountChanges.length - 1
                                        ];
                                    return (
                                        <li
                                            key={`alert-${pattern.recipientId}-${pattern.direction}`}
                                            className="flex items-center justify-between gap-3 px-4 py-3"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate type-headline text-foreground">
                                                    {pattern.recipientName}
                                                </p>
                                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                                    <span className="type-footnote text-label-secondary line-through">
                                                        {formatCurrency(
                                                            lastChange.previousAmount,
                                                            {
                                                                currency:
                                                                    pattern.currency,
                                                            },
                                                        )}
                                                    </span>
                                                    <span className="type-footnote text-label-tertiary">
                                                        →
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "type-footnote font-medium",
                                                            lastChange.direction ===
                                                                "increased"
                                                                ? "text-loss"
                                                                : "text-gain",
                                                        )}
                                                    >
                                                        {formatCurrency(
                                                            lastChange.newAmount,
                                                            {
                                                                currency:
                                                                    pattern.currency,
                                                            },
                                                        )}
                                                    </span>
                                                    <Badge
                                                        variant="outline"
                                                        size="sm"
                                                        className={cn(
                                                            lastChange.direction ===
                                                                "increased"
                                                                ? "text-loss border-loss/30"
                                                                : "text-gain border-gain/30",
                                                        )}
                                                    >
                                                        {lastChange.direction ===
                                                        "increased" ? (
                                                            <TrendingUp
                                                                className="mr-1 h-3 w-3"
                                                                aria-hidden
                                                            />
                                                        ) : (
                                                            <TrendingDown
                                                                className="mr-1 h-3 w-3"
                                                                aria-hidden
                                                            />
                                                        )}
                                                        {formatPercent(
                                                            lastChange.percentChange,
                                                            {
                                                                digits: 1,
                                                                signed: true,
                                                            },
                                                        )}
                                                    </Badge>
                                                </div>
                                                <p className="mt-1 type-footnote text-label-secondary">
                                                    {t("recurring.changedOn", {
                                                        date: safeDateLabel(
                                                            lastChange.date,
                                                            appSettings.dateFormat,
                                                            t,
                                                        ),
                                                    })}
                                                </p>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="icon-touch-target shrink-0 text-label-secondary hover:text-foreground"
                                                aria-label={t("aria.dismiss")}
                                                onClick={() =>
                                                    dismiss(pattern.recipientId)
                                                }
                                            >
                                                <X className="h-3.5 w-3.5" aria-hidden />
                                            </Button>
                                        </li>
                                    );
                                })}
                            </List>
                        </CardContent>
                    )}
                </Card>
            )}

            {/* Suggested Recurring Patterns */}
            {patterns.length > 0 && (
                <Card>
                    <CardHeader className="p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle
                                    variant="label"
                                    className="flex items-center gap-2"
                                >
                                    <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                                    {t("recurring.patterns")}
                                    <Badge variant="secondary" className="ml-1">
                                        {patterns.length}
                                    </Badge>
                                </CardTitle>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                aria-label={`${t(expanded ? "recurring.hide" : "recurring.review")}: ${t("recurring.patterns")}`}
                                aria-expanded={expanded}
                                onClick={() => setExpanded(!expanded)}
                            >
                                {t(
                                    expanded
                                        ? "recurring.hide"
                                        : "recurring.review",
                                )}
                                {expanded ? (
                                    <ChevronUp className="h-4 w-4" aria-hidden />
                                ) : (
                                    <ChevronDown className="h-4 w-4" aria-hidden />
                                )}
                            </Button>
                        </div>
                    </CardHeader>
                    {expanded && (
                        <CardContent className="px-4 pb-4">
                            <p className="mb-3 type-body text-label-secondary">
                                {t("recurring.patternsDesc")}
                            </p>
                            <List>
                                {patterns.map((pattern) => (
                                    <li
                                        key={`${pattern.recipientId}-${pattern.direction}`}
                                        className="flex items-center gap-3 px-4 py-3"
                                    >
                                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-primary/10">
                                            <Repeat
                                                className="h-4 w-4 text-primary"
                                                aria-hidden
                                            />
                                        </div>

                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <p className="truncate type-headline text-foreground">
                                                    {pattern.recipientName}
                                                </p>
                                                <ConfidenceBadge
                                                    confidence={
                                                        pattern.confidence
                                                    }
                                                    t={t}
                                                />
                                            </div>
                                            <div className="mt-0.5 flex flex-wrap items-center gap-2">
                                                <Badge variant="outline" size="sm">
                                                    {PATTERN_LABELS[
                                                        pattern.detectedPattern
                                                    ] ||
                                                        pattern.detectedPattern}
                                                </Badge>
                                                {pattern.categoryName && (
                                                    <span className="type-footnote text-label-secondary">
                                                        {categoryTree?.items.find(
                                                            (node) =>
                                                                node.id ===
                                                                pattern.categoryId,
                                                        )?.name ??
                                                            pattern.categoryName}
                                                    </span>
                                                )}
                                                <span className="type-footnote text-label-secondary">
                                                    · {pattern.occurrences}
                                                    {t("recurring.seen")}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-1 type-footnote text-label-secondary">
                                                <Calendar
                                                    className="h-3 w-3"
                                                    aria-hidden
                                                />
                                                {t("recurring.nextExpected", {
                                                    date: safeDateLabel(
                                                        pattern.predictedNext,
                                                        appSettings.dateFormat,
                                                        t,
                                                    ),
                                                })}
                                            </div>
                                        </div>

                                        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
                                            <span className="type-headline tabular-nums text-foreground">
                                                {formatCurrency(
                                                    pattern.latestAmount,
                                                    {
                                                        currency:
                                                            pattern.currency,
                                                    },
                                                )}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    size="sm"
                                                    variant="default"
                                                    className="gap-1"
                                                    onClick={() =>
                                                        handleCreatePlanned(
                                                            pattern,
                                                        )
                                                    }
                                                >
                                                    <Plus className="h-3 w-3" aria-hidden />
                                                    {t("recurring.track")}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-label-secondary"
                                                    onClick={() =>
                                                        dismiss(
                                                            pattern.recipientId,
                                                        )
                                                    }
                                                >
                                                    {t("recurring.dismissBtn")}
                                                </Button>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </List>
                        </CardContent>
                    )}
                </Card>
            )}
        </div>
    );
}

function ConfidenceBadge({
    confidence,
    t,
}: {
    confidence: number;
    t: (key: string) => string;
}) {
    let variant: "outline" | "success" | "warning" = "outline";
    let label = t("recurring.confidence.low");

    if (confidence >= 80) {
        variant = "success";
        label = t("recurring.confidence.high");
    } else if (confidence >= 60) {
        variant = "warning";
        label = t("recurring.confidence.medium");
    }

    return (
        <Badge variant={variant} size="sm">
            {confidence}% {label}
        </Badge>
    );
}
