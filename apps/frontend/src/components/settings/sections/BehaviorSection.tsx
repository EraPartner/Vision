import { memo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { apiClient } from '@/lib/api';
import type { CostBasisMethod, StartupSection } from '@/stores/settingsStore';
import { SettingsSection, SettingsGroup, SettingRow } from '../SettingsPrimitives';

const DISMISSED_RECURRING_PATTERNS_KEY = 'dismissed_recurring_patterns';

export const BehaviorSection = memo(function BehaviorSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

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
                <SettingRow title={t('settings.general.startupSection')} description={t('settings.general.startupSectionHint')} layout="stack">
                    <Select
                        value={appSettings.startupSection ?? 'budgeting'}
                        onValueChange={(v) => updateAppSettings({ startupSection: v as StartupSection })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="budgeting">{t('nav.budgeting')}</SelectItem>
                            <SelectItem value="portfolio">{t('nav.portfolio')}</SelectItem>
                            <SelectItem value="research">{t('nav.research')}</SelectItem>
                            <SelectItem value="ai-chat">{t('nav.aiChat')}</SelectItem>
                            <SelectItem value="last">{t('settings.general.startupSection.last')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.costBasisMethod')} description={t('settings.general.costBasisMethodHint')} layout="stack">
                    <Select
                        value={appSettings.costBasisMethod ?? 'weighted_avg'}
                        onValueChange={(v) => updateAppSettings({ costBasisMethod: v as CostBasisMethod })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="weighted_avg">{t('settings.general.costBasisMethod.weighted_avg')}</SelectItem>
                            <SelectItem value="fifo">{t('settings.general.costBasisMethod.fifo')}</SelectItem>
                            <SelectItem value="lifo">{t('settings.general.costBasisMethod.lifo')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

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
