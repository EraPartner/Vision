import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { getShadowDivergences, getShadowDivergencesSummary } from '@/lib/api/admin';

const PAGE_SIZE = 50;

function fmt(ts: string) {
    try {
        return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return ts;
    }
}

function SkeletonRow({ cols }: { cols: number }) {
    return (
        <TableRow>
            {Array.from({ length: cols }).map((_, i) => (
                <TableCell key={i}><Skeleton className="h-4 w-full" /></TableCell>
            ))}
        </TableRow>
    );
}

export default function ShadowDivergencesPage() {
    const { t } = useLanguage();
    const qc = useQueryClient();
    const [filterEndpoint, setFilterEndpoint] = useState('');
    const [offset, setOffset] = useState(0);

    const summaryQuery = useQuery({
        queryKey: ['admin', 'shadow-divergences', 'summary'],
        queryFn: getShadowDivergencesSummary,
        staleTime: 30_000,
    });

    const rowsQuery = useQuery({
        queryKey: ['admin', 'shadow-divergences', 'rows', filterEndpoint, offset],
        queryFn: () => getShadowDivergences({
            endpoint: filterEndpoint || undefined,
            limit: PAGE_SIZE,
            offset,
        }),
        staleTime: 30_000,
    });

    function handleRefresh() {
        qc.invalidateQueries({ queryKey: ['admin', 'shadow-divergences'] });
    }

    function handleEndpointChange(value: string) {
        setFilterEndpoint(value === '__all__' ? '' : value);
        setOffset(0);
    }

    const endpoints = summaryQuery.data?.endpoints ?? [];
    const grandTotal = summaryQuery.data?.total ?? 0;
    const rows = rowsQuery.data?.rows ?? [];
    const rowTotal = rowsQuery.data?.total ?? 0;
    const isLoading = summaryQuery.isLoading;
    const isRowsLoading = rowsQuery.isLoading;

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('shadowDivergences.title')}
                subtitle={t('shadowDivergences.subtitle')}
                icon={Activity}
                iconColor="from-yellow-500/20 to-yellow-500/5 text-yellow-500"
                actions={
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleRefresh}
                        disabled={isLoading}
                        className="gap-2"
                    >
                        <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                        {t('shadowDivergences.refresh')}
                    </Button>
                }
            />

            {/* Total count card */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card className="glass-chrome">
                    <CardContent className="pt-6">
                        <div className="flex items-center gap-4">
                            <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-yellow-500/20 to-yellow-500/5 flex items-center justify-center">
                                <Activity className="h-5 w-5 text-yellow-500" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">{t('shadowDivergences.total')}</p>
                                <p className="text-xl font-bold tracking-tight">
                                    {isLoading ? '…' : grandTotal.toLocaleString()}
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Per-endpoint summary table */}
            {(isLoading || endpoints.length > 0) && (
                <Card className="glass-chrome">
                    <CardHeader>
                        <CardTitle className="text-base">{t('shadowDivergences.summary')}</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('shadowDivergences.col.endpoint')}</TableHead>
                                    <TableHead className="text-right">{t('shadowDivergences.col.count')}</TableHead>
                                    <TableHead className="text-right">{t('shadowDivergences.col.maxDiff')}</TableHead>
                                    <TableHead>{t('shadowDivergences.col.lastSeen')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading
                                    ? Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} cols={4} />)
                                    : endpoints.map((ep) => (
                                        <TableRow key={ep.endpoint}>
                                            <TableCell className="font-mono text-xs">{ep.endpoint}</TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                <Badge variant="secondary">{ep.count.toLocaleString()}</Badge>
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">{ep.max_divergence_count}</TableCell>
                                            <TableCell className="text-xs text-muted-foreground">{fmt(ep.last_seen)}</TableCell>
                                        </TableRow>
                                    ))
                                }
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {/* Recent divergence log */}
            <Card className="glass-chrome">
                <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                        <CardTitle className="text-base">{t('shadowDivergences.recentLog')}</CardTitle>
                        <Select value={filterEndpoint || '__all__'} onValueChange={handleEndpointChange}>
                            <SelectTrigger className="w-56 h-8 text-xs">
                                <SelectValue placeholder={t('shadowDivergences.allEndpoints')} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all__">{t('shadowDivergences.allEndpoints')}</SelectItem>
                                {endpoints.map((ep) => (
                                    <SelectItem key={ep.endpoint} value={ep.endpoint}>{ep.endpoint}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('shadowDivergences.col.endpoint')}</TableHead>
                                <TableHead className="text-right">{t('shadowDivergences.col.diffCount')}</TableHead>
                                <TableHead>{t('shadowDivergences.col.params')}</TableHead>
                                <TableHead>{t('shadowDivergences.col.createdAt')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isRowsLoading
                                ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={4} />)
                                : rows.map((row) => (
                                    <TableRow key={row.id}>
                                        <TableCell className="font-mono text-xs">{row.endpoint}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            <Badge variant={row.divergence_count > 5 ? 'destructive' : 'secondary'}>
                                                {row.divergence_count}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs max-w-[200px] truncate">
                                            {JSON.stringify(row.request_params)}
                                        </TableCell>
                                        <TableCell className="text-xs text-muted-foreground">
                                            {fmt(row.created_at)}
                                        </TableCell>
                                    </TableRow>
                                ))
                            }
                            {!isRowsLoading && rows.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                                        {t('shadowDivergences.noData')}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
                {rowTotal > PAGE_SIZE && (
                    <div className="px-6 pb-4 flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                            {offset + 1}–{Math.min(offset + PAGE_SIZE, rowTotal)} / {rowTotal.toLocaleString()}
                        </span>
                        <div className="flex gap-2">
                            <Button
                                size="sm" variant="outline"
                                disabled={offset === 0}
                                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                                className="h-7 gap-1 text-xs"
                            >
                                <ChevronLeft className="h-3 w-3" />
                                {t('shadowDivergences.prev')}
                            </Button>
                            <Button
                                size="sm" variant="outline"
                                disabled={offset + PAGE_SIZE >= rowTotal}
                                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                                className="h-7 gap-1 text-xs"
                            >
                                {t('shadowDivergences.next')}
                                <ChevronRight className="h-3 w-3" />
                            </Button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}
