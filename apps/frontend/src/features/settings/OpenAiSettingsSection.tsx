import { useId } from "react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    SettingsGroup,
    SettingRow,
} from "@/features/settings/SettingsPrimitives";
import { useAiResearchStatus } from "@/hooks/useAiResearchStatus";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface OpenAiSettingsSectionProps {
    value: string | undefined;
    onChange: (model: string) => void;
}

export function OpenAiSettingsSection({
    value,
    onChange,
}: OpenAiSettingsSectionProps) {
    const { t } = useLanguage();
    const modelLabelId = useId();
    const { data: status, isLoading } = useAiResearchStatus();
    const models = status?.openai.models ?? [];
    const configuredValue = models.some((model) => model.id === value)
        ? value
        : status?.openai.model;
    const selectValue = configuredValue ?? models[0]?.id ?? "";
    const enabled = Boolean(status?.openai.enabled && models.length > 0);

    return (
        <SettingsGroup label={t("settings.aiOpenAi.section")}>
            <SettingRow
                title={t("settings.aiOpenAi.defaultModel")}
                description={t("settings.aiOpenAi.defaultModelHint")}
                labelId={modelLabelId}
                layout="stack"
            >
                <Select
                    value={selectValue}
                    onValueChange={onChange}
                    disabled={isLoading || !enabled}
                >
                    <SelectTrigger aria-labelledby={modelLabelId}>
                        <SelectValue
                            placeholder={
                                isLoading
                                    ? t("settings.aiOpenAi.loadingModels")
                                    : models.length > 0
                                      ? t("settings.aiOpenAi.selectModel")
                                      : t("settings.aiOpenAi.noModels")
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {models.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                                {model.label} ({model.id})
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </SettingRow>
        </SettingsGroup>
    );
}
