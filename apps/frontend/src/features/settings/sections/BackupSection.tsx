import { useState, useEffect, memo } from "react";
import { AlertCircle, FolderOpen, Loader2 } from "lucide-react";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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
                    <span className="mt-2 block break-all font-mono type-footnote">
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
            <SettingsSection title={t("settings.tab.backup")}>
                <Card>
                    <CardContent
                        variant="state"
                        className="space-y-1 text-center"
                    >
                        <p className="type-body text-foreground">
                            {t("settings.backup.electronOnly")}
                        </p>
                        <p className="type-footnote text-label-secondary">
                            {t("settings.backup.description")}
                        </p>
                    </CardContent>
                </Card>
            </SettingsSection>
        );
    }

    const passphraseControlsDisabled =
        backupLoading ||
        savingBackupPassphrase ||
        !encryptionStatus?.secureStorageAvailable;

    const encryptionStatusText = !encryptionStatus
        ? t("settings.backup.passphrase.statusUnknown")
        : encryptionStatus.hasEnvPassphrase
          ? t("settings.backup.passphrase.statusEnv")
          : encryptionStatus.hasStoredPassphrase
            ? t("settings.backup.passphrase.statusStored")
            : t("settings.backup.passphrase.statusMissing");

    return (
        <>
            <SettingsSection title={t("settings.tab.backup")}>
                <SettingsGroup
                    label={t("settings.backup.title")}
                    description={t("settings.backup.description")}
                >
                    <SettingRow
                        title={t("settings.backup.directory")}
                        description={t("settings.backup.directoryHint")}
                        layout="stack"
                    >
                        <div className="flex gap-2">
                            <Input
                                readOnly
                                value={backupDir}
                                title={backupDir}
                                dir="rtl"
                                placeholder={t("settings.backup.notConfigured")}
                                className="min-w-0 flex-1 text-left font-mono"
                            />
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void handleBrowseBackupDir();
                                }}
                                disabled={backupLoading}
                                className="shrink-0"
                            >
                                <FolderOpen className="mr-1.5 h-4 w-4" />
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
                            onClick={() => {
                                void handleBackupNow();
                            }}
                            disabled={backupRunning || !backupDir}
                        >
                            {backupRunning && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            )}
                            {backupRunning
                                ? t("settings.backup.running")
                                : t("settings.backup.runNow")}
                        </Button>
                    </SettingRow>
                </SettingsGroup>

                {/* Encryption passphrase */}
                <SettingsGroup
                    label={t("settings.backup.passphrase.title")}
                    description={t("settings.backup.passphrase.description")}
                >
                    <SettingRow
                        title={t("settings.backup.passphrase.label")}
                        description={encryptionStatusText}
                        htmlFor="backup-passphrase"
                        layout="stack"
                    >
                        <div className="flex flex-wrap gap-2">
                            <Input
                                id="backup-passphrase"
                                type="password"
                                value={backupPassphrase}
                                onChange={(e) =>
                                    setBackupPassphrase(e.target.value)
                                }
                                placeholder={t(
                                    "settings.backup.passphrase.placeholder",
                                )}
                                disabled={passphraseControlsDisabled}
                                className="min-w-[12rem] flex-1"
                            />
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void handleSaveBackupPassphrase();
                                }}
                                disabled={passphraseControlsDisabled}
                            >
                                {savingBackupPassphrase && (
                                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                )}
                                {t("settings.backup.passphrase.save")}
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    void handleClearBackupPassphrase();
                                }}
                                disabled={passphraseControlsDisabled}
                            >
                                {t("settings.backup.passphrase.clear")}
                            </Button>
                        </div>
                        {!encryptionStatus?.secureStorageAvailable && (
                            <p className="mt-2 type-footnote text-destructive">
                                {t("settings.backup.passphrase.unavailable")}
                            </p>
                        )}
                    </SettingRow>
                    {encryptionStatus &&
                        (encryptionStatus.hasEnvPassphrase ||
                            encryptionStatus.hasStoredPassphrase) &&
                        !reminderDismissed && (
                            <SettingRow
                                title={
                                    <span className="flex items-center gap-2">
                                        <AlertCircle
                                            aria-hidden="true"
                                            className="h-4 w-4 shrink-0 text-warning"
                                        />
                                        {t(
                                            "settings.backup.passphrase.reminderTitle",
                                        )}
                                    </span>
                                }
                                description={t(
                                    "settings.backup.passphrase.reminderDesc",
                                )}
                            >
                                <Button
                                    variant="ghost"
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
                            </SettingRow>
                        )}
                </SettingsGroup>

                {/* Restore */}
                <SettingsGroup
                    label={t("settings.restore.title")}
                    description={t("settings.restore.description")}
                >
                    <SettingRow
                        title={t("settings.restore.selectFile")}
                        titleHidden
                        layout="stack"
                    >
                        <div className="flex gap-2">
                            <Input
                                readOnly
                                value={
                                    restoreFile
                                        ? (restoreFile.split("/").pop() ??
                                          restoreFile)
                                        : ""
                                }
                                placeholder={t("settings.restore.noFile")}
                                className="min-w-0 flex-1 text-left font-mono"
                                title={restoreFile}
                            />
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void handleSelectRestoreFile();
                                }}
                                disabled={restoreRunning}
                                className="shrink-0"
                            >
                                <FolderOpen className="mr-1.5 h-4 w-4" />
                                {t("settings.restore.selectFile")}
                            </Button>
                        </div>
                    </SettingRow>
                    <SettingRow
                        title={t("settings.restore.runNow")}
                        description={t("settings.restore.warning")}
                        destructive
                    >
                        <Button
                            variant="destructive"
                            onClick={() => {
                                void handleRestore();
                            }}
                            disabled={restoreRunning || !restoreFile}
                        >
                            {restoreRunning && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
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
