import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    SelectSettingRow,
    SettingRow,
    SettingsGroup,
} from "./SettingsPrimitives";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { AppSettings } from "@/stores/settingsStore";

export function AnalysisPreferencesSettings({
    value,
    onChange,
}: {
    value: AppSettings;
    onChange: (update: Partial<AppSettings>) => void;
}) {
    const { t } = useLanguage();
    const benchmarkId = useId();
    const [benchmarkDraft, setBenchmarkDraft] = useState(
        value.analysisBenchmark ?? "",
    );
    const [benchmarkError, setBenchmarkError] = useState(false);

    const saveBenchmark = () => {
        const normalized = benchmarkDraft.trim().toUpperCase();
        if (normalized && !/^[A-Z0-9][A-Z0-9._:-]{0,31}$/.test(normalized)) {
            setBenchmarkError(true);
            return;
        }
        setBenchmarkError(false);
        onChange({ analysisBenchmark: normalized || undefined });
        setBenchmarkDraft(normalized);
    };

    return (
        <SettingsGroup
            label={t("settings.analysisPreferences.title")}
            description={t("settings.analysisPreferences.description")}
        >
            <SelectSettingRow
                title={t("settings.analysisPreferences.answerDepth")}
                description={t("settings.analysisPreferences.answerDepthHint")}
                value={value.aiAnswerDepth ?? "product-default"}
                onValueChange={(next) =>
                    onChange({
                        aiAnswerDepth:
                            next === "product-default"
                                ? undefined
                                : (next as "quick" | "detailed"),
                    })
                }
                options={[
                    {
                        value: "product-default",
                        label: t("settings.analysisPreferences.productDefault"),
                    },
                    {
                        value: "quick",
                        label: t("settings.analysisPreferences.quick"),
                    },
                    {
                        value: "detailed",
                        label: t("settings.analysisPreferences.detailed"),
                    },
                ]}
            />
            <SettingRow
                title={t("settings.analysisPreferences.benchmark")}
                description={t("settings.analysisPreferences.benchmarkHint")}
                htmlFor={benchmarkId}
                layout="stack"
            >
                <div className="flex gap-2">
                    <Input
                        id={benchmarkId}
                        value={benchmarkDraft}
                        maxLength={32}
                        placeholder={t(
                            "settings.analysisPreferences.benchmarkPlaceholder",
                        )}
                        onChange={(event) =>
                            setBenchmarkDraft(event.target.value)
                        }
                        onBlur={saveBenchmark}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                            setBenchmarkDraft("");
                            setBenchmarkError(false);
                            onChange({ analysisBenchmark: undefined });
                        }}
                    >
                        {t("settings.analysisPreferences.clear")}
                    </Button>
                </div>
                {benchmarkError && (
                    <p role="alert" className="text-sm text-destructive">
                        {t("settings.analysisPreferences.invalidBenchmark")}
                    </p>
                )}
            </SettingRow>
        </SettingsGroup>
    );
}
