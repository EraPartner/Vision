import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { formatCurrency } from "@/utils/currency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Repeat, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown,
    Calendar, Loader2, Sparkles, ChevronDown, ChevronUp, Plus, X,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

const PATTERN_LABELS: Record<string, string> = {
    weekly: "Weekly",
    biweekly: "Bi-weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
    custom: "Custom",
};

type RecurringPattern = Awaited<ReturnType<typeof apiClient.getRecurringPatterns>>["patterns"][number];

interface Props {
    onCreatePlanned?: (pattern: RecurringPattern) => void;
}

export function RecurringDetectionPanel({ onCreatePlanned }: Props) {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(true);
    const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
    const [dismissedLoaded, setDismissedLoaded] = useState(false);

    // Load dismissed IDs from database settings
    useEffect(() => {
        apiClient.getSetting("dismissed_recurring_patterns")
            .then((result) => {
                if (result?.value && Array.isArray(result.value)) {
                    setDismissedIds(new Set(result.value));
                }
            })
            .catch(() => {})
            .finally(() => setDismissedLoaded(true));
    }, []);

    const { data, isLoading, error } = useQuery({
        queryKey: ["recurringPatterns"],
        queryFn: () => apiClient.getRecurringPatterns(),
        staleTime: 5 * 60_000,
    });

    const dismiss = (recipientId: number) => {
        const next = new Set(dismissedIds);
        next.add(recipientId);
        setDismissedIds(next);
        apiClient.saveSetting("dismissed_recurring_patterns", [...next]).catch(() => {});
    };

    const handleCreatePlanned = async (pattern: RecurringPattern) => {
        if (onCreatePlanned) {
            onCreatePlanned(pattern);
            return;
        }

        // Default: create planned transaction via API
        try {
            await apiClient.createPlannedTransaction({
                planned_date: pattern.predictedNext,
                recipient_id: pattern.recipientId,
                memo: `${pattern.recipientName} (auto-detected)`,
                amount: pattern.latestAmount * -1, // expenses are negative
                currency: pattern.currency,
                category_id: pattern.categoryId ?? undefined,
                bank_account: pattern.bankAccount ?? undefined,
                is_recurring: true,
                recurrence_pattern: pattern.detectedPattern === "custom"
                    ? `every ${pattern.intervalDays} days`
                    : pattern.detectedPattern,
            });
            queryClient.invalidateQueries({ queryKey: ["recurringPatterns"] });
            queryClient.invalidateQueries({ queryKey: ["plannedTransactions"] });
            toast.success(`Created planned payment for ${pattern.recipientName}`);
        } catch (err: any) {
            toast.error(`Failed to create: ${err.message}`);
        }
    };

    // Filter out dismissed and already-planned patterns
    const patterns = (data?.patterns ?? []).filter(
        (p) => !p.isAlreadyPlanned && !dismissedIds.has(p.recipientId)
    );

    const amountAlerts = (data?.patterns ?? []).filter(
        (p) => p.amountChanges.length > 0 && !dismissedIds.has(p.recipientId)
    );

    if (isLoading) {
        return (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-primary" />
                        Recurring Detection
                    </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    if (error || !data) return null;

    if (patterns.length === 0 && amountAlerts.length === 0) {
        return (
            <Card className="border-dashed">
                <CardContent className="flex items-center gap-3 py-4">
                    <CheckCircle2 className="h-5 w-5 text-accent shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-foreground">All caught up!</p>
                        <p className="text-xs text-muted-foreground">
                            No new recurring patterns detected. All known recurring charges are tracked.
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
                <Card className="border-destructive/30 bg-destructive/5">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base text-destructive">
                            <AlertTriangle className="h-4 w-4" />
                            Amount Changes Detected
                        </CardTitle>
                        <CardDescription>
                            These recurring charges have recently changed in amount
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {amountAlerts.slice(0, 5).map((pattern) => {
                                const lastChange = pattern.amountChanges[pattern.amountChanges.length - 1];
                                return (
                                    <div
                                        key={`alert-${pattern.recipientId}`}
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
                                                <span className={`text-xs font-bold ${lastChange.direction === "increased" ? "text-destructive" : "text-accent"}`}>
                                                    {formatCurrency(lastChange.newAmount, pattern.currency)}
                                                </span>
                                                <Badge variant="outline" className={`text-xs ${lastChange.direction === "increased" ? "text-destructive border-destructive/30" : "text-accent border-accent/30"}`}>
                                                    {lastChange.direction === "increased" ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                                    {lastChange.percentChange > 0 ? "+" : ""}{lastChange.percentChange.toFixed(1)}%
                                                </Badge>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Changed on {format(parseISO(lastChange.date), "PP")}
                                            </p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
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
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <Sparkles className="h-4 w-4 text-primary" />
                                    Detected Recurring Patterns
                                    <Badge variant="secondary" className="ml-1">{patterns.length}</Badge>
                                </CardTitle>
                                <CardDescription className="mt-1">
                                    These transactions appear to recur regularly. Add them as planned payments?
                                </CardDescription>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
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
                                        key={pattern.recipientId}
                                        className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow"
                                    >
                                        {/* Icon */}
                                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                            <Repeat className="h-4 w-4 text-primary" />
                                        </div>

                                        {/* Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-semibold text-foreground truncate">
                                                    {pattern.recipientName}
                                                </p>
                                                <ConfidenceBadge confidence={pattern.confidence} />
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
                                                    · {pattern.occurrences}× seen
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                                                <Calendar className="h-3 w-3" />
                                                Next expected: {format(parseISO(pattern.predictedNext), "PP")}
                                            </div>
                                        </div>

                                        {/* Amount + Actions */}
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
                                                    Track
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 text-xs text-muted-foreground"
                                                    onClick={() => dismiss(pattern.recipientId)}
                                                >
                                                    Dismiss
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

function ConfidenceBadge({ confidence }: { confidence: number }) {
    let color = "text-muted-foreground border-muted";
    let label = "Low";

    if (confidence >= 80) {
        color = "text-accent border-accent/30 bg-accent/10";
        label = "High";
    } else if (confidence >= 60) {
        color = "text-chart-5 border-chart-5/30 bg-chart-5/10";
        label = "Medium";
    }

    return (
        <Badge variant="outline" className={`text-xs ${color}`}>
            {confidence}% {label}
        </Badge>
    );
}
