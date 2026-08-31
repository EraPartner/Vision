import { useState, useEffect, memo } from "react";
import {
    AlertCircle,
    CheckCircle2,
    Database,
    FolderOpen,
    Loader2,
    UploadCloud,
} from "lucide-react";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { useRestoreBackup } from "@/hooks/useRestoreBackup";
import {
    SettingsSection,
    SettingsGroup,
    SettingRow,
} from "../SettingsPrimitives";
import { electronErrorToMessage } from "@/lib/api/electronErrorMessage";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

type EncryptionStatus = {
    secureStorageAvailable: boolean;
    hasStoredPassphrase: boolean;
    hasEnvPassphrase: boolean;
};

const REMINDER_KEY = "vision.backup.passphrase.reminder.dismissed";

export const BackupSection = memo(function BackupSection() {
    const { t } = useLanguage();

    const [backupDir, setBackupDir] = useState("");
    const [backupOnQuit, setBackupOnQuit] = useState(false);
    // Guard: only persist once the stored config has loaded, so a stray toggle
    // before load can't clobber it with empty defaults.
    const [loaded, setLoaded] = useState(false);
    const [settingsLoading, setSettingsLoading] = useState(false);
    const [encryptionLoading, setEncryptionLoading] = useState(false);
    const backupLoading = settingsLoading || encryptionLoading;
    const [backupRunning, setBackupRunning] = useState(false);
    const [encryptionStatus, setEncryptionStatus] =
        useState<EncryptionStatus | null>(null);
    const [backupPassphrase, setBackupPassphrase] = useState("");
    const [savingBackupPassphrase, setSavingBackupPassphrase] = useState(false);
    const [reminderDismissed, setReminderDismissed] = useState(false);
    const [restoreFile, setRestoreFile] = useState("");
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const {
        start: startRestore,
        running: restoreRunning,
        passphraseDialog: restorePassphraseDialog,
    } = useRestoreBackup();

    useEffect(() => {
        if (!apiClient.isElectron()) return;
        let cancelled = false;

        setSettingsLoading(true);
        apiClient
            .loadBackupSettings()
            .then((bs) => {
                if (cancelled || !bs) return;
                setBackupDir(bs.backupDir || "");
                setBackupOnQuit(bs.backupOnQuit ?? false);
                setLoaded(true);
            })
            .catch(() => {
                /* leave unloaded — saves stay disabled */
            })
            .finally(() => {
                if (!cancelled) setSettingsLoading(false);
            });

        setEncryptionLoading(true);
        apiClient
            .getBackupEncryptionStatus()
            .then((enc) => {
                if (cancelled) return;
                if (enc?.success) {
                    setEncryptionStatus({
                        secureStorageAvailable: enc.secureStorageAvailable,
                        hasStoredPassphrase: enc.hasStoredPassphrase,
                        hasEnvPassphrase: enc.hasEnvPassphrase,
                    });
                }
            })
            .finally(() => {
                if (!cancelled) setEncryptionLoading(false);
            });

        try {
            setReminderDismissed(
                window.localStorage.getItem(REMINDER_KEY) === "1",
            );
        } catch {
            /* ignore */
        }

        return () => {
            cancelled = true;
        };
    }, []);

    const persist = (dir: string, onQuit: boolean) => {
        apiClient.saveBackupSettings({ backupDir: dir, backupOnQuit: onQuit });
    };

    const handleBrowseBackupDir = async () => {
        const chosen = await apiClient.selectBackupDir();
        if (!chosen) return;
        setBackupDir(chosen);
        setLoaded(true);
        persist(chosen, backupOnQuit);
    };

    const handleBackupOnQuitChange = (v: boolean) => {
        setBackupOnQuit(v);
        if (loaded || backupDir) persist(backupDir, v);
    };

    const handleBackupNow = async () => {
        if (!backupDir) {
            toast.error(t("settings.backup.noDir"));
            return;
        }
        setBackupRunning(true);
        try {
            let frontendStateJson: string | null = null;
            try {
                const keys: Record<string, string> = {};
                for (const key of Object.values(LOCAL_STORAGE_KEYS)) {
                    const val = window.localStorage.getItem(key);
                    if (val !== null) keys[key] = val;
                }
                frontendStateJson = JSON.stringify({ keys });
            } catch {
                /* non-fatal */
            }

            const result = await apiClient.runBackup(
                backupDir,
                frontendStateJson,
            );
            if (!result) return;
            if (result.success) {
                toast.success(t("settings.backup.success"), {
                    description: t("settings.backup.successDesc").replace(
                        "{file}",
                        result.file ?? "",
                    ),
                });
                if (result.warning) toast.info(result.warning);
                if ((result.cleanupRemoved ?? 0) > 0) {
                    toast.info(
                        t("settings.backup.cleanupRemoved").replace(
                            "{count}",
                            String(result.cleanupRemoved ?? 0),
                        ),
                    );
                }
            } else {
                toast.error(t("settings.backup.failed"), {
                    description: electronErrorToMessage(result.error, t),
                });
            }
        } catch (err: unknown) {
            toast.error(t("settings.backup.failed"), {
                description: electronErrorToMessage(err, t),
            });
        } finally {
            setBackupRunning(false);
        }
    };

    const refreshEncryptionStatus = async () => {
        const refreshed = await apiClient.getBackupEncryptionStatus();
        if (refreshed?.success) {
            setEncryptionStatus({
                secureStorageAvailable: refreshed.secureStorageAvailable,
                hasStoredPassphrase: refreshed.hasStoredPassphrase,
                hasEnvPassphrase: refreshed.hasEnvPassphrase,
            });
        }
    };

    const handleSaveBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
        try {
            const result =
                await apiClient.setBackupPassphrase(backupPassphrase);
            if (!result) {
                toast.error(t("settings.backup.passphrase.unavailable"));
                return;
            }
            if (!result.success) {
                toast.error(t("settings.backup.passphrase.saveFailed"), {
                    description: electronErrorToMessage(result.error, t),
                });
                return;
            }
            await refreshEncryptionStatus();
            const trimmed = backupPassphrase.trim();
            setBackupPassphrase("");
            toast.success(
                trimmed
                    ? t("settings.backup.passphrase.saved")
                    : t("settings.backup.passphrase.cleared"),
            );
            if (trimmed) {
                toast.info(t("settings.backup.passphrase.reminderTitle"), {
                    description: t("settings.backup.passphrase.reminderDesc"),
                    duration: 10000,
                });
                try {
                    window.localStorage.removeItem(REMINDER_KEY);
                    setReminderDismissed(false);
                } catch {
                    /* ignore */
                }
            }
        } catch (err: unknown) {
            toast.error(t("settings.backup.passphrase.saveFailed"), {
                description: electronErrorToMessage(err, t),
            });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleClearBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
        try {
            const result = await apiClient.setBackupPassphrase("");
            if (!result?.success) {
                toast.error(t("settings.backup.passphrase.saveFailed"), {
                    description: electronErrorToMessage(result?.error, t),
                });
                return;
            }
            await refreshEncryptionStatus();
            setBackupPassphrase("");
            toast.success(t("settings.backup.passphrase.cleared"));
        } catch (err: unknown) {
            toast.error(t("settings.backup.passphrase.saveFailed"), {
                description: electronErrorToMessage(err, t),
            });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleSelectRestoreFile = async () => {
        const chosen = await apiClient.selectBackupFile();
        if (chosen) setRestoreFile(chosen);
    };

    const handleRestore = async () => {
        if (!restoreFile) return;
        const accepted = await confirm({
            title: t("settings.restore.confirmTitle"),
            description: (
                <>
                    {t("settings.restore.confirmDesc")}
                    <span className="mt-2 block break-all font-mono text-xs">
                        {restoreFile.split("/").pop()}
                    </span>
                </>
            ),
            confirmLabel: t("settings.restore.confirmButton"),
            cancelLabel: t("settings.restore.cancelButton"),
            variant: "destructive",
        });
        if (!accepted) return;
        await startRestore(restoreFile);
    };

    if (!apiClient.isElectron()) {
        return (
            <SettingsSection
                title={t("settings.tab.backup")}
                description={t("settings.backup.description")}
            >
                <div className="flex items-start gap-3 rounded-lg border border-muted px-4 py-3 text-sm text-muted-foreground">
                    <Database className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>{t("settings.backup.electronOnly")}</p>
                </div>
            </SettingsSection>
        );
    }

    return (
        <>
            <SettingsSection
                title={t("settings.tab.backup")}
                description={t("settings.backup.description")}
            >
                <SettingsGroup label={t("settings.backup.title")}>
                    <SettingRow
                        title={t("settings.backup.directory")}
                        description={t("settings.backup.directoryHint")}
                        layout="stack"
                    >
                        <div className="flex gap-2">
                            <Input
                                readOnly
                                value={backupDir}
                                placeholder={t("settings.backup.notConfigured")}
                                className="flex-1 font-mono text-xs"
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    void handleBrowseBackupDir();
                                }}
                                disabled={backupLoading}
                                className="shrink-0"
                            >
                                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                                {backupDir
                                    ? t("settings.backup.change")
                                    : t("settings.backup.browse")}
                            </Button>
                        </div>
                    </SettingRow>

                    <SettingRow
                        title={t("settings.backup.backupOnQuit")}
                        description={t("settings.backup.backupOnQuitHint")}
                        htmlFor="backup-on-quit"
                    >
                        <Switch
                            id="backup-on-quit"
                            checked={backupOnQuit}
                            onCheckedChange={handleBackupOnQuitChange}
                            disabled={!backupDir}
                        />
                    </SettingRow>

                    <SettingRow
                        title={t("settings.backup.runNow")}
                        description={t("settings.backup.formatNote")}
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                void handleBackupNow();
                            }}
                            disabled={backupRunning || !backupDir}
                        >
                            {backupRunning ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Database className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {backupRunning
                                ? t("settings.backup.running")
                                : t("settings.backup.runNow")}
                        </Button>
                    </SettingRow>
                </SettingsGroup>

                {/* Encryption passphrase */}
                <SettingsGroup label={t("settings.backup.passphrase.title")}>
                    <SettingRow
                        title={t("settings.backup.passphrase.label")}
                        description={t(
                            "settings.backup.passphrase.description",
                        )}
                        layout="stack"
                    >
                        <Input
                            type="password"
                            value={backupPassphrase}
                            onChange={(e) =>
                                setBackupPassphrase(e.target.value)
                            }
                            placeholder={t(
                                "settings.backup.passphrase.placeholder",
                            )}
                            disabled={
                                backupLoading ||
                                savingBackupPassphrase ||
                                !encryptionStatus?.secureStorageAvailable
                            }
                        />
                        <p className="mt-2 text-xs text-muted-foreground">
                            {!encryptionStatus
                                ? t("settings.backup.passphrase.statusUnknown")
                                : encryptionStatus.hasEnvPassphrase
                                  ? t("settings.backup.passphrase.statusEnv")
                                  : encryptionStatus.hasStoredPassphrase
                                    ? t(
                                          "settings.backup.passphrase.statusStored",
                                      )
                                    : t(
                                          "settings.backup.passphrase.statusMissing",
                                      )}
                        </p>
                        <div className="mt-3 flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    void handleSaveBackupPassphrase();
                                }}
                                disabled={
                                    backupLoading ||
                                    savingBackupPassphrase ||
                                    !encryptionStatus?.secureStorageAvailable
                                }
                            >
                                {savingBackupPassphrase ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                {t("settings.backup.passphrase.save")}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    void handleClearBackupPassphrase();
                                }}
                                disabled={
                                    backupLoading ||
                                    savingBackupPassphrase ||
                                    !encryptionStatus?.secureStorageAvailable
                                }
                            >
                                {t("settings.backup.passphrase.clear")}
                            </Button>
                        </div>
                        {!encryptionStatus?.secureStorageAvailable && (
                            <p className="mt-2 text-xs text-destructive">
                                {t("settings.backup.passphrase.unavailable")}
                            </p>
                        )}
                        {encryptionStatus &&
                            (encryptionStatus.hasEnvPassphrase ||
                                encryptionStatus.hasStoredPassphrase) &&
                            !reminderDismissed && (
                                <div className="mt-3 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                                    <div className="flex-1">
                                        <div className="font-medium text-foreground">
                                            {t(
                                                "settings.backup.passphrase.reminderTitle",
                                            )}
                                        </div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {t(
                                                "settings.backup.passphrase.reminderDesc",
                                            )}
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="ml-2 shrink-0"
                                        onClick={() => {
                                            try {
                                                window.localStorage.setItem(
                                                    REMINDER_KEY,
                                                    "1",
                                                );
                                            } catch {
                                                /* ignore */
                                            }
                                            setReminderDismissed(true);
                                        }}
                                    >
                                        {t(
                                            "settings.backup.passphrase.bannerDismiss",
                                        )}
                                    </Button>
                                </div>
                            )}
                    </SettingRow>
                </SettingsGroup>

                {/* Restore */}
                <SettingsGroup label={t("settings.restore.title")}>
                    <SettingRow
                        title={t("settings.restore.description")}
                        layout="stack"
                    >
                        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <p>{t("settings.restore.warning")}</p>
                        </div>
                        <div className="mt-3 flex gap-2">
                            <Input
                                readOnly
                                value={
                                    restoreFile
                                        ? (restoreFile.split("/").pop() ??
                                          restoreFile)
                                        : ""
                                }
                                placeholder={t("settings.restore.noFile")}
                                className="flex-1 font-mono text-xs"
                                title={restoreFile}
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    void handleSelectRestoreFile();
                                }}
                                disabled={restoreRunning}
                                className="shrink-0"
                            >
                                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                                {t("settings.restore.selectFile")}
                            </Button>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                                void handleRestore();
                            }}
                            disabled={restoreRunning || !restoreFile}
                        >
                            {restoreRunning ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {restoreRunning
                                ? t("settings.restore.running")
                                : t("settings.restore.runNow")}
                        </Button>
                    </SettingRow>
                </SettingsGroup>
            </SettingsSection>

            <ConfirmDialog />

            {restorePassphraseDialog}
        </>
    );
});
