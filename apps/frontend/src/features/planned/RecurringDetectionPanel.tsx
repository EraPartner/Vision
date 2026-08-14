import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import { formatCurrency, formatPercent } from "@/utils/currency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Repeat, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown,
    Calendar, Sparkles, ChevronDown, ChevronUp, Plus, X,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { cn } from "@/lib/utils";
import { SectionLoader } from "@/components/shared/SectionLoader";

const DISMISSED_PATTERNS_STORAGE_KEY = "dismissed_recurring_patterns";

function safeDateLabel(value: string, appDateFormat: string, t: (key: string) => string): string {
    if (!value || typeof value !== "string") return t('common.unknownDate');
    return formatDateStringWithAppSettings(value, appDateFormat);
}

type RecurringPattern = Awaited<ReturnType<typeof apiClient.getRecurringPatterns>>["patterns"][number];

interface Props {
    onCreatePlanned?: (pattern: RecurringPattern) => void;
}

export function RecurringDetectionPanel({ onCreatePlanned }: Props) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(true);
    const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
    const [dismissedLoaded, setDismissedLoaded] = useState(false);

    const PATTERN_LABELS: Record<string, string> = {
        weekly: t('recurring.pattern.weekly'),
        biweekly: t('recurring.pattern.biweekly'),
        monthly: t('recurring.pattern.monthly'),
        quarterly: t('recurring.pattern.quarterly'),
        yearly: t('recurring.pattern.yearly'),
        custom: t('recurring.pattern.custom'),
    };

    const loadDismissedFromLocalStorage = () => {
        try {
            const raw = window.localStorage.getItem(DISMISSED_PATTERNS_STORAGE_KEY);
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
            window.localStorage.setItem(DISMISSED_PATTERNS_STORAGE_KEY, JSON.stringify([...values]));
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
                const setting = await apiClient.getSetting(DISMISSED_PATTERNS_STORAGE_KEY);
                const settingValues = Array.isArray(setting?.value)
                    ? setting.value
                        .map((v) => Number(v))
                        .filter((v) => Number.isInteger(v) && v > 0)
                    : [];

                const merged = new Set<number>([...localValues, ...settingValues]);

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

    const { data, isLoading, error } = useQuery({
        queryKey: plannedKeys.recurringPatterns,
        queryFn: () => apiClient.getRecurringPatterns(),
        staleTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });

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
                memo: t('recurring.autoDetectedMemo', { name: pattern.recipientName }),
                // Detected amounts are .abs()'d server-side; the pattern's
                // `direction` carries the dominant sign of the source
                // transactions. Planned sign convention: money out negative,
                // money in positive — hardcoding the expense sign here turned a
                // detected salary into a negative planned payment that
                // plannedMatchService could never auto-match (sign mismatch).
                amount: pattern.direction === "income"
                    ? Math.abs(pattern.latestAmount)
                    : -Math.abs(pattern.latestAmount),
                currency: pattern.currency,
                category_id: pattern.categoryId ?? undefined,
                bank_account: pattern.bankAccount ?? undefined,
                is_recurring: true,
                recurrence_pattern: pattern.detectedPattern === "custom"
                    ? `every ${pattern.intervalDays} days`
                    : pattern.detectedPattern,
            });
            queryClient.invalidateQueries({ queryKey: plannedKeys.recurringPatterns });
            queryClient.invalidateQueries({ queryKey: plannedKeys.transactionsAll });
            toast.success(t('recurring.toast.created', { name: pattern.recipientName }));
        } catch (err: unknown) {
            toast.error(t('recurring.toast.failed', { msg: apiErrorToMessage(err, t) }));
        }
    };

    const patterns = (data?.patterns ?? []).filter(
        (p) => !p.isAlreadyPlanned && !dismissedIds.has(p.recipientId)
    );

    const amountAlerts = (data?.patterns ?? []).filter(
        (p) => p.amountChanges.length > 0 && !dismissedIds.has(p.recipientId)
    );

    if (!dismissedLoaded) {
        return null;
    }

    if (isLoading) {
        return (
            <Card className="glass-regular">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t('recurring.loading')}
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
            <Card className="!border-dashed">
                <CardContent className="flex items-center gap-3 py-4">
                    <CheckCircle2 className="h-5 w-5 text-accent shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-foreground">{t('recurring.allCaughtUp')}</p>
                        <p className="text-xs text-muted-foreground">
                            {t('recurring.noPatterns')}
                        </p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            {/* Amount Change Alerts */}
            {amountAlerts.length > 0 && (
                <Card className="!border-destructive/60 bg-destructive/5">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base text-destructive">
                            <AlertTriangle className="h-4 w-4" />
                            {t('recurring.amountChanges')}
                        </CardTitle>
                        <CardDescription>
                            {t('recurring.amountChangesDesc')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {amountAlerts.slice(0, 5).map((pattern) => {
                                const lastChange = pattern.amountChanges[pattern.amountChanges.length - 1];
                                return (
                                    <div
                                        key={`alert-${pattern.recipientId}-${pattern.direction}`}
                                        className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-background p-3"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-semibold text-foreground truncate">
                                                {pattern.recipientName}
                                            </p>
                                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                <span className="text-xs text-muted-foreground line-through">
                                                    {formatCurrency(lastChange.previousAmount, pattern.currency)}
                                                </span>
                                                <span className="text-xs">→</span>
                                                <span className={cn("text-xs font-bold", lastChange.direction === "increased" ? "text-loss" : "text-gain")}>
                                                    {formatCurrency(lastChange.newAmount, pattern.currency)}
                                                </span>
                                                <Badge variant="outline" className={cn("text-xs", lastChange.direction === "increased" ? "text-loss border-loss/30" : "text-gain border-gain/30")}>
                                                    {lastChange.direction === "increased" ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                                    {formatPercent(lastChange.percentChange, { digits: 1, signed: true })}
                                                </Badge>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('recurring.changedOn', { date: safeDateLabel(lastChange.date, appSettings.dateFormat, t) })}
                                            </p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('aria.dismiss')}
                                            onClick={() => dismiss(pattern.recipientId)}
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Suggested Recurring Patterns */}
            {patterns.length > 0 && (
                <Card className="glass-regular">
                    <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Sparkles className="h-4 w-4 text-primary" />
                                    {t('recurring.patterns')}
                                    <Badge variant="secondary" className="ml-1">{patterns.length}</Badge>
                                </CardTitle>
                                <CardDescription className="mt-1">
                                    {t('recurring.patternsDesc')}
                                </CardDescription>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="icon-touch-target"
                                aria-label={expanded ? "Collapse" : "Expand"}
                                onClick={() => setExpanded(!expanded)}
                            >
                                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                        </div>
                    </CardHeader>
                    {expanded && (
                        <CardContent>
                            <div className="space-y-3">
                                {patterns.map((pattern) => (
                                    <div
                                        key={`${pattern.recipientId}-${pattern.direction}`}
                                        className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow"
                                    >
                                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                            <Repeat className="h-4 w-4 text-primary" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-semibold text-foreground truncate">
                                                    {pattern.recipientName}
                                                </p>
                                                <ConfidenceBadge confidence={pattern.confidence} t={t} />
                                            </div>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                <Badge variant="outline" className="text-xs">
                                                    {PATTERN_LABELS[pattern.detectedPattern] || pattern.detectedPattern}
                                                </Badge>
                                                {pattern.categoryName && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {pattern.categoryName.split(":").pop()?.trim()}
                                                    </span>
                                                )}
                                                <span className="text-xs text-muted-foreground">
                                                    · {pattern.occurrences}{t('recurring.seen')}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                                                <Calendar className="h-3 w-3" />
                                                {t('recurring.nextExpected', { date: safeDateLabel(pattern.predictedNext, appSettings.dateFormat, t) })}
                                            </div>
                                        </div>

                                        <div className="text-right shrink-0 flex flex-col items-end gap-1.5">
                                            <span className="text-sm font-bold text-foreground">
                                                {formatCurrency(pattern.latestAmount, pattern.currency)}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    size="sm"
                                                    variant="default"
                                                    className="h-7 text-xs gap-1"
                                                    onClick={() => handleCreatePlanned(pattern)}
                                                >
                                                    <Plus className="h-3 w-3" />
                                                    {t('recurring.track')}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 text-xs text-muted-foreground"
                                                    onClick={() => dismiss(pattern.recipientId)}
                                                >
                                                    {t('recurring.dismissBtn')}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    )}
                </Card>
            )}
        </div>
    );
}

function ConfidenceBadge({ confidence, t }: { confidence: number; t: (key: string) => string }) {
    let color = "text-muted-foreground border-muted";
    let label = t('recurring.confidence.low');

    if (confidence >= 80) {
        color = "text-accent border-accent/30 bg-accent/10";
        label = t('recurring.confidence.high');
    } else if (confidence >= 60) {
        color = "text-chart-5 border-chart-5/30 bg-chart-5/10";
        label = t('recurring.confidence.medium');
    }

    return (
        <Badge variant="outline" className={cn("text-xs", color)}>
            {confidence}% {label}
        </Badge>
    );
}
