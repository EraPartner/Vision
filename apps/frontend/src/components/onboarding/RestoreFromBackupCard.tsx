import { useState } from 'react';
import { Database, Loader2, Upload } from 'lucide-react';
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
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api';
import { useRestoreBackup } from '@/hooks/useRestoreBackup';

interface RestoreFromBackupCardProps {
    /** Called after successful restore (before page reload), or if the user dismisses. */
    onDismiss?: () => void;
    /** Override appearance for compact contexts (e.g., inside a wizard step). */
    compact?: boolean;
}

/**
 * Self-contained restore-from-backup card.
 *
 * Shows only in the Electron shell (returns null in web/Docker). Handles the
 * full restore lifecycle: file selection → confirmation → DB restore →
 * localStorage frontend-state write → page reload. Schema-version errors are
 * surfaced with a dedicated user-friendly message. When the selected backup is
 * encrypted, prompts the user for the passphrase via {@link useRestoreBackup}.
 */
export function RestoreFromBackupCard({ onDismiss, compact = false }: RestoreFromBackupCardProps) {
    const { t } = useLanguage();

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const { start, running, passphraseDialog } = useRestoreBackup({ onSuccess: onDismiss });

    if (!apiClient.isElectron()) return null;

    const handleSelectFile = async () => {
        const filePath = await apiClient.selectBackupFile();
        if (!filePath) return;
        setSelectedFile(filePath);
        setConfirmOpen(true);
    };

    const handleConfirmed = async () => {
        if (!selectedFile) return;
        setConfirmOpen(false);
        await start(selectedFile);
    };

    const handleCancel = () => {
        setConfirmOpen(false);
        setSelectedFile(null);
    };

    return (
        <>
            <div
                className={
                    compact
                        ? 'flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30'
                        : 'flex items-start gap-4 p-4 rounded-xl border border-border bg-muted/30'
                }
            >
                <div
                    className={`${compact ? 'h-8 w-8' : 'h-10 w-10'} rounded-md bg-emerald-500/10 flex items-center justify-center shrink-0`}
                >
                    <Database
                        className={`${compact ? 'h-4 w-4' : 'h-5 w-5'} text-emerald-600 dark:text-emerald-400`}
                    />
                </div>

                <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                    <p className={`${compact ? 'text-sm' : 'text-base'} font-medium text-foreground`}>
                        {t('onboarding.restore.title')}
                    </p>
                    <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground leading-relaxed`}>
                        {t('onboarding.restore.desc')}
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        className="mt-1 gap-1.5 self-start"
                        disabled={running}
                        onClick={handleSelectFile}
                    >
                        {running ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Upload className="h-3.5 w-3.5" />
                        )}
                        {running ? t('settings.restore.running') : t('onboarding.restore.button')}
                    </Button>
                </div>
            </div>

            <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!open) handleCancel(); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('settings.restore.confirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('settings.restore.confirmDesc')}
                            {selectedFile && (
                                <span className="block mt-1 font-medium text-foreground truncate">
                                    {selectedFile.split('/').pop()}
                                </span>
                            )}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={handleCancel}>
                            {t('settings.restore.cancelButton')}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={handleConfirmed}>
                            {t('settings.restore.confirmButton')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {passphraseDialog}
        </>
    );
}
