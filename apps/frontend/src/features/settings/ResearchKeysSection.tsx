import { useId, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
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
import { SettingsGroup, SettingRow } from '@/features/settings/SettingsPrimitives';

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
        <SettingsGroup
            label={t('settings.research.section')}
            description={t('settings.research.hint')}
        >
            {(data?.items ?? []).map((status) => (
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
                <SettingRow title={t('settings.research.loading')}>
                    <span className="text-xs text-muted-foreground">…</span>
                </SettingRow>
            )}
        </SettingsGroup>
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
    const inputId = useId();

    const sourceLabel =
        status.source === 'settings'
            ? t('settings.research.sourceSettings')
            : status.source === 'env'
                ? t('settings.research.sourceEnv')
                : t('settings.research.sourceNone');

    return (
        <SettingRow
            title={(
                <span className="flex min-w-0 items-center gap-2">
                    {status.label}
                    {status.configured && <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />}
                </span>
            )}
            description={(
                <span className={cn(status.configured ? 'text-success' : 'text-muted-foreground')}>
                    {sourceLabel}{status.masked ? ` · ${status.masked}` : ''}
                </span>
            )}
            htmlFor={inputId}
            layout="stack"
        >
            <div className="flex items-center gap-2">
                <Input
                    id={inputId}
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
            <p className="text-2xs text-muted-foreground font-mono">{status.envVar}</p>
        </SettingRow>
    );
}
