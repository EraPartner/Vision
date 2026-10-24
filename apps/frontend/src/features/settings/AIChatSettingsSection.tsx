import { useId } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/stores/hydration/LanguageHydration';
import { useOllamaStatus, useOllamaModels } from '@/hooks/useOllamaStatus';
import { useModelFit } from '@/hooks/useModelFit';
import { cn } from '@/lib/utils';
import { SettingsGroup, SettingRow } from '@/features/settings/SettingsPrimitives';

const GIB = 1024 ** 3;

const oneDecimal = (bytes: number) => (bytes / GIB).toFixed(1);

interface AIChatSettingsSectionProps {
    value: string | undefined;
    onChange: (model: string) => void;
}

export function AIChatSettingsSection({ value, onChange }: AIChatSettingsSectionProps) {
    const { t } = useLanguage();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const { data: models, isLoading: modelsLoading } = useOllamaModels(Boolean(status?.ok));
    const modelLabelId = useId();

    const statusDotClass = statusLoading
        ? 'bg-label-tertiary'
        : status?.ok
            ? 'bg-success'
            : 'bg-destructive';

    const statusLabel = statusLoading
        ? t('settings.aiChat.statusChecking')
        : status?.ok
            ? t('settings.aiChat.statusReady')
            : t('settings.aiChat.statusUnreachable');

    const modelOptions = models ?? [];
    const hasModels = modelOptions.length > 0;
    const selectValue = value ?? status?.defaultModel ?? '';
    const { data: fit } = useModelFit(status?.ok ? selectValue || undefined : undefined);
    const fitLine =
        fit?.weightBytes != null && fit.kvBytesPerToken != null && fit.maxNumCtx != null
            ? t('settings.aiChat.modelFit', {
                weights: oneDecimal(fit.weightBytes),
                context: oneDecimal(fit.kvBytesPerToken * fit.maxNumCtx),
                total: Math.round(fit.totalMemoryBytes / GIB),
            })
            : null;
    const statusDescription = (
        <span className="block space-y-1">
            {(status?.displayUrl || status?.baseUrl) && (
                <span className="block break-all font-mono text-label-secondary">
                    {status.displayUrl || status.baseUrl}
                </span>
            )}
            {!status?.ok && !statusLoading && status?.error && (
                <span className="block text-destructive">{status.error}</span>
            )}
            {!status?.ok && !statusLoading && status?.hint && (
                <span className="block text-label-secondary">{status.hint}</span>
            )}
        </span>
    );

    return (
        <SettingsGroup label={t('settings.aiChat.section')}>
            <SettingRow title={t('settings.aiChat.status')} description={statusDescription}>
                <div className="flex items-center gap-2">
                    <span aria-hidden="true" className={cn('inline-block h-2 w-2 rounded-full', statusDotClass)} />
                    <span className="type-body text-foreground">{statusLabel}</span>
                </div>
            </SettingRow>
            <SettingRow
                title={t('settings.aiChat.defaultModel')}
                description={t('settings.aiChat.defaultModelHint')}
                labelId={modelLabelId}
                layout="stack"
            >
                <div className="space-y-1.5">
                    <Select
                        {...(selectValue ? { value: selectValue } : {})}
                        onValueChange={onChange}
                        disabled={!status?.ok || modelsLoading || !hasModels}
                    >
                        <SelectTrigger aria-labelledby={modelLabelId}>
                            <SelectValue
                                placeholder={
                                    !status?.ok
                                        ? t('settings.aiChat.statusUnreachable')
                                        : modelsLoading
                                            ? t('settings.aiChat.loadingModels')
                                            : hasModels
                                                ? t('settings.aiChat.selectModel')
                                                : t('settings.aiChat.noModels')
                                }
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {modelOptions.map((m) => (
                                <SelectItem key={m.name} value={m.name}>
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {fitLine && (
                        <div className="space-y-0.5 type-footnote text-label-secondary">
                            <p>{fitLine}</p>
                            <p>{t('settings.aiChat.modelFitTip')}</p>
                        </div>
                    )}
                </div>
            </SettingRow>
        </SettingsGroup>
    );
}
