import { memo, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { portfolioKeys } from '@/lib/queryKeys';
import { apiClient } from '@/lib/api';
import type { CostBasisMethod, StartupSection } from '@/stores/settingsStore';
import { SettingsSection, SettingsGroup, SettingRow, SelectSettingRow } from '../SettingsPrimitives';

const DISMISSED_RECURRING_PATTERNS_KEY = 'dismissed_recurring_patterns';

export const BehaviorSection = memo(function BehaviorSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();
    const queryClient = useQueryClient();

    // Opt-in "keep services running on quit" toggle — Electron-only, so it's
    // loaded/persisted through the desktop IPC bridge, not the AppSettings
    // context. Default OFF: an unconfigured install stops containers on quit.
    const [keepServicesOnQuit, setKeepServicesOnQuit] = useState(false);

    useEffect(() => {
        if (!apiClient.isElectron()) return;
        let cancelled = false;
        apiClient.loadServicesSettings()
            .then((s) => {
                if (cancelled || !s) return;
                setKeepServicesOnQuit(s.keepServicesOnQuit);
            })
            .catch(() => { /* leave default (off) — saves stay possible from there */ });
        return () => { cancelled = true; };
    }, []);

    const handleKeepServicesOnQuitChange = (v: boolean) => {
        setKeepServicesOnQuit(v);
        void apiClient.saveServicesSettings({ keepServicesOnQuit: v });
    };

    const handleCostBasisMethodChange = async (v: string) => {
        updateAppSettings({ costBasisMethod: v as CostBasisMethod });
        try {
            // Server-computed summaries (portfolioSummaryService) read the
            // top-level cost_basis_method setting, not the app_settings blob.
            await apiClient.saveSetting('cost_basis_method', v);
            await queryClient.invalidateQueries({ queryKey: portfolioKeys.summaryAll });
        } catch {
            toast.error(t('settings.saveFailed'));
        }
    };

    const handleResetRecurringDismissals = async () => {
        try {
            window.localStorage.removeItem(DISMISSED_RECURRING_PATTERNS_KEY);
        } catch { /* ignore */ }
        try {
            await apiClient.saveSetting(DISMISSED_RECURRING_PATTERNS_KEY, []);
            toast.success(t('settings.app.recurringDismissalsResetSuccess'));
        } catch {
            toast.error(t('settings.app.recurringDismissalsResetFailed'));
        }
    };

    return (
        <SettingsSection
            title={t('settings.section.behavior')}
            description={t('settings.section.behavior.desc')}
        >
            <SettingsGroup>
                <SelectSettingRow
                    title={t('settings.general.startupSection')}
                    description={t('settings.general.startupSectionHint')}
                    value={appSettings.startupSection ?? 'budgeting'}
                    onValueChange={(v) => updateAppSettings({ startupSection: v as StartupSection })}
                    options={[
                        { value: 'budgeting', label: t('nav.budgeting') },
                        { value: 'portfolio', label: t('nav.portfolio') },
                        { value: 'research', label: t('nav.research') },
                        { value: 'ai-chat', label: t('nav.aiChat') },
                        { value: 'last', label: t('settings.general.startupSection.last') },
                    ]}
                />

                <SelectSettingRow
                    title={t('settings.general.costBasisMethod')}
                    description={t('settings.general.costBasisMethodHint')}
                    value={appSettings.costBasisMethod ?? 'weighted_avg'}
                    onValueChange={(v) => { void handleCostBasisMethodChange(v); }}
                    triggerAriaLabel={t('settings.general.costBasisMethod')}
                    options={[
                        { value: 'weighted_avg', label: t('settings.general.costBasisMethod.weighted_avg') },
                        { value: 'fifo', label: t('settings.general.costBasisMethod.fifo') },
                        { value: 'lifo', label: t('settings.general.costBasisMethod.lifo') },
                    ]}
                />

                <SettingRow
                    title={t('settings.general.autoClearPlanned')}
                    description={t('settings.general.autoClearPlannedHint')}
                    htmlFor="auto-clear-planned"
                >
                    <Switch
                        id="auto-clear-planned"
                        checked={appSettings.autoClearPlannedOnMatch ?? true}
                        onCheckedChange={(v) => updateAppSettings({ autoClearPlannedOnMatch: v })}
                    />
                </SettingRow>

                {apiClient.isElectron() && (
                    <SettingRow
                        title={t('settings.general.keepServicesOnQuit')}
                        description={t('settings.general.keepServicesOnQuitHint')}
                        htmlFor="keep-services-on-quit"
                    >
                        <Switch
                            id="keep-services-on-quit"
                            checked={keepServicesOnQuit}
                            onCheckedChange={handleKeepServicesOnQuitChange}
                        />
                    </SettingRow>
                )}
            </SettingsGroup>

            <SettingsGroup>
                <SettingRow title={t('settings.app.recurringDismissalsReset')} description={t('settings.app.recurringDismissalsResetHint')}>
                    <Button variant="outline" size="sm" onClick={() => { void handleResetRecurringDismissals(); }}>
                        {t('settings.app.reset')}
                    </Button>
                </SettingRow>
            </SettingsGroup>
        </SettingsSection>
    );
});
