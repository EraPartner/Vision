import { Bot } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOllamaStatus, useOllamaModels } from '@/hooks/useOllamaStatus';

interface AIChatSettingsSectionProps {
    value: string | undefined;
    onChange: (model: string) => void;
}

export function AIChatSettingsSection({ value, onChange }: AIChatSettingsSectionProps) {
    const { t } = useLanguage();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const { data: models, isLoading: modelsLoading } = useOllamaModels(Boolean(status?.ok));

    const statusDotClass = statusLoading
        ? 'bg-muted-foreground/50'
        : status?.ok
            ? 'bg-emerald-500'
            : 'bg-destructive';

    const statusLabel = statusLoading
        ? t('settings.aiChat.statusChecking')
        : status?.ok
            ? t('settings.aiChat.statusReady')
            : t('settings.aiChat.statusUnreachable');

    const modelOptions = models ?? [];
    const hasModels = modelOptions.length > 0;
    const selectValue = value ?? status?.defaultModel ?? '';

    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                {t('settings.aiChat.section')}
            </h3>

            <div className="rounded-lg border p-4 space-y-4">
                <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">
                        {t('settings.aiChat.status')}
                    </Label>
                    <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${statusDotClass}`} />
                        <span className="text-sm text-foreground">{statusLabel}</span>
                    </div>
                    {(status?.displayUrl || status?.baseUrl) && (
                        <p className="text-xs font-mono text-muted-foreground break-all">
                            {status.displayUrl || status.baseUrl}
                        </p>
                    )}
                    {!status?.ok && !statusLoading && status?.error && (
                        <p className="text-xs text-destructive">{status.error}</p>
                    )}
                    {!status?.ok && !statusLoading && status?.hint && (
                        <p className="text-xs text-muted-foreground">{status.hint}</p>
                    )}
                </div>

                <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">
                        {t('settings.aiChat.defaultModel')}
                    </Label>
                    <Select
                        value={selectValue || undefined}
                        onValueChange={onChange}
                        disabled={!status?.ok || modelsLoading || !hasModels}
                    >
                        <SelectTrigger>
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
                    <p className="text-xs text-muted-foreground">
                        {t('settings.aiChat.defaultModelHint')}
                    </p>
                </div>
            </div>
        </div>
    );
}
