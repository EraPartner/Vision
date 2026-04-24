import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, Database, FolderOpen, Loader2, UploadCloud } from 'lucide-react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api';

type EncryptionStatus = {
    secureStorageAvailable: boolean;
    hasStoredPassphrase: boolean;
    hasEnvPassphrase: boolean;
};

interface BackupTabProps {
    open: boolean;
    backupDir: string;
    setBackupDir: (dir: string) => void;
    backupOnQuit: boolean;
    setBackupOnQuit: (v: boolean) => void;
}

export function BackupTab({
    open,
    backupDir,
    setBackupDir,
    backupOnQuit,
    setBackupOnQuit,
}: BackupTabProps) {
    const { t } = useLanguage();

    const [backupLoading, setBackupLoading] = useState(false);
    const [backupRunning, setBackupRunning] = useState(false);
    const [encryptionStatus, setEncryptionStatus] = useState<EncryptionStatus | null>(null);
    const [backupPassphrase, setBackupPassphrase] = useState('');
    const [savingBackupPassphrase, setSavingBackupPassphrase] = useState(false);
    const [reminderDismissed, setReminderDismissed] = useState(false);
    const [restoreFile, setRestoreFile] = useState('');
    const [restoreRunning, setRestoreRunning] = useState(false);
    const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        if (!apiClient.isElectron()) return;

        setBackupLoading(true);
        Promise.all([
            apiClient.loadBackupSettings(),
            apiClient.getBackupEncryptionStatus(),
        ]).then(([bs, enc]) => {
            if (bs) {
                setBackupDir(bs.backupDir || '');
                setBackupOnQuit(bs.backupOnQuit ?? false);
            }
            if (enc?.success) {
                setEncryptionStatus({
                    secureStorageAvailable: enc.secureStorageAvailable,
                    hasStoredPassphrase: enc.hasStoredPassphrase,
                    hasEnvPassphrase: enc.hasEnvPassphrase,
                });
            }
        }).finally(() => setBackupLoading(false));

        try {
            const v = window.localStorage.getItem('vision.backup.passphrase.reminder.dismissed');
            setReminderDismissed(v === '1');
        } catch {
            // ignore
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleBrowseBackupDir = async () => {
        const chosen = await apiClient.selectBackupDir();
        if (chosen) setBackupDir(chosen);
    };

    const handleBackupNow = async () => {
        if (!backupDir) {
            toast.error(t('settings.backup.noDir'));
            return;
        }
        setBackupRunning(true);
        try {
            const result = await apiClient.runBackup(backupDir);
            if (!result) return;
            if (result.success) {
                toast.success(t('settings.backup.success'), {
                    description: t('settings.backup.successDesc').replace('{file}', result.file ?? ''),
                });
                if (result.warning) {
                    toast.info(result.warning);
                }
                if ((result.cleanupRemoved ?? 0) > 0) {
                    toast.info(t('settings.backup.cleanupRemoved').replace('{count}', String(result.cleanupRemoved ?? 0)));
                }
            } else {
                toast.error(t('settings.backup.failed'), { description: result.error });
            }
        } catch (err: unknown) {
            toast.error(t('settings.backup.failed'), { description: String(err) });
        } finally {
            setBackupRunning(false);
        }
    };

    const handleSaveBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
        try {
            const result = await apiClient.setBackupPassphrase(backupPassphrase);
            if (!result) {
                toast.error(t('settings.backup.passphrase.unavailable'));
                return;
            }
            if (!result.success) {
                toast.error(t('settings.backup.passphrase.saveFailed'), { description: result.error });
                return;
            }

            const refreshed = await apiClient.getBackupEncryptionStatus();
            if (refreshed?.success) {
                setEncryptionStatus({
                    secureStorageAvailable: refreshed.secureStorageAvailable,
                    hasStoredPassphrase: refreshed.hasStoredPassphrase,
                    hasEnvPassphrase: refreshed.hasEnvPassphrase,
                });
            }

            const trimmed = backupPassphrase.trim();
            setBackupPassphrase('');
            toast.success(trimmed ? t('settings.backup.passphrase.saved') : t('settings.backup.passphrase.cleared'));
            if (trimmed) {
                toast.info(t('settings.backup.passphrase.reminderTitle'), {
                    description: t('settings.backup.passphrase.reminderDesc'),
                    duration: 10000,
                });
                try {
                    window.localStorage.removeItem('vision.backup.passphrase.reminder.dismissed');
                    setReminderDismissed(false);
                } catch { /* localStorage may throw in restrictive contexts */ }
            }
        } catch (err: unknown) {
            toast.error(t('settings.backup.passphrase.saveFailed'), { description: String(err) });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleClearBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
        try {
            const result = await apiClient.setBackupPassphrase('');
            if (!result?.success) {
                toast.error(t('settings.backup.passphrase.saveFailed'), { description: result?.error });
                return;
            }
            const refreshed = await apiClient.getBackupEncryptionStatus();
            if (refreshed?.success) {
                setEncryptionStatus({
                    secureStorageAvailable: refreshed.secureStorageAvailable,
                    hasStoredPassphrase: refreshed.hasStoredPassphrase,
                    hasEnvPassphrase: refreshed.hasEnvPassphrase,
                });
            }
            setBackupPassphrase('');
            toast.success(t('settings.backup.passphrase.cleared'));
        } catch (err: unknown) {
            toast.error(t('settings.backup.passphrase.saveFailed'), { description: String(err) });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleSelectRestoreFile = async () => {
        const chosen = await apiClient.selectBackupFile();
        if (chosen) setRestoreFile(chosen);
    };

    const handleRestoreConfirmed = async () => {
        setRestoreConfirmOpen(false);
        if (!restoreFile) return;
        setRestoreRunning(true);
        try {
            const result = await apiClient.restoreBackup(restoreFile);
            if (!result) return;
            if (result.success) {
                toast.success(t('settings.restore.success'), {
                    description: t('settings.restore.successDesc').replace('{file}', result.file ?? restoreFile),
                    duration: 8000,
                });
                setTimeout(() => window.location.reload(), 3000);
            } else {
                toast.error(t('settings.restore.failed'), { description: result.error });
            }
        } catch (err: unknown) {
            toast.error(t('settings.restore.failed'), { description: String(err) });
        } finally {
            setRestoreRunning(false);
        }
    };

    return (
        <>
            <ScrollArea className="h-full pr-4">
                <div className="space-y-6 py-4">
                    {!apiClient.isElectron() ? (
                        <div className="flex items-start gap-3 rounded-lg border border-muted px-4 py-3 text-sm text-muted-foreground">
                            <Database className="h-4 w-4 mt-0.5 shrink-0" />
                            <p>{t('settings.backup.electronOnly')}</p>
                        </div>
                    ) : (
                        <>
                            {/* Description */}
                            <div className="space-y-1">
                                <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.title')}</h3>
                                <p className="text-xs text-muted-foreground">
                                    {t('settings.backup.description')}
                                </p>
                            </div>

                            <Separator />

                            {/* Directory picker */}
                            <div className="space-y-2">
                                <Label className="text-sm font-semibold">{t('settings.backup.directory')}</Label>
                                <div className="flex gap-2">
                                    <Input
                                        readOnly
                                        value={backupDir}
                                        placeholder={t('settings.backup.notConfigured')}
                                        className="flex-1 font-mono text-xs"
                                    />
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => { void handleBrowseBackupDir(); }}
                                        disabled={backupLoading}
                                        className="shrink-0"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                                        {backupDir ? t('settings.backup.change') : t('settings.backup.browse')}
                                    </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t('settings.backup.directoryHint')}
                                </p>
                            </div>

                            <Separator />

                            {/* Backup on quit toggle */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between rounded-lg border p-4">
                                    <div className="flex-1">
                                        <Label
                                            htmlFor="backup-on-quit"
                                            className="text-sm font-medium cursor-pointer"
                                        >
                                            {t('settings.backup.backupOnQuit')}
                                        </Label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {t('settings.backup.backupOnQuitHint')}
                                        </p>
                                    </div>
                                    <Switch
                                        id="backup-on-quit"
                                        checked={backupOnQuit}
                                        onCheckedChange={setBackupOnQuit}
                                        disabled={!backupDir}
                                        className="ml-4 shrink-0"
                                    />
                                </div>
                            </div>

                            <Separator />

                            {/* Optional encryption passphrase */}
                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.passphrase.title')}</h3>
                                <p className="text-xs text-muted-foreground">
                                    {t('settings.backup.passphrase.description')}
                                </p>
                                <div className="rounded-lg border p-4 space-y-3">
                                    <div className="grid gap-2">
                                        <Label className="text-xs font-medium">{t('settings.backup.passphrase.label')}</Label>
                                        <Input
                                            type="password"
                                            value={backupPassphrase}
                                            onChange={(e) => setBackupPassphrase(e.target.value)}
                                            placeholder={t('settings.backup.passphrase.placeholder')}
                                            disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            {!encryptionStatus
                                                ? t('settings.backup.passphrase.statusUnknown')
                                                : encryptionStatus.hasEnvPassphrase
                                                    ? t('settings.backup.passphrase.statusEnv')
                                                    : encryptionStatus.hasStoredPassphrase
                                                        ? t('settings.backup.passphrase.statusStored')
                                                        : t('settings.backup.passphrase.statusMissing')}
                                        </p>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => { void handleSaveBackupPassphrase(); }}
                                            disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                        >
                                            {savingBackupPassphrase
                                                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                                            }
                                            {t('settings.backup.passphrase.save')}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => { void handleClearBackupPassphrase(); }}
                                            disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                        >
                                            {t('settings.backup.passphrase.clear')}
                                        </Button>
                                    </div>
                                    {!encryptionStatus?.secureStorageAvailable && (
                                        <p className="text-xs text-destructive">{t('settings.backup.passphrase.unavailable')}</p>
                                    )}

                                    {/* Inline reminder banner (dismissible) */}
                                    {(encryptionStatus && (encryptionStatus.hasEnvPassphrase || encryptionStatus.hasStoredPassphrase) && !reminderDismissed) && (
                                        <div className="mt-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800">
                                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                                            <div className="flex-1">
                                                <div className="font-medium text-foreground">{t('settings.backup.passphrase.reminderTitle')}</div>
                                                <div className="text-xs text-muted-foreground mt-1">{t('settings.backup.passphrase.reminderDesc')}</div>
                                            </div>
                                            <div className="flex-shrink-0 ml-2">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => {
                                                        try {
                                                            window.localStorage.setItem('vision.backup.passphrase.reminder.dismissed', '1');
                                                        } catch { /* localStorage may throw in restrictive contexts */ }
                                                        setReminderDismissed(true);
                                                    }}
                                                >
                                                    {t('settings.backup.passphrase.bannerDismiss')}
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <Separator />

                            {/* Run backup now */}
                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.runNow')}</h3>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => { void handleBackupNow(); }}
                                    disabled={backupRunning || !backupDir}
                                >
                                    {backupRunning
                                        ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                        : <Database className="h-3.5 w-3.5 mr-1.5" />
                                    }
                                    {backupRunning ? t('settings.backup.running') : t('settings.backup.runNow')}
                                </Button>
                            </div>

                            <Separator />

                            {/* Format note */}
                            <div className="flex items-start gap-3 rounded-lg border border-muted bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <p>{t('settings.backup.formatNote')}</p>
                            </div>

                            <Separator />

                            {/* Restore Section */}
                            <div className="space-y-1">
                                <h3 className="text-sm font-semibold text-foreground">{t('settings.restore.title')}</h3>
                                <p className="text-xs text-muted-foreground">
                                    {t('settings.restore.description')}
                                </p>
                            </div>

                            {/* Warning banner */}
                            <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <p>{t('settings.restore.warning')}</p>
                            </div>

                            {/* File picker */}
                            <div className="space-y-2">
                                <div className="flex gap-2">
                                    <Input
                                        readOnly
                                        value={restoreFile ? restoreFile.split('/').pop() ?? restoreFile : ''}
                                        placeholder={t('settings.restore.noFile')}
                                        className="flex-1 font-mono text-xs"
                                        title={restoreFile}
                                    />
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => { void handleSelectRestoreFile(); }}
                                        disabled={restoreRunning}
                                        className="shrink-0"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                                        {t('settings.restore.selectFile')}
                                    </Button>
                                </div>
                            </div>

                            {/* Restore now button */}
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setRestoreConfirmOpen(true)}
                                disabled={restoreRunning || !restoreFile}
                            >
                                {restoreRunning
                                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                    : <UploadCloud className="h-3.5 w-3.5 mr-1.5" />
                                }
                                {restoreRunning ? t('settings.restore.running') : t('settings.restore.runNow')}
                            </Button>
                        </>
                    )}
                </div>
            </ScrollArea>

            {/* Restore confirmation dialog — uses portal, safe inside component tree */}
            <AlertDialog open={restoreConfirmOpen} onOpenChange={setRestoreConfirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('settings.restore.confirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('settings.restore.confirmDesc')}
                            {restoreFile && (
                                <span className="block mt-2 font-mono text-xs break-all">
                                    {restoreFile.split('/').pop()}
                                </span>
                            )}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t('settings.restore.cancelButton')}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => { void handleRestoreConfirmed(); }}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {t('settings.restore.confirmButton')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
