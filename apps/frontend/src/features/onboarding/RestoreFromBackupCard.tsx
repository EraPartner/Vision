import { Database, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
 * Shows only in the Electron shell (returns null in a web build). Handles the
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
                    <span className="mt-1 block truncate font-medium text-foreground">
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
            <Card className="text-left">
                <CardContent
                    variant={compact ? "compact" : "headerless"}
                    className="flex items-start gap-3"
                >
                    <div
                        aria-hidden="true"
                        className={cn(
                            compact ? "h-8 w-8" : "h-10 w-10",
                            "flex shrink-0 items-center justify-center rounded-control bg-success/12 text-success",
                        )}
                    >
                        <Database className={compact ? "h-4 w-4" : "h-5 w-5"} />
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p
                            className={cn(
                                compact ? "type-headline" : "type-title-3",
                                "text-foreground",
                            )}
                        >
                            {t("onboarding.restore.title")}
                        </p>
                        <p
                            className={cn(
                                compact ? "type-footnote" : "type-callout",
                                "text-label-secondary",
                            )}
                        >
                            {t("onboarding.restore.desc")}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-1 self-start"
                            disabled={running}
                            onClick={handleSelectFile}
                        >
                            {running ? (
                                <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : (
                                <Upload aria-hidden="true" />
                            )}
                            {running
                                ? t("settings.restore.running")
                                : t("onboarding.restore.button")}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <ConfirmDialog />

            {passphraseDialog}
        </>
    );
}
