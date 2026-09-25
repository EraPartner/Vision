import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { setAgentCloakDesktopEnabled } from "@/lib/api/aiResearch";
import { aiKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { SettingsGroup, SettingRow } from "./SettingsPrimitives";
import {
    desktopStatusKey,
    useAgentCloakDesktopStatus,
} from "./useAgentCloakDesktopStatus";

export function AgentCloakDesktopSettingsSection() {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const statusQuery = useAgentCloakDesktopStatus();
    const toggle = useMutation({
        mutationFn: setAgentCloakDesktopEnabled,
        onSuccess: async (status) => {
            queryClient.setQueryData(desktopStatusKey, status);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: desktopStatusKey }),
                queryClient.invalidateQueries({
                    queryKey: aiKeys.openAiResearchStatus,
                }),
            ]);
        },
    });

    const status = statusQuery.data;
    const statusLabel = statusQuery.isPending
        ? t("settings.agentCloak.checking")
        : !status
          ? t("settings.agentCloak.statusError")
          : status.enabled && status.available && status.mappingKeyConfigured
            ? t("settings.agentCloak.active")
            : status.enabled
              ? t("settings.agentCloak.enabledUnavailable")
              : status.available
                ? t("settings.agentCloak.ready")
                : t("settings.agentCloak.notDetected");
    const statusError = toggle.error ?? statusQuery.error;
    const statusErrorMessage =
        statusError instanceof Error ? statusError.message : null;
    const canToggle = Boolean(status && (status.enabled || status.available));

    return (
        <SettingsGroup
            label={t("settings.agentCloak.section")}
            description={t("settings.agentCloak.description")}
        >
            <SettingRow
                title={t("settings.agentCloak.status")}
                layout="stack"
                description={
                    <span className="block space-y-1">
                        {!status?.openAiEnabled && status && (
                            <span className="block">
                                {t("settings.agentCloak.openAiHint")}
                            </span>
                        )}
                        {status && !status.available && (
                            <span className="block">
                                {t("settings.agentCloak.connectionHint")}
                            </span>
                        )}
                        {status?.enabled && !status.mappingKeyConfigured && (
                            <span className="block text-destructive">
                                {t("settings.agentCloak.keyMissingHint")}
                            </span>
                        )}
                        {statusError && (
                            <span
                                role="alert"
                                className="block text-destructive"
                            >
                                {statusErrorMessage ??
                                    t("settings.agentCloak.statusError")}
                            </span>
                        )}
                    </span>
                }
            >
                <span role="status" className="flex items-center gap-2 text-sm">
                    <span
                        aria-hidden="true"
                        className={cn(
                            "inline-block h-2 w-2 rounded-full",
                            status?.enabled &&
                                status.available &&
                                status.mappingKeyConfigured
                                ? "bg-success"
                                : status?.available
                                  ? "bg-muted-foreground/50"
                                  : "bg-destructive",
                        )}
                    />
                    {statusLabel}
                </span>
            </SettingRow>
            <SettingRow
                title={t("settings.agentCloak.protection")}
                description={t("settings.agentCloak.protectionHint")}
                layout="stack"
            >
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            toggle.reset();
                            void statusQuery.refetch();
                        }}
                        disabled={statusQuery.isFetching || toggle.isPending}
                    >
                        {t("settings.agentCloak.checkAgain")}
                    </Button>
                    <Button
                        size="sm"
                        variant={status?.enabled ? "outline" : "default"}
                        onClick={() => toggle.mutate(!status?.enabled)}
                        disabled={!canToggle || toggle.isPending}
                    >
                        {status?.enabled
                            ? t("settings.agentCloak.disable")
                            : t("settings.agentCloak.enable")}
                    </Button>
                </div>
            </SettingRow>
        </SettingsGroup>
    );
}
