import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { listFeatureFlags, setFeatureFlag } from '@/lib/api/admin';
import type { FeatureFlag } from '@/lib/api/admin';

function FlagRow({
    flag,
    onToggle,
    isToggling,
    t,
}: {
    flag: FeatureFlag;
    onToggle: (key: string, enabled: boolean) => void;
    isToggling: boolean;
    t: (key: string) => string;
}) {
    return (
        <TableRow>
            <TableCell className="font-mono text-sm font-medium">{flag.key}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
                {flag.description ?? '—'}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
                {flag.updated_at
                    ? new Date(flag.updated_at).toLocaleString()
                    : new Date(flag.created_at).toLocaleString()}
            </TableCell>
            <TableCell>
                <Switch
                    checked={flag.enabled}
                    onCheckedChange={(enabled) => onToggle(flag.key, enabled)}
                    disabled={isToggling}
                    aria-label={`${t('admin.flags.toggle')} ${flag.key}`}
                />
            </TableCell>
        </TableRow>
    );
}

export default function AdminFeatureFlagsPage() {
    const { t } = useLanguage();
    const qc = useQueryClient();

    const { data: flags, isLoading } = useQuery({
        queryKey: ['admin', 'feature-flags'],
        queryFn: listFeatureFlags,
        staleTime: 30_000,
    });

    const mutation = useMutation({
        mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
            setFeatureFlag(key, enabled),
        onMutate: async ({ key, enabled }) => {
            await qc.cancelQueries({ queryKey: ['admin', 'feature-flags'] });
            const previous = qc.getQueryData<FeatureFlag[]>(['admin', 'feature-flags']);
            qc.setQueryData<FeatureFlag[]>(['admin', 'feature-flags'], (old) =>
                old?.map((f) => f.key === key ? { ...f, enabled } : f)
            );
            return { previous };
        },
        onSuccess: (updated) => {
            toast.success(
                updated.enabled
                    ? t('admin.flags.enabled').replace('{key}', updated.key)
                    : t('admin.flags.disabled').replace('{key}', updated.key)
            );
        },
        onError: (_err, _vars, ctx) => {
            if (ctx?.previous) {
                qc.setQueryData(['admin', 'feature-flags'], ctx.previous);
            }
            toast.error(t('admin.flags.toggleFailed'));
        },
        onSettled: () => {
            void qc.invalidateQueries({ queryKey: ['admin', 'feature-flags'] });
        },
    });

    return (
        <div className="flex flex-col gap-6 p-6">
            <PageHeader
                title={t('admin.flags.title')}
                description={t('admin.flags.description')}
            />

            <Card className="glass-chrome">
                <CardHeader>
                    <CardTitle className="text-base">{t('admin.flags.tableTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('admin.flags.colKey')}</TableHead>
                                <TableHead>{t('admin.flags.colDescription')}</TableHead>
                                <TableHead>{t('admin.flags.colUpdated')}</TableHead>
                                <TableHead className="w-20">{t('admin.flags.colEnabled')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                Array.from({ length: 5 }).map((_, i) => (
                                    <TableRow key={i}>
                                        {Array.from({ length: 4 }).map((__, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                            ) : flags?.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                                        {t('admin.flags.empty')}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                flags?.map((flag) => (
                                    <FlagRow
                                        key={flag.key}
                                        flag={flag}
                                        onToggle={(key, enabled) => mutation.mutate({ key, enabled })}
                                        isToggling={mutation.isPending}
                                        t={t}
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
