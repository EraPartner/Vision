import { useCallback, useEffect, useRef, useState } from "react";
import { safeHref } from "@/utils/safeHref";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowUpCircle, Download, ExternalLink, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { electronErrorToMessage } from "@/lib/api/electronErrorMessage";
import type { UpdateCheckStatus } from "@/lib/api/electron";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type ApplyPhase =
    "idle" | "backing-up" | "downloading" | "pulling" | "restarting" | "done";

export function UpdateNotification() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const [status, setStatus] = useState<UpdateCheckStatus | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [phase, setPhase] = useState<ApplyPhase>("idle");
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const mountedRef = useRef(true);

    const check = useCallback(async () => {
        try {
            const data = await apiClient.checkForUpdates();
            if (mountedRef.current) setStatus(data);
        } catch {
            // Silently ignore — don't disrupt the app if the update check fails
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        check();
        timerRef.current = setInterval(() => {
            if (!document.hidden) check();
        }, CHECK_INTERVAL_MS);
        return () => {
            mountedRef.current = false;
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [check]);

    const handleInstall = async () => {
        const mode = status?.update_mode ?? "source";

        // Step 1: pre-update backup (Electron only)
        if (apiClient.isElectron()) {
            setPhase("backing-up");
            try {
                const backupResult = await apiClient.preUpdateBackup();
                if (backupResult && !backupResult.success) {
                    toast.error(t("update.backupFailed"), {
                        description: electronErrorToMessage(
                            backupResult.error,
                            t,
                        ),
                    });
                    setPhase("idle");
                    return;
                }
            } catch (err) {
                const msg = electronErrorToMessage(err, t);
                toast.error(t("update.backupFailed"), { description: msg });
                setPhase("idle");
                return;
            }
        }

        // Step 2: apply update based on mode
        if (mode === "docker") {
            setPhase("pulling");
            try {
                const result = await apiClient.triggerDockerUpdate();
                if (!result?.success) {
                    toast.error(t("update.failed"), {
                        description: electronErrorToMessage(result?.error, t),
                    });
                    setPhase("idle");
                    return;
                }
                setPhase("restarting");
                setDialogOpen(false);
                toast.success(t("update.complete"), {
                    description: t("update.nowRunning", {
                        version: status?.latest_version ?? "",
                    }),
                    duration: 6000,
                });
                setPhase("done");
            } catch (err) {
                const msg = electronErrorToMessage(err, t);
                toast.error(t("update.failed"), { description: msg });
                setPhase("idle");
            }
            return;
        }

        // source / dev mode: shell update
        setPhase("downloading");
        try {
            const result = await apiClient.installShellUpdate();

            if (result === null) {
                toast.info(t("update.reloadHint"));
                setPhase("idle");
                setDialogOpen(false);
                return;
            }

            // The release has no installable source-launcher asset — the main
            // process opened the release page instead. That is a redirect, not
            // a failure, so don't shout at the user with an error toast.
            if (result.manual_download) {
                toast.info(t("update.manualDownload"));
                setPhase("idle");
                setDialogOpen(false);
                return;
            }

            if (!result.success) {
                toast.error(t("update.failed"), {
                    description: electronErrorToMessage(result.error, t),
                });
                setPhase("idle");
                return;
            }

            setPhase("restarting");
            setDialogOpen(false);
            toast.success(t("update.complete"), {
                description: t("update.nowRunning", {
                    version: result.version ?? status?.latest_version ?? "",
                }),
                duration: 6000,
            });
        } catch (err) {
            const msg = electronErrorToMessage(err, t);
            toast.error(t("update.failed"), { description: msg });
            setPhase("idle");
        }
    };

    // Nothing to show when up to date or status not yet known
    if (!status || status.up_to_date) return null;

    const isApplying = phase !== "idle" && phase !== "done";
    // Only the Electron shell can actually install an update from inside the
    // app. In a browser (docker-compose self-host, or the web build) every
    // install path is a no-op — installShellUpdate() returns null and
    // triggerDockerUpdate() has no IPC bridge — so we show the command the
    // operator has to run instead of a button that does nothing.
    const canInstallInApp = apiClient.isElectron();

    const phaseLabel = () => {
        switch (phase) {
            case "backing-up":
                return t("update.backingUp");
            case "downloading":
                return t("update.downloading");
            case "pulling":
                return t("update.pulling");
            case "restarting":
                return t("update.restarting");
            default:
                return "";
        }
    };

    return (
        <>
            {/* Compact badge in the header */}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                    setPhase("idle");
                    setDialogOpen(true);
                }}
                className="gap-1.5 text-warning hover:text-warning hover:bg-warning/10 font-medium text-xs h-8 px-2.5"
                title={t("update.versionAvailable", {
                    version: status.latest_version ?? "",
                })}
            >
                <ArrowUpCircle className="h-4 w-4" />
                <span className="hidden sm:inline">{t("update.badge")}</span>
            </Button>

            {/* Update dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    if (!isApplying) setDialogOpen(open);
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ArrowUpCircle className="h-5 w-5 text-warning" />
                            {t("update.title")}
                        </DialogTitle>
                        <DialogDescription>
                            {t("update.versionAvailable", {
                                version: status.latest_version ?? "",
                            })}
                            {status.current_version
                                ? ` ${t("update.current", { version: status.current_version })}`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>

                    {status.published_at && (
                        <p className="text-xs text-muted-foreground -mt-2">
                            {t("update.released")}{" "}
                            {formatDateStringWithAppSettings(
                                status.published_at,
                                appSettings.dateFormat,
                            )}
                        </p>
                    )}

                    {status.release_notes && (
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                            <p className="text-xs text-muted-foreground mb-1">
                                {t("update.whatsNew")}
                            </p>
                            <p className="text-foreground whitespace-pre-line line-clamp-6">
                                {status.release_notes}
                            </p>
                        </div>
                    )}

                    {/* Non-Electron deployments update from the command line */}
                    {!canInstallInApp && (
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                            <p className="text-muted-foreground">
                                {t("update.dockerComposeHint")}
                            </p>
                            <code className="mt-1.5 block break-all font-mono text-xs text-foreground">
                                docker compose pull &amp;&amp; docker compose up
                                -d
                            </code>
                        </div>
                    )}

                    {/* Phase indicator */}
                    {isApplying && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {phaseLabel()}
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        {/* Gate on the resolved href: a rejected URL used to leave
                            a fully enabled-looking button that did nothing. */}
                        {safeHref(status.html_url) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                asChild
                                className="mr-auto"
                            >
                                <a
                                    href={safeHref(status.html_url)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                                    {t("update.releaseNotes")}
                                </a>
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            onClick={() => setDialogOpen(false)}
                            disabled={isApplying}
                        >
                            {t("update.later")}
                        </Button>
                        {canInstallInApp && (
                            <Button
                                onClick={handleInstall}
                                disabled={isApplying}
                                className="gap-2"
                            >
                                {isApplying ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" />{" "}
                                        {phaseLabel()}
                                    </>
                                ) : (
                                    <>
                                        <Download className="h-4 w-4" />{" "}
                                        {t("update.install")}
                                    </>
                                )}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
