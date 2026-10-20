import { memo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { AIChatSettingsSection } from "@/features/settings/AIChatSettingsSection";
import { ResearchKeysSection } from "@/features/settings/ResearchKeysSection";
import { AnalysisPreferencesSettings } from "@/features/settings/AnalysisPreferencesSettings";
import { SettingsSection } from "../SettingsPrimitives";

export const AiSection = memo(function AiSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    return (
        <SettingsSection title={t("settings.section.ai")}>
            <AIChatSettingsSection
                value={appSettings.aiDefaultModel}
                onChange={(model) =>
                    updateAppSettings({ aiDefaultModel: model })
                }
            />
            <AnalysisPreferencesSettings
                value={appSettings}
                onChange={updateAppSettings}
            />
            <ResearchKeysSection />
        </SettingsSection>
    );
});
