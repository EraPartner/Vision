import { Activity, Database } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { Link } from "react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useAdminOverviewQueries } from "@/features/admin/useAdminQueries";

function OverviewCard({
    label,
    value,
    sub,
    icon: Icon,
    to,
    status,
}: {
    label: string;
    value: string;
    sub?: string;
    icon: React.ElementType;
    to: string;
    status?: "ok" | "warn" | "error";
}) {
    const statusRing =
        status === "error"
            ? "ring-1 ring-destructive/40"
            : status === "warn"
              ? "ring-1 ring-warning/40"
              : "";

    return (
        <Link to={to} className="group block rounded-card focus-ring">
            <Card variant="interactive" className={cn("h-full", statusRing)}>
                <CardContent variant="headerless">
                    <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-primary/12 text-primary">
                            <Icon className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <p className="type-callout text-label-secondary">
                                {label}
                            </p>
                            <p className="type-title-2 tabular-nums text-foreground">
                                {value}
                            </p>
                            {sub && (
                                <p className="mt-0.5 type-footnote text-label-secondary">
                                    {sub}
                                </p>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </Link>
    );
}

export default function AdminOverviewPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();

    const {
        dbStats: dbStatsQuery,
        providers: providersQuery,
        metrics: metricsQuery,
    } = useAdminOverviewQueries();
    const { data: dbStats, isLoading: dbLoading } = dbStatsQuery;
    const { data: providers, isLoading: providersLoading } = providersQuery;
    const { data: metrics, isLoading: metricsLoading } = metricsQuery;

    const failingProviders =
        providers?.filter((p) => p.consecutive_failures > 0).length ?? 0;
    const okProviders = (providers?.length ?? 0) - failingProviders;
    const providerStatus =
        failingProviders >= 3 ? "error" : failingProviders > 0 ? "warn" : "ok";

    const totalRequests = metrics?.reduce((s, r) => s + r.count, 0) ?? 0;
    const totalErrors = metrics?.reduce((s, r) => s + r.errors, 0) ?? 0;
    const overallErrorRate =
        totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    const metricsStatus =
        overallErrorRate >= 10 ? "error" : overallErrorRate > 2 ? "warn" : "ok";

    return (
        <PageShell>
            <PageHeader
                title={t("admin.overview.title")}
                subtitle={t("admin.overview.description")}
                icon={PAGE_ICONS["/admin"]}
            />

            {/* The grid is shared with the loaded cards, so the status role is
                spread only while loading: one region for all three skeleton
                cards rather than one per card. */}
            <div
                {...(dbLoading ? loadingSurfaceProps : {})}
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
                {dbLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                        <Card key={i}>
                            <CardContent variant="headerless">
                                <div className="flex items-center gap-4">
                                    <Skeleton className="h-10 w-10 rounded-control" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-3 w-24" />
                                        <Skeleton className="h-6 w-16" />
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))
                ) : (
                    <>
                        <OverviewCard
                            label={t("admin.overview.dbSize")}
                            value={dbStats?.db_size ?? "—"}
                            sub={`${dbStats?.tables.length ?? 0} ${t("admin.overview.tables")}`}
                            icon={Database}
                            to="/admin/db"
                        />
                        <OverviewCard
                            label={t("admin.overview.dataSources")}
                            value={
                                providersLoading
                                    ? "…"
                                    : `${okProviders} / ${providers?.length ?? 0}`
                            }
                            sub={
                                failingProviders > 0
                                    ? `${failingProviders} ${t("admin.overview.failing")}`
                                    : t("admin.overview.allHealthy")
                            }
                            icon={PAGE_ICONS["/admin/providers"]}
                            to="/admin/providers"
                            status={providerStatus}
                        />
                        <OverviewCard
                            label={t("admin.overview.endpoints")}
                            value={
                                metricsLoading
                                    ? "…"
                                    : `${formatPercent(overallErrorRate, { digits: 1 })} ${t("admin.overview.errorRate")}`
                            }
                            sub={`${totalRequests} ${t("admin.overview.requests")}`}
                            icon={Activity}
                            to="/admin/endpoints"
                            status={metricsStatus}
                        />
                    </>
                )}
            </div>

        </PageShell>
    );
}
