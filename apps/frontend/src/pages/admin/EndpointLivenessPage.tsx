import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { getRequestMetrics, getEndpointManifest } from '@/lib/api/admin';
import type { RouteMetric, EndpointEntry } from '@/lib/api/admin';

function methodBadgeClass(method: string) {
    switch (method) {
        case 'GET': return 'bg-blue-500/10 text-blue-700 dark:text-blue-400';
        case 'POST': return 'bg-green-500/10 text-green-700 dark:text-green-400';
        case 'PATCH': case 'PUT': return 'bg-amber-500/10 text-amber-700 dark:text-amber-400';
        case 'DELETE': return 'bg-destructive/10 text-destructive';
        default: return 'bg-muted text-muted-foreground';
    }
}

function errorRateBadgeClass(rate: number) {
    if (rate >= 10) return 'text-destructive font-semibold';
    if (rate > 2) return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
}

type MergedRow = EndpointEntry & Partial<RouteMetric>;

export default function EndpointLivenessPage() {
    const { t } = useLanguage();
    const [filter, setFilter] = useState('');

    const { data: manifest, isLoading: manifestLoading } = useQuery({
        queryKey: ['admin', 'endpoints'],
        queryFn: getEndpointManifest,
        staleTime: 300_000,
    });

    const { data: metrics } = useQuery({
        queryKey: ['admin', 'request-metrics'],
        queryFn: getRequestMetrics,
        staleTime: 15_000,
    });

    const rows = useMemo<MergedRow[]>(() => {
        if (!manifest) return [];

        const metricsByKey = new Map<string, RouteMetric>();
        for (const m of metrics ?? []) {
            metricsByKey.set(`${m.method}:${m.path}`, m);
        }

        return manifest.map((entry) => {
            const metric = metricsByKey.get(`${entry.method}:${entry.path}`);
            return { ...entry, ...metric };
        });
    }, [manifest, metrics]);

    const filtered = useMemo(() => {
        if (!filter) return rows;
        const q = filter.toLowerCase();
        return rows.filter(
            (r) => r.path.toLowerCase().includes(q) || r.method.toLowerCase().includes(q),
        );
    }, [rows, filter]);

    return (
        <div className="flex flex-col gap-6 p-6">
            <PageHeader
                title={t('admin.endpoints.title')}
                description={t('admin.endpoints.description')}
            />

            <Card className="glass-chrome">
                <CardHeader className="flex flex-row items-center justify-between pb-4">
                    <CardTitle className="text-base">{t('admin.endpoints.tableTitle')}</CardTitle>
                    <div className="relative w-56">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder={t('admin.endpoints.filterPlaceholder')}
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            className="pl-8 h-8 text-sm"
                        />
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-20">{t('admin.endpoints.colMethod')}</TableHead>
                                <TableHead>{t('admin.endpoints.colPath')}</TableHead>
                                <TableHead className="text-right">{t('admin.endpoints.colRequests')}</TableHead>
                                <TableHead className="text-right">{t('admin.endpoints.colErrors')}</TableHead>
                                <TableHead className="text-right">{t('admin.endpoints.colErrorRate')}</TableHead>
                                <TableHead className="text-right">{t('admin.endpoints.colP50')}</TableHead>
                                <TableHead className="text-right">{t('admin.endpoints.colP95')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {manifestLoading ? (
                                Array.from({ length: 10 }).map((_, i) => (
                                    <TableRow key={i}>
                                        {Array.from({ length: 7 }).map((__, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                            ) : filtered.map((row) => (
                                <TableRow key={`${row.method}:${row.path}`}>
                                    <TableCell>
                                        <span className={`text-xs font-mono font-semibold rounded px-1.5 py-0.5 ${methodBadgeClass(row.method)}`}>
                                            {row.method}
                                        </span>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{row.path}</TableCell>
                                    <TableCell className="text-right text-sm">{row.count ?? '—'}</TableCell>
                                    <TableCell className="text-right text-sm">{row.errors ?? '—'}</TableCell>
                                    <TableCell className={`text-right text-sm ${row.error_rate !== undefined ? errorRateBadgeClass(row.error_rate * 100) : 'text-muted-foreground'}`}>
                                        {row.error_rate !== undefined ? `${(row.error_rate * 100).toFixed(1)}%` : '—'}
                                    </TableCell>
                                    <TableCell className="text-right text-sm text-muted-foreground">
                                        {row.p50_ms !== undefined ? `${row.p50_ms}ms` : '—'}
                                    </TableCell>
                                    <TableCell className="text-right text-sm text-muted-foreground">
                                        {row.p95_ms !== undefined ? `${row.p95_ms}ms` : '—'}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
