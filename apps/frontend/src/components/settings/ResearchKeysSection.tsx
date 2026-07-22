import { useState } from 'react';
import { KeyRound, CheckCircle2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { researchKeys } from '@/lib/queryKeys';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import {
    getResearchProviderKeys,
    setResearchProviderKey,
    clearResearchProviderKey,
} from '@/lib/api/research';
import type { ProviderKeyStatus } from '@/types/research';

/**
 * Settings section for the keyed research providers (ADR-079). Self-contained:
 * fetches masked key statuses and lets the user set/clear each provider's key.
 * The full key is never returned by the API — only a masked tail.
 */
export function ResearchKeysSection() {
    const { t } = useLanguage();
    const queryClient = useQueryClient();

    const { data, isLoading } = useQuery({
        queryKey: researchKeys.providerKeys,
        queryFn: getResearchProviderKeys,
        staleTime: 60_000,
    });

    const invalidate = () =>
        queryClient.invalidateQueries({ queryKey: researchKeys.providerKeys });

    const saveMutation = useMutation({
        mutationFn: ({ provider, apiKey }: { provider: string; apiKey: string }) =>
            setResearchProviderKey(provider, apiKey),
        onSuccess: () => { invalidate(); toast.success(t('settings.research.saved')); },
        onError: () => toast.error(t('settings.research.saveFailed')),
    });

    const clearMutation = useMutation({
        mutationFn: (provider: string) => clearResearchProviderKey(provider),
        onSuccess: () => { invalidate(); toast.success(t('settings.research.cleared')); },
        onError: () => toast.error(t('settings.research.clearFailed')),
    });

    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                {t('settings.research.section')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('settings.research.hint')}</p>
            <div className="rounded-lg border divide-y">
                {(data?.providers ?? []).map((status) => (
                    <ProviderKeyRow
                        key={status.provider}
                        status={status}
                        onSave={(apiKey) => saveMutation.mutate({ provider: status.provider, apiKey })}
                        onClear={() => clearMutation.mutate(status.provider)}
                        saving={saveMutation.isPending}
                        clearing={clearMutation.isPending}
                    />
                ))}
                {isLoading && (
                    <div className="p-4 text-xs text-muted-foreground">{t('settings.research.loading')}</div>
                )}
            </div>
        </div>
    );
}

interface ProviderKeyRowProps {
    status: ProviderKeyStatus;
    onSave: (apiKey: string) => void;
    onClear: () => void;
    saving: boolean;
    clearing: boolean;
}

function ProviderKeyRow({ status, onSave, onClear, saving, clearing }: ProviderKeyRowProps) {
    const { t } = useLanguage();
    const [value, setValue] = useState('');

    const sourceLabel =
        status.source === 'settings'
            ? t('settings.research.sourceSettings')
            : status.source === 'env'
                ? t('settings.research.sourceEnv')
                : t('settings.research.sourceNone');

    return (
        <div className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground">{status.label}</span>
                    {status.configured && <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />}
                </div>
                <span className={cn('text-xs', status.configured ? 'text-success' : 'text-muted-foreground')}>
                    {sourceLabel}{status.masked ? ` · ${status.masked}` : ''}
                </span>
            </div>
            <div className="flex items-center gap-2">
                <Input
                    type="password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={t('settings.research.placeholder')}
                    className="h-8 text-sm font-mono"
                    autoComplete="off"
                />
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!value.trim() || saving}
                    onClick={() => { onSave(value.trim()); setValue(''); }}
                >
                    {t('settings.research.save')}
                </Button>
                {status.source === 'settings' && (
                    <Button size="sm" variant="ghost" disabled={clearing} onClick={onClear}>
                        {t('settings.research.clear')}
                    </Button>
                )}
            </div>
            <p className="text-[11px] text-muted-foreground font-mono">{status.envVar}</p>
        </div>
    );
}
