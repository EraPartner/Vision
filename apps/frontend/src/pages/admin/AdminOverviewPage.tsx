import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminKeys } from "@/lib/queryKeys";
import { Activity, Database, KeyRound } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { Link } from "react-router";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    getDbStats,
    getProviderHealth,
    getRequestMetrics,
} from "@/lib/api/admin";
import {
    setAdminToken,
    clearAdminToken,
    hasAdminToken,
} from "@/lib/adminToken";
import { cn } from "@/lib/utils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

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
        <Link to={to} className="block group">
            <Card
                variant="interactive"
                className={cn("glass-chrome", statusRing)}
            >
                <CardContent variant="headerless">
                    <div className="flex items-center gap-4">
                        <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                            <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">
                                {label}
                            </p>
                            <p className="text-xl font-bold tracking-tight">
                                {value}
                            </p>
                            {sub && (
                                <p className="text-xs text-muted-foreground mt-0.5">
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

// Lets a self-hoster who set ADMIN_AUTH_TOKEN on the server authenticate the
// admin UI. Renders regardless of whether the admin data queries succeed, so a
// 401'd admin page can still be unlocked. Token is held in sessionStorage only.
function AdminTokenCard() {
    const { t } = useLanguage();
    const [value, setValue] = useState("");
    const [active, setActive] = useState<boolean>(hasAdminToken());

    const save = () => {
        setAdminToken(value);
        setActive(hasAdminToken());
        setValue("");
        toast.success(t("admin.token.saved"));
    };

    const clear = () => {
        clearAdminToken();
        setActive(false);
        toast.success(t("admin.token.cleared"));
    };

    return (
        <Card className="glass-chrome">
            <CardContent variant="headerless" className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5">
                        <KeyRound className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                        <p className="text-sm font-semibold">
                            {t("admin.token.title")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("admin.token.description")}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        type="password"
                        autoComplete="off"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={t("admin.token.placeholder")}
                        aria-label={t("admin.token.title")}
                        className="max-w-xs flex-1"
                    />
                    <Button onClick={save} disabled={!value.trim()}>
                        {t("admin.token.save")}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={clear}
                        disabled={!active}
                    >
                        {t("admin.token.clear")}
                    </Button>
                </div>
                {active && (
                    <p className="text-xs text-success">
                        {t("admin.token.active")}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

export default function AdminOverviewPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();

    const { data: dbStats, isLoading: dbLoading } = useQuery({
        queryKey: adminKeys.dbStats,
        queryFn: getDbStats,
        staleTime: 60_000,
    });

    const { data: providers, isLoading: providersLoading } = useQuery({
        queryKey: adminKeys.providerHealth,
        queryFn: getProviderHealth,
        staleTime: 30_000,
    });

    const { data: metrics, isLoading: metricsLoading } = useQuery({
        queryKey: adminKeys.requestMetrics,
        queryFn: getRequestMetrics,
        staleTime: 15_000,
    });

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
        <PageShell className="p-6">
            <PageHeader
                title={t("admin.overview.title")}
                subtitle={t("admin.overview.description")}
                icon={PAGE_ICONS["/admin"]}
            />

            {/* The grid is shared with the loaded cards, so the status role is
                spread only while loading — one region for all three skeleton
                cards rather than one per card. */}
            <div
                {...(dbLoading ? loadingSurfaceProps : {})}
                className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4"
            >
                {dbLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                        <Card key={i} className="glass-chrome">
                            <CardContent variant="headerless">
                                <div className="flex items-center gap-4">
                                    <Skeleton className="h-10 w-10 rounded-xl" />
                                    <div className="space-y-2 flex-1">
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

            <AdminTokenCard />
        </PageShell>
    );
}
