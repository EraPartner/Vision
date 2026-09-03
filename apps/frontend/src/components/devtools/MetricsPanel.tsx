import {
    useQueryMetrics,
    resetQueryMetrics,
} from "@/lib/devtools/queryMetrics";
import { clearApiRequestLog } from "@/lib/devtools/apiRequestLog";
import { cn } from "@/lib/utils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

function StatCard({
    label,
    value,
    sub,
    warn,
}: {
    label: string;
    value: string;
    sub?: string;
    warn?: boolean;
}) {
    return (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <p className="text-2xs text-muted-foreground mb-0.5">{label}</p>
            <p
                className={cn(
                    "text-lg font-mono font-semibold tabular-nums leading-none",
                    warn && "text-warning",
                )}
            >
                {value}
            </p>
            {sub && (
                <p className="text-2xs text-muted-foreground mt-0.5">{sub}</p>
            )}
        </div>
    );
}

export function MetricsPanel() {
    const formatPercent = usePercentFormatter();
    const metrics = useQueryMetrics();
    const errorPct = formatPercent(metrics.errorRate * 100, { digits: 1 });
    const cachePct = formatPercent(metrics.cacheHitRatio * 100, { digits: 1 });

    function handleReset() {
        resetQueryMetrics();
        clearApiRequestLog();
    }

    return (
        <div className="flex flex-col h-full overflow-auto px-3 py-2 gap-3">
            <div className="grid grid-cols-2 gap-2">
                <StatCard
                    label="Total requests"
                    value={String(metrics.totalRequests)}
                />
                <StatCard
                    label="Error rate"
                    value={errorPct}
                    sub={`${Math.round(metrics.errorRate * metrics.totalRequests)} errors`}
                    warn={metrics.errorRate > 0.05}
                />
                <StatCard
                    label="Cache hit ratio"
                    value={cachePct}
                    sub="TanStack Query cache"
                    warn={
                        metrics.cacheHitRatio < 0.3 &&
                        metrics.totalRequests > 10
                    }
                />
                <StatCard
                    label="Mutations"
                    value={`${metrics.mutationsSuccess}/${metrics.mutationsSuccess + metrics.mutationsError}`}
                    sub="success / total"
                    warn={metrics.mutationsError > 0}
                />
            </div>

            {metrics.slowRequests.length > 0 && (
                <div>
                    <p className="text-2xs font-semibold text-warning mb-1.5">
                        Slow requests (&gt;1 s) — {metrics.slowRequests.length}
                    </p>
                    <div className="space-y-0.5">
                        {metrics.slowRequests.slice(0, 10).map((req) => (
                            <div
                                key={req.id}
                                className="flex items-center gap-2 text-2xs font-mono"
                            >
                                <span className="text-muted-foreground w-12 shrink-0">
                                    {req.method}
                                </span>
                                <span className="flex-1 truncate text-foreground">
                                    {req.endpoint}
                                </span>
                                <span className="shrink-0 text-warning tabular-nums">
                                    {((req.durationMs ?? 0) / 1000).toFixed(2)}s
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {metrics.topEndpoints.length > 0 && (
                <div>
                    <p className="text-2xs font-semibold text-muted-foreground mb-1.5">
                        Top endpoints by call count
                    </p>
                    <div className="space-y-0.5">
                        {metrics.topEndpoints.slice(0, 10).map((ep) => (
                            <div
                                key={ep.endpoint}
                                className="flex items-center gap-2 text-2xs font-mono"
                            >
                                <span className="flex-1 truncate text-foreground">
                                    {ep.endpoint}
                                </span>
                                <span className="shrink-0 text-muted-foreground tabular-nums w-6 text-right">
                                    {ep.count}×
                                </span>
                                <span
                                    className={cn(
                                        "shrink-0 tabular-nums w-16 text-right",
                                        ep.p95 >= 1000
                                            ? "text-warning"
                                            : "text-muted-foreground",
                                    )}
                                >
                                    p95:{ep.p95.toFixed(0)}ms
                                </span>
                                {ep.errorCount > 0 && (
                                    <span className="shrink-0 text-destructive tabular-nums">
                                        {ep.errorCount}err
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="mt-auto pt-2 border-t border-border">
                <button
                    type="button"
                    onClick={handleReset}
                    className="text-2xs text-muted-foreground hover:text-foreground transition-colors"
                >
                    Reset all metrics
                </button>
            </div>
        </div>
    );
}
