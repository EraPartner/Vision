import { useQuery } from '@tanstack/react-query';
import { Activity, Database, Globe } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import { useLanguage } from '@/contexts/LanguageContext';
import { getDbStats, getProviderHealth, getRequestMetrics } from '@/lib/api/admin';

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
    status?: 'ok' | 'warn' | 'error';
}) {
    const statusRing =
        status === 'error' ? 'ring-1 ring-destructive/40' :
        status === 'warn' ? 'ring-1 ring-amber-500/40' :
        '';

    return (
        <Link to={to} className="block group">
            <Card className={`glass-chrome transition-all duration-200 group-hover:shadow-lg ${statusRing}`}>
                <CardContent className="pt-6">
                    <div className="flex items-center gap-4">
                        <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                            <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">{label}</p>
                            <p className="text-xl font-bold tracking-tight">{value}</p>
                            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </Link>
    );
}

export default function AdminOverviewPage() {
    const { t } = useLanguage();

    const { data: dbStats, isLoading: dbLoading } = useQuery({
        queryKey: ['admin', 'db-stats'],
        queryFn: getDbStats,
        staleTime: 60_000,
    });

    const { data: providers, isLoading: providersLoading } = useQuery({
        queryKey: ['admin', 'provider-health'],
        queryFn: getProviderHealth,
        staleTime: 30_000,
    });

    const { data: metrics, isLoading: metricsLoading } = useQuery({
        queryKey: ['admin', 'request-metrics'],
        queryFn: getRequestMetrics,
        staleTime: 15_000,
    });

    const failingProviders = providers?.filter((p) => p.consecutive_failures > 0).length ?? 0;
    const okProviders = (providers?.length ?? 0) - failingProviders;
    const providerStatus = failingProviders >= 3 ? 'error' : failingProviders > 0 ? 'warn' : 'ok';

    const totalRequests = metrics?.reduce((s, r) => s + r.count, 0) ?? 0;
    const totalErrors = metrics?.reduce((s, r) => s + r.errors, 0) ?? 0;
    const overallErrorRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(1) : '0';
    const metricsStatus = Number(overallErrorRate) >= 10 ? 'error' : Number(overallErrorRate) > 2 ? 'warn' : 'ok';

    return (
        <div className="flex flex-col gap-6 p-6">
            <PageHeader
                title={t('admin.overview.title')}
                description={t('admin.overview.description')}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {dbLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                        <Card key={i} className="glass-chrome">
                            <CardContent className="pt-6">
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
                            label={t('admin.overview.dbSize')}
                            value={dbStats?.db_size ?? '—'}
                            sub={`${dbStats?.tables.length ?? 0} ${t('admin.overview.tables')}`}
                            icon={Database}
                            to="/admin/db"
                        />
                        <OverviewCard
                            label={t('admin.overview.dataSources')}
                            value={providersLoading ? '…' : `${okProviders} / ${providers?.length ?? 0}`}
                            sub={failingProviders > 0 ? `${failingProviders} ${t('admin.overview.failing')}` : t('admin.overview.allHealthy')}
                            icon={Globe}
                            to="/admin/providers"
                            status={providerStatus}
                        />
                        <OverviewCard
                            label={t('admin.overview.endpoints')}
                            value={metricsLoading ? '…' : `${overallErrorRate}% ${t('admin.overview.errorRate')}`}
                            sub={`${totalRequests} ${t('admin.overview.requests')}`}
                            icon={Activity}
                            to="/admin/endpoints"
                            status={metricsStatus}
                        />
                    </>
                )}
            </div>
        </div>
    );
}
