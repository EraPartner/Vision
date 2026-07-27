import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminKeys } from '@/lib/queryKeys';
import { Database, HardDrive, RefreshCw, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/PageHeader';
import { AdminErrorState } from '@/components/shared/AdminErrorState';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { numberFormatToLocale } from '@/utils/currency';
import { formatDateTimeWithAppSettings } from '@/components/shared/dateUtils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { loadingSurfaceProps } from '@/lib/loadingSurface';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { getDbStats, vacuumTable } from '@/lib/api/admin';
import type { DbTableStat } from '@/lib/api/admin';
import { cn } from '@/lib/utils';

// ── Row skeleton ──────────────────────────────────────────────────────────────

function SkeletonRow() {
    return (
        <TableRow>
            {Array.from({ length: 7 }).map((_, i) => (
                <TableCell key={i}>
                    <Skeleton className="h-4 w-full" />
                </TableCell>
            ))}
        </TableRow>
    );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: React.ElementType }) {
    return (
        <Card className="glass-chrome">
            <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                    <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                        <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                        <p className="text-sm text-muted-foreground">{label}</p>
                        <p className="text-xl font-bold tracking-tight">{value}</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function TableStatRow({
    row,
    onVacuum,
    onOpen,
    isVacuuming,
    t,
}: {
    row: DbTableStat;
    onVacuum: (table: string) => void;
    onOpen: (table: string) => void;
    isVacuuming: boolean;
    t: (key: string) => string;
}) {
    // App settings, not the browser locale — an eu-format nl user with an
    // en-US browser otherwise saw US date order and separators here.
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    function fmt(ts: string | null) {
        if (!ts) return '—';
        try {
            return formatDateTimeWithAppSettings(new Date(ts), appSettings.dateFormat, locale);
        } catch {
            return ts;
        }
    }

    return (
        <TableRow
            className="cursor-pointer"
            onDoubleClick={() => onOpen(row.table_name)}
            title={t('dbEditor.openHint')}
        >
            <TableCell className="font-mono text-xs">{row.table_name}</TableCell>
            <TableCell className="text-right tabular-nums">
                {Number(row.live_rows).toLocaleString(locale)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
                <span className={Number(row.dead_rows) > 1000 ? 'text-yellow-600' : ''}>
                    {Number(row.dead_rows).toLocaleString(locale)}
                </span>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{fmt(row.last_autovacuum)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{fmt(row.last_autoanalyze)}</TableCell>
            <TableCell className="text-right tabular-nums font-medium">{row.size}</TableCell>
            <TableCell className="text-right">
                <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    disabled={isVacuuming}
                    onClick={() => onVacuum(row.table_name)}
                >
                    <Zap className="h-3 w-3" />
                    {t('dbMaintenance.vacuumTable')}
                </Button>
            </TableCell>
        </TableRow>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DbMaintenancePage() {
    const { t } = useLanguage();
    const qc = useQueryClient();
    const navigate = useNavigate();
    const [vacuumingTable, setVacuumingTable] = useState<string | null>(undefined as unknown as null);

    const { data, isLoading, error } = useQuery({
        queryKey: adminKeys.dbStats,
        queryFn: getDbStats,
        staleTime: 30_000,
    });

    const vacuumMutation = useMutation({
        mutationFn: (table: string | null) => vacuumTable(table),
        onMutate: (table) => setVacuumingTable(table ?? '__all__'),
        onSuccess: (_, table) => {
            const label = table ?? t('dbMaintenance.allTables');
            toast.success(t('dbMaintenance.vacuumSuccess'), { description: label });
            qc.invalidateQueries({ queryKey: adminKeys.dbStats });
        },
        onError: (err: Error, table) => {
            const label = table ?? t('dbMaintenance.allTables');
            toast.error(t('dbMaintenance.vacuumFailed'), { description: `${label}: ${err.message}` });
        },
        onSettled: () => setVacuumingTable(null),
    });

    function handleVacuumTable(table: string) {
        vacuumMutation.mutate(table);
    }

    function handleVacuumAll() {
        vacuumMutation.mutate(null);
    }

    function handleRefresh() {
        qc.invalidateQueries({ queryKey: adminKeys.dbStats });
    }

    const tableCount = data?.tables.length ?? 0;
    const isVacuuming = vacuumMutation.isPending;

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('dbMaintenance.title')}
                subtitle={t('dbMaintenance.subtitle')}
                icon={Database}
                iconColor="from-orange-500/20 to-orange-500/5 text-orange-500"
                actions={
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRefresh}
                            disabled={isLoading}
                            className="gap-2"
                        >
                            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                            {t('dbMaintenance.refresh')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleVacuumAll}
                            disabled={isVacuuming}
                            className="gap-2"
                        >
                            <Zap className="h-4 w-4" />
                            {isVacuuming && vacuumingTable === '__all__'
                                ? t('dbMaintenance.vacuuming')
                                : t('dbMaintenance.vacuumAll')}
                        </Button>
                    </div>
                }
            />

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <StatCard
                    label={t('dbMaintenance.totalSize')}
                    value={data?.db_size ?? '—'}
                    icon={HardDrive}
                />
                <StatCard
                    label={t('dbMaintenance.tableCount')}
                    value={tableCount.toString()}
                    icon={Database}
                />
            </div>

            {/* Error state */}
            {error && <AdminErrorState error={error} fallbackMessage={t('dbMaintenance.loadError')} />}

            {/* Table stats */}
            <Card className="glass-chrome">
                <CardHeader>
                    <CardTitle className="text-base">{t('dbMaintenance.tableStats')}</CardTitle>
                </CardHeader>
                {/* The skeleton rows live inside <tbody>, where a wrapper
                    element would be invalid HTML — the CardContent around the
                    table carries the status role instead, only while loading. */}
                <CardContent {...(isLoading ? loadingSurfaceProps : {})} className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('dbMaintenance.col.table')}</TableHead>
                                <TableHead className="text-right">{t('dbMaintenance.col.liveRows')}</TableHead>
                                <TableHead className="text-right">{t('dbMaintenance.col.deadRows')}</TableHead>
                                <TableHead>{t('dbMaintenance.col.lastVacuum')}</TableHead>
                                <TableHead>{t('dbMaintenance.col.lastAnalyze')}</TableHead>
                                <TableHead className="text-right">{t('dbMaintenance.col.size')}</TableHead>
                                <TableHead className="text-right">{t('dbMaintenance.col.actions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                                : data?.tables.map((row) => (
                                    <TableStatRow
                                        key={row.table_name}
                                        row={row}
                                        onVacuum={handleVacuumTable}
                                        onOpen={(table) => navigate(`/admin/db/${encodeURIComponent(table)}`)}
                                        isVacuuming={isVacuuming}
                                        t={t}
                                    />
                                ))}
                            {!isLoading && !error && tableCount === 0 && (
                                <TableRow>
                                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                                        {t('dbMaintenance.noTables')}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
                <div className="px-6 pb-4 text-xs text-muted-foreground">
                    {t('dbMaintenance.statsNote')}
                </div>
            </Card>
        </div>
    );
}
