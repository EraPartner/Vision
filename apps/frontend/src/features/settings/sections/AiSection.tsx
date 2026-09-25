import { memo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { AIChatSettingsSection } from "@/features/settings/AIChatSettingsSection";
import { OpenAiSettingsSection } from "@/features/settings/OpenAiSettingsSection";
import { ResearchKeysSection } from "@/features/settings/ResearchKeysSection";
import { AgentCloakDesktopSettingsSection } from "@/features/settings/AgentCloakDesktopSettingsSection";
import { AnalysisPreferencesSettings } from "@/features/settings/AnalysisPreferencesSettings";
import { SettingsSection } from "../SettingsPrimitives";

export const AiSection = memo(function AiSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    return (
        <SettingsSection
            title={t("settings.section.ai")}
            description={t("settings.section.ai.desc")}
        >
            <AIChatSettingsSection
                value={appSettings.aiDefaultModel}
                onChange={(model) =>
                    updateAppSettings({ aiDefaultModel: model })
                }
            />
            <OpenAiSettingsSection
                value={appSettings.openAiDefaultModel}
                onChange={(model) =>
                    updateAppSettings({ openAiDefaultModel: model })
                }
            />
            <AgentCloakDesktopSettingsSection />
            <AnalysisPreferencesSettings
                value={appSettings}
                onChange={updateAppSettings}
            />
            <ResearchKeysSection />
        </SettingsSection>
    );
});
