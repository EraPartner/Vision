import { memo } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { AIChatSettingsSection } from '@/components/settings/AIChatSettingsSection';
import { ResearchKeysSection } from '@/components/settings/ResearchKeysSection';
import { SettingsSection } from '../SettingsPrimitives';

export const AiSection = memo(function AiSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    return (
        <SettingsSection
            title={t('settings.section.ai')}
            description={t('settings.section.ai.desc')}
        >
            <AIChatSettingsSection
                value={appSettings.aiDefaultModel}
                onChange={(model) => updateAppSettings({ aiDefaultModel: model })}
            />
            <ResearchKeysSection />
        </SettingsSection>
    );
});
