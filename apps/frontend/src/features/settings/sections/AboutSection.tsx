import { useState, memo } from "react";
import { safeHref } from "@/utils/safeHref";
import { ExternalLink, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useOnboarding } from "@/features/onboarding/useOnboarding";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useSettings } from "@/stores/hydration/SettingsHydration";
import { apiClient } from "@/lib/api";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { updateStatusKeys, useUpdateStatus } from "@/hooks/useUpdateStatus";
import { cn } from "@/lib/utils";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import {
    SettingsSection,
    SettingsGroup,
    SettingRow,
} from "../SettingsPrimitives";
import { electronErrorToMessage } from "@/lib/api/electronErrorMessage";
import type { UpdateCheckStatus } from "@/lib/api/electron";
import { VisionMark } from "@/components/shared/VisionMark";
import {
    APP_DOCUMENTATION_URL,
    APP_LICENSE,
    APP_NAME,
    APP_REPOSITORY_URL,
    APP_VERSION,
} from "@/lib/appIdentity";

type ApplyPhase = "idle" | "backing-up" | "downloading" | "restarting" | "done";

interface AboutSectionProps {
    onOpenChange: (open: boolean) => void;
}

export const AboutSection = memo(function AboutSection({
    onOpenChange,
}: AboutSectionProps) {
    const { t } = useLanguage();
    const { reset: resetOnboarding } = useOnboarding();
    const { appSettings, updateAppSettings, resetAppSettings } =
        useAppSettings();
    const { resetSettings } = useSettings();
    const queryClient = useQueryClient();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    // The sidebar's update dot and this section read one shared status
    // (ADR-180); a manual check refreshes both.
    const { data: polledUpdateStatus } = useUpdateStatus();
    const [checkedUpdateStatus, setCheckedUpdateStatus] =
        useState<UpdateCheckStatus | null>(null);
    const updateStatus = checkedUpdateStatus ?? polledUpdateStatus ?? null;
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [applyPhase, setApplyPhase] = useState<ApplyPhase>("idle");
    const applyingUpdate = applyPhase !== "idle" && applyPhase !== "done";

    const handleRestartOnboarding = () => {
        resetOnboarding();
        onOpenChange(false);
        toast.success(t("settings.app.onboardingRestarted"));
        setTimeout(() => window.location.reload(), 500);
    };

    const handleCheckForUpdates = async () => {
        setCheckingUpdate(true);
        try {
            const result = await apiClient.checkForUpdates();
            setCheckedUpdateStatus(result);
            queryClient.setQueryData(updateStatusKeys.check, result);
            if (result.up_to_date) {
                toast.success(t("settings.app.upToDate"));
            } else {
                toast.info(
                    `${t("settings.app.updateAvailable")} ${result.latest_version}`,
                );
            }
        } catch {
            toast.error(t("settings.app.updateFailed"));
        } finally {
            setCheckingUpdate(false);
        }
    };

    const handleApplyUpdate = async () => {
        if (apiClient.isElectron()) {
            setApplyPhase("backing-up");
            try {
                const backupResult = await apiClient.preUpdateBackup();
                if (backupResult && !backupResult.success) {
                    toast.error(t("update.backupFailed"), {
                        description: electronErrorToMessage(
                            backupResult.error,
                            t,
                        ),
                    });
                    setApplyPhase("idle");
                    return;
                }
            } catch (err: unknown) {
                const msg = electronErrorToMessage(err, t);
                toast.error(t("update.backupFailed"), { description: msg });
                setApplyPhase("idle");
                return;
            }
        }

        setApplyPhase("downloading");
        try {
            const result = await apiClient.installShellUpdate();
            if (result === null) {
                toast.info(t("settings.app.updateAutoApply"));
                setApplyPhase("idle");
                return;
            }
            // No installable source-launcher asset on this release — the main
            // process opened the release page. A redirect, not a failure.
            if (result.manual_download) {
                toast.info(t("update.manualDownload"));
                setApplyPhase("idle");
                return;
            }
            if (!result.success) {
                toast.error(t("settings.app.updateFailed"), {
                    description: electronErrorToMessage(result.error, t),
                });
                setApplyPhase("idle");
                return;
            }
            setApplyPhase("restarting");
            toast.success(t("settings.app.updateComplete"), {
                description: t("settings.app.nowRunning", {
                    version:
                        result.version ?? updateStatus?.latest_version ?? "",
                }),
                duration: 8000,
            });
        } catch (err: unknown) {
            const msg = electronErrorToMessage(err, t);
            toast.error(t("settings.app.updateFailed"), { description: msg });
            setApplyPhase("idle");
        }
    };

    const handleResetAll = async () => {
        const confirmed = await confirm({
            title: t("settings.app.resetAllConfirm.title"),
            description: t("settings.app.resetAllConfirm.desc"),
            confirmLabel: t("settings.app.resetAllConfirm.action"),
            variant: "destructive",
        });
        if (!confirmed) return;
        resetSettings();
        resetAppSettings(); // also clears the session tier override
        apiClient
            .saveSetting("includeTransfers", false)
            .then(() => queryClient.invalidateQueries())
            .catch(() => {
                /* non-fatal */
            });
        toast.info(t("settings.resetToDefaults"));
    };

    const releaseNotesHref = updateStatus
        ? safeHref(updateStatus.html_url)
        : undefined;

    return (
        <SettingsSection title={t("settings.section.about")}>
            {/* Identity */}
            <Card>
                <CardContent
                    variant="headerless"
                    className="flex flex-col gap-4 sm:flex-row sm:items-center"
                >
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card corner-continuous bg-primary text-primary-foreground">
                        <VisionMark className="h-8 w-8" title={APP_NAME} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="type-title-2 text-foreground">
                            {APP_NAME}
                        </h3>
                        <p className="type-body text-label-secondary">
                            {t("settings.app.version", {
                                version: APP_VERSION,
                            })}
                        </p>
                        <p className="type-footnote text-label-tertiary">
                            {t("settings.app.license", {
                                license: APP_LICENSE,
                            })}
                        </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                        <Button variant="outline" asChild>
                            <a
                                href={APP_REPOSITORY_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {t("settings.app.sourceCode")}
                                <ExternalLink
                                    aria-hidden="true"
                                    className="ml-1.5 h-3.5 w-3.5"
                                />
                            </a>
                        </Button>
                        <Button variant="outline" asChild>
                            <a
                                href={APP_DOCUMENTATION_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {t("settings.app.documentation")}
                                <ExternalLink
                                    aria-hidden="true"
                                    className="ml-1.5 h-3.5 w-3.5"
                                />
                            </a>
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Updates */}
            <SettingsGroup
                label={t("settings.app.updates")}
                description={
                    apiClient.isElectron()
                        ? t("settings.app.updatesHintElectron")
                        : t("settings.app.updatesHintWeb")
                }
            >
                {updateStatus && (
                    <SettingRow
                        title={
                            updateStatus.up_to_date ? (
                                <>
                                    {t("settings.app.runningLatest")}
                                    {updateStatus.current_version
                                        ? ` (${updateStatus.current_version})`
                                        : ""}
                                    .
                                </>
                            ) : (
                                <>
                                    {t("settings.app.versionAvailable", {
                                        version:
                                            updateStatus.latest_version ?? "",
                                    })}
                                    {updateStatus.current_version
                                        ? ` (${t("settings.app.current")} ${updateStatus.current_version})`
                                        : ""}
                                    .
                                </>
                            )
                        }
                        description={
                            <>
                                {!updateStatus.up_to_date &&
                                    updateStatus.published_at && (
                                        <span className="block">
                                            {t("settings.app.released")}{" "}
                                            {formatDateStringWithAppSettings(
                                                updateStatus.published_at,
                                                appSettings.dateFormat,
                                            )}
                                        </span>
                                    )}
                                {!updateStatus.up_to_date &&
                                    updateStatus.release_notes && (
                                        <span className="line-clamp-2 block">
                                            {updateStatus.release_notes}
                                        </span>
                                    )}
                                {updateStatus.error && (
                                    <span className="block text-destructive">
                                        {updateStatus.error}
                                    </span>
                                )}
                            </>
                        }
                        className={cn(
                            updateStatus.up_to_date
                                ? "[&_p:first-child]:text-success"
                                : "[&_p:first-child]:text-warning",
                        )}
                    >
                        {/* Gate on the resolved href: a rejected URL used to
                            leave this icon rendered, hoverable and tooltipped,
                            pointing at nothing. */}
                        {releaseNotesHref && (
                            <Button variant="ghost" size="sm" asChild>
                                <a
                                    href={releaseNotesHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t("aria.openReleaseNotes")}
                                >
                                    {t("update.releaseNotes")}
                                    <ExternalLink
                                        aria-hidden="true"
                                        className="ml-1.5 h-3.5 w-3.5"
                                    />
                                </a>
                            </Button>
                        )}
                    </SettingRow>
                )}

                <SettingRow
                    title={t("settings.app.checkForUpdates")}
                    description={
                        applyingUpdate ? (
                            <span className="flex items-center gap-2">
                                <Loader2
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5 animate-spin"
                                />
                                {applyPhase === "backing-up"
                                    ? t("update.backingUp")
                                    : applyPhase === "downloading"
                                      ? t("update.downloading")
                                      : t("settings.app.restarting")}
                            </span>
                        ) : undefined
                    }
                >
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button
                            variant="outline"
                            onClick={() => {
                                void handleCheckForUpdates();
                            }}
                            disabled={checkingUpdate || applyingUpdate}
                        >
                            {checkingUpdate && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            )}
                            {t("settings.app.checkForUpdates")}
                        </Button>
                        {apiClient.isElectron() &&
                            updateStatus &&
                            !updateStatus.up_to_date && (
                                <Button
                                    onClick={() => {
                                        void handleApplyUpdate();
                                    }}
                                    disabled={applyingUpdate || checkingUpdate}
                                >
                                    {applyingUpdate && (
                                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                    )}
                                    {applyPhase === "restarting"
                                        ? t("settings.app.restarting2")
                                        : applyingUpdate
                                          ? t("update.installing")
                                          : t("settings.app.installUpdate")}
                                </Button>
                            )}
                    </div>
                </SettingRow>
            </SettingsGroup>

            {/* Setup and developer */}
            <SettingsGroup>
                <SettingRow
                    title={t("settings.app.onboardingWizard")}
                    description={t("settings.app.onboardingWizardHint")}
                >
                    <Button variant="outline" onClick={handleRestartOnboarding}>
                        {t("settings.app.restart")}
                    </Button>
                </SettingRow>

                <SettingRow
                    title={t("settings.app.adminMode")}
                    description={t("settings.app.adminModeHint")}
                    htmlFor="admin-mode"
                >
                    <Switch
                        id="admin-mode"
                        checked={appSettings.adminMode ?? false}
                        onCheckedChange={(v) =>
                            updateAppSettings({ adminMode: v })
                        }
                    />
                </SettingRow>
            </SettingsGroup>

            {/* Reset */}
            <SettingsGroup label={t("settings.app.reset")}>
                <SettingRow
                    title={t("settings.app.resetAll")}
                    description={t("settings.app.resetAllHint")}
                    destructive
                >
                    <Button
                        variant="outline"
                        onClick={() => void handleResetAll()}
                        className="text-destructive hover:text-destructive"
                    >
                        {t("settings.app.reset")}
                    </Button>
                </SettingRow>
            </SettingsGroup>
            <ConfirmDialog />
        </SettingsSection>
    );
});
