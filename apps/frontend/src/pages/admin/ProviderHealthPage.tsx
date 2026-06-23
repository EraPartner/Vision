import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { formatDateTimeStringWithAppSettings } from '@/components/shared/dateUtils';
import { numberFormatToLocale } from '@/utils/currency';
import { getProviderHealth, probeProvider } from '@/lib/api/admin';
import type { ProviderHealth } from '@/lib/api/admin';

function StatusIcon({ failures }: { failures: number }) {
    if (failures === 0) return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (failures <= 2) return <AlertTriangle className="h-4 w-4 text-warning" />;
    return <XCircle className="h-4 w-4 text-destructive" />;
}

function statusBadgeClass(failures: number) {
    if (failures === 0) return 'bg-success/10 text-success';
    if (failures <= 2) return 'bg-warning/10 text-warning';
    return 'bg-destructive/10 text-destructive';
}

function formatTs(
    ts: string | null,
    neverLabel: string,
    dateFormat: string,
    locale: string,
) {
    if (!ts) return neverLabel;
    return formatDateTimeStringWithAppSettings(ts, dateFormat, locale);
}

interface ProviderRowProps {
    provider: ProviderHealth;
    onProbe: (name: string) => void;
    isProbing: boolean;
}

function ProviderRow({ provider, onProbe, isProbing }: ProviderRowProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const dateFormat = appSettings.dateFormat;
    const neverLabel = t('admin.providers.never');
    const [expanded, setExpanded] = useState(false);

    return (
        <>
            <TableRow>
                <TableCell>
                    <div className="flex items-center gap-2">
                        <StatusIcon failures={provider.consecutive_failures} />
                        <span className="font-medium">{provider.label}</span>
                    </div>
                </TableCell>
                <TableCell>
                    <span className="text-xs rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
                        {provider.kind}
                    </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                    {formatTs(provider.last_success_at, neverLabel, dateFormat, locale)}
                </TableCell>
                <TableCell>
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${statusBadgeClass(provider.consecutive_failures)}`}>
                        {provider.consecutive_failures}
                    </span>
                </TableCell>
                <TableCell>
                    {provider.last_error && provider.consecutive_failures > 0 ? (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            className="text-xs text-destructive hover:underline text-left max-w-[200px] truncate block"
                        >
                            {provider.last_error}
                        </button>
                    ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                    )}
                </TableCell>
                <TableCell>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onProbe(provider.provider)}
                        disabled={isProbing}
                    >
                        {isProbing
                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            : <Activity className="h-3.5 w-3.5" />
                        }
                        <span className="ml-1.5">{t('admin.providers.checkNow')}</span>
                    </Button>
                </TableCell>
            </TableRow>
            {expanded && provider.last_error && provider.consecutive_failures > 0 && (
                <TableRow>
                    <TableCell colSpan={6} className="bg-destructive/5 text-xs text-destructive font-mono py-2 px-4">
                        {provider.last_error}
                        {provider.last_error_at && (
                            <span className="ml-2 text-muted-foreground">
                                ({formatTs(provider.last_error_at, neverLabel, dateFormat, locale)})
                            </span>
                        )}
                    </TableCell>
                </TableRow>
            )}
        </>
    );
}

export default function ProviderHealthPage() {
    const { t } = useLanguage();
    const qc = useQueryClient();
    const [probingSet, setProbingSet] = useState<Set<string>>(new Set());

    const { data: providers, isLoading } = useQuery({
        queryKey: ['admin', 'provider-health'],
        queryFn: getProviderHealth,
        staleTime: 30_000,
    });

    const probeMutation = useMutation({
        mutationFn: probeProvider,
        onMutate: (name) => {
            setProbingSet((s) => new Set(s).add(name));
        },
        onSuccess: (result) => {
            const label = result.provider.label ?? result.provider.provider ?? String(result.provider);
            if (result.ok) {
                toast.success(t('admin.providers.probeOk', { provider: label }));
            } else {
                toast.error(t('admin.providers.probeFail', { provider: label }), {
                    description: result.error,
                });
            }
            void qc.invalidateQueries({ queryKey: ['admin', 'provider-health'] });
        },
        onError: (_err, name) => {
            toast.error(t('admin.providers.probeError', { provider: name }));
        },
        onSettled: (_data, _err, name) => {
            setProbingSet((s) => {
                const next = new Set(s);
                next.delete(name);
                return next;
            });
        },
    });

    return (
        <div className="flex flex-col gap-6 p-6">
            <PageHeader
                title={t('admin.providers.title')}
                description={t('admin.providers.description')}
            />

            <Card className="glass-chrome">
                <CardHeader>
                    <CardTitle className="text-base">{t('admin.providers.tableTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('admin.providers.colProvider')}</TableHead>
                                <TableHead>{t('admin.providers.colKind')}</TableHead>
                                <TableHead>{t('admin.providers.colLastSuccess')}</TableHead>
                                <TableHead>{t('admin.providers.colFailures')}</TableHead>
                                <TableHead>{t('admin.providers.colLastError')}</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                Array.from({ length: 7 }).map((_, i) => (
                                    <TableRow key={`skeleton-row-${i}`}>
                                        {Array.from({ length: 6 }).map((__, j) => (
                                            <TableCell key={`skeleton-cell-${i}-${j}`}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                            ) : (
                                providers?.map((p) => (
                                    <ProviderRow
                                        key={p.provider}
                                        provider={p}
                                        onProbe={(name) => probeMutation.mutate(name)}
                                        isProbing={probingSet.has(p.provider)}
                                    />
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
