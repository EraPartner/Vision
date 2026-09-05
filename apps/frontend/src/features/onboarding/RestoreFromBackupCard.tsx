import { Database, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiClient } from "@/lib/api";
import { useRestoreBackup } from "@/hooks/useRestoreBackup";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

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
export function RestoreFromBackupCard({
    onDismiss,
    compact = false,
}: RestoreFromBackupCardProps) {
    const { t } = useLanguage();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const { start, running, passphraseDialog } = useRestoreBackup({
        onSuccess: onDismiss,
    });

    if (!apiClient.isElectron()) return null;

    const handleSelectFile = async () => {
        const filePath = await apiClient.selectBackupFile();
        if (!filePath) return;
        const accepted = await confirm({
            title: t("settings.restore.confirmTitle"),
            description: (
                <>
                    {t("settings.restore.confirmDesc")}
                    <span className="block mt-1 font-medium text-foreground truncate">
                        {filePath.split("/").pop()}
                    </span>
                </>
            ),
            confirmLabel: t("settings.restore.confirmButton"),
            cancelLabel: t("settings.restore.cancelButton"),
        });
        if (accepted) await start(filePath);
    };

    return (
        <>
            <div
                className={
                    compact
                        ? "flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30"
                        : "flex items-start gap-4 p-4 rounded-xl border border-border bg-muted/30"
                }
            >
                <div
                    className={cn(
                        compact ? "h-8 w-8" : "h-10 w-10",
                        "rounded-md bg-success/10 flex items-center justify-center shrink-0",
                    )}
                >
                    <Database
                        className={cn(
                            compact ? "h-4 w-4" : "h-5 w-5",
                            "text-success",
                        )}
                    />
                </div>

                <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                    <p
                        className={cn(
                            compact ? "text-sm" : "text-base",
                            "font-medium text-foreground",
                        )}
                    >
                        {t("onboarding.restore.title")}
                    </p>
                    <p
                        className={cn(
                            compact ? "text-xs" : "text-sm",
                            "text-muted-foreground leading-relaxed",
                        )}
                    >
                        {t("onboarding.restore.desc")}
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
                        {running
                            ? t("settings.restore.running")
                            : t("onboarding.restore.button")}
                    </Button>
                </div>
            </div>

            <ConfirmDialog />

            {passphraseDialog}
        </>
    );
}
