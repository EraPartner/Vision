import { useCallback, useState } from 'react';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import {
    AlertDialog,
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
import { toast } from 'sonner';
import { apiClient } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';

const ERR_PASSPHRASE_REQUIRED = 'PASSPHRASE_REQUIRED';
const ERR_INVALID_PASSPHRASE = 'INVALID_PASSPHRASE';

type RestoreOptions = {
    /** Called once a successful restore is confirmed, before the page reloads. */
    onSuccess?: () => void;
};

type StartFn = (filePath: string) => Promise<void>;

/**
 * Drives the encrypted-aware restore flow shared by onboarding and Settings.
 *
 * Flow: caller invokes `start(filePath)` once the user has confirmed the
 * destructive restore. The hook:
 *   1. Asks the Electron main process whether the file is encrypted.
 *   2. If encrypted, opens a passphrase modal and waits for input.
 *   3. Calls `apiClient.restoreBackup(filePath, { passphrase })`.
 *   4. On INVALID_PASSPHRASE, re-opens the modal so the user can retry.
 *   5. Restores the bundled frontend localStorage snapshot, fires a success
 *      toast, and triggers a delayed reload.
 */
export function useRestoreBackup({ onSuccess }: RestoreOptions = {}) {
    const { t } = useLanguage();
    const [running, setRunning] = useState(false);
    const [passphraseOpen, setPassphraseOpen] = useState(false);
    const [pendingFile, setPendingFile] = useState<string | null>(null);
    const [passphraseInput, setPassphraseInput] = useState('');
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const performRestore = useCallback(
        async (filePath: string, passphrase?: string): Promise<'ok' | 'needPassphrase' | 'invalidPassphrase'> => {
            const result = await apiClient.restoreBackup(filePath, passphrase ? { passphrase } : undefined);
            if (!result) return 'ok';

            if (result.success) {
                if (result.frontendState?.keys) {
                    try {
                        for (const [key, value] of Object.entries(result.frontendState.keys)) {
                            window.localStorage.setItem(key, String(value));
                        }
                    } catch {
                        // Non-fatal: continue even if localStorage is restricted.
                    }
                }
                toast.success(t('settings.restore.success'), {
                    description: t('settings.restore.successDesc').replace('{file}', result.file ?? filePath),
                    duration: 8000,
                });
                onSuccess?.();
                setTimeout(() => window.location.reload(), 3000);
                return 'ok';
            }

            const errMsg = result.error ?? '';
            if (errMsg.includes(ERR_INVALID_PASSPHRASE)) return 'invalidPassphrase';
            if (errMsg.includes(ERR_PASSPHRASE_REQUIRED)) return 'needPassphrase';

            if (errMsg.startsWith('BUNDLE_SCHEMA_NEWER:')) {
                toast.error(t('settings.restore.schemaMismatch'), {
                    description: errMsg.replace('BUNDLE_SCHEMA_NEWER: ', ''),
                    duration: 12000,
                });
            } else {
                toast.error(t('settings.restore.failed'), { description: errMsg });
            }
            return 'ok';
        },
        [onSuccess, t],
    );

    const start: StartFn = useCallback(
        async (filePath: string) => {
            if (!filePath) return;
            setRunning(true);
            try {
                const encrypted = await apiClient.isBackupEncrypted(filePath);
                if (encrypted) {
                    setPendingFile(filePath);
                    setPassphraseInput('');
                    setShowPassphrase(false);
                    setPassphraseOpen(true);
                    return;
                }

                const outcome = await performRestore(filePath);
                if (outcome === 'needPassphrase') {
                    // Defensive: file looked unencrypted but main says otherwise.
                    setPendingFile(filePath);
                    setPassphraseInput('');
                    setShowPassphrase(false);
                    setPassphraseOpen(true);
                    return;
                }
                setRunning(false);
            } catch (err: unknown) {
                toast.error(t('settings.restore.failed'), { description: String(err) });
                setRunning(false);
            }
        },
        [performRestore, t],
    );

    const handlePassphraseSubmit = useCallback(async () => {
        if (!pendingFile || !passphraseInput) return;
        setSubmitting(true);
        try {
            const outcome = await performRestore(pendingFile, passphraseInput);
            if (outcome === 'invalidPassphrase') {
                toast.error(t('settings.restore.passphraseInvalid'));
                setPassphraseInput('');
                // Keep dialog open for retry.
                return;
            }
            if (outcome === 'needPassphrase') {
                toast.error(t('settings.restore.passphraseRequired'));
                setPassphraseInput('');
                return;
            }
            // Success or non-passphrase failure — close dialog and reset.
            setPassphraseOpen(false);
            setPendingFile(null);
            setPassphraseInput('');
            if (outcome !== 'ok') setRunning(false);
        } catch (err: unknown) {
            toast.error(t('settings.restore.failed'), { description: String(err) });
            setPassphraseOpen(false);
            setPendingFile(null);
            setRunning(false);
        } finally {
            setSubmitting(false);
        }
    }, [pendingFile, passphraseInput, performRestore, t]);

    const handlePassphraseCancel = useCallback(() => {
        setPassphraseOpen(false);
        setPendingFile(null);
        setPassphraseInput('');
        setRunning(false);
    }, []);

    const passphraseDialog = (
        <AlertDialog
            open={passphraseOpen}
            onOpenChange={(open) => {
                if (!open && !submitting) handlePassphraseCancel();
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        {t('settings.restore.passphraseTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>{t('settings.restore.passphraseDesc')}</AlertDialogDescription>
                </AlertDialogHeader>

                <div className="space-y-2 py-2">
                    <Label htmlFor="restore-passphrase" className="text-sm">
                        {t('settings.restore.passphraseLabel')}
                    </Label>
                    <div className="relative">
                        <Input
                            id="restore-passphrase"
                            type={showPassphrase ? 'text' : 'password'}
                            autoFocus
                            value={passphraseInput}
                            onChange={(e) => setPassphraseInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && passphraseInput && !submitting) {
                                    e.preventDefault();
                                    void handlePassphraseSubmit();
                                }
                            }}
                            disabled={submitting}
                            className="pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowPassphrase((v) => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            tabIndex={-1}
                            aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                        >
                            {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                    {pendingFile && (
                        <p className="text-xs text-muted-foreground font-mono break-all">
                            {pendingFile.split('/').pop()}
                        </p>
                    )}
                </div>

                <AlertDialogFooter>
                    <AlertDialogCancel disabled={submitting} onClick={handlePassphraseCancel}>
                        {t('settings.restore.cancelButton')}
                    </AlertDialogCancel>
                    <Button
                        onClick={() => { void handlePassphraseSubmit(); }}
                        disabled={!passphraseInput || submitting}
                    >
                        {submitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        {t('settings.restore.passphraseSubmit')}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );

    return { start, running, passphraseDialog };
}
