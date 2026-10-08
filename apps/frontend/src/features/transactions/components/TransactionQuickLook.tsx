import { cn } from "@/lib/utils";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/shared/Money";
import { TagChip } from "@/components/shared/TagInput";
import { Eye } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { getCategoryColor } from "@/utils/categoryColors";
import type { TableTransaction } from "../types";

interface TransactionQuickLookProps {
    transaction: TableTransaction | null;
    onClose: () => void;
}

/**
 * Quick Look: a read-only glass peek at a transaction, toggled with Space on
 * a focused table row (Finder behavior — Space closes it again). Editing
 * lives in TransactionInspector; this stays glanceable.
 */
export function TransactionQuickLook({
    transaction,
    onClose,
}: TransactionQuickLookProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    return (
        <Dialog
            open={!!transaction}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <DialogContent
                className="max-w-sm"
                onKeyDown={(e) => {
                    if (e.key === " ") {
                        e.preventDefault();
                        onClose();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Eye className="h-4 w-4" />
                        {t("quickLook.title")}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("quickLook.title")}
                    </DialogDescription>
                </DialogHeader>
                {transaction && (
                    <div className="space-y-4">
                        <div className="space-y-1.5 text-center">
                            <div
                                className={cn(
                                    "type-large-title tabular-nums",
                                    transaction.amount >= 0
                                        ? "text-gain"
                                        : "text-foreground",
                                    !transaction.is_active && "opacity-50",
                                )}
                            >
                                <Money
                                    signed
                                    amount={transaction.amount}
                                    currency={transaction.currency}
                                />
                            </div>
                            <div className="type-headline text-foreground">
                                {transaction.recipient}
                            </div>
                            <div className="type-callout text-label-secondary">
                                {transaction.date
                                    ? formatDateStringWithAppSettings(
                                          transaction.date,
                                          appSettings.dateFormat,
                                      )
                                    : "—"}
                                {transaction.bank
                                    ? ` · ${transaction.bank}`
                                    : ""}
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                            <Badge
                                variant="outline"
                                className={cn(
                                    "font-medium",
                                    getCategoryColor(transaction.category),
                                )}
                            >
                                {transaction.category}
                            </Badge>
                            {!transaction.is_active && (
                                <Badge variant="muted">
                                    {t("txPage.statusInactive")}
                                </Badge>
                            )}
                            {transaction.tags?.map((tag) => (
                                <TagChip key={tag.slug} tag={tag} />
                            ))}
                        </div>
                        {(transaction.memo || transaction.comment) && (
                            <div className="space-y-1 rounded-card corner-continuous bg-foreground/[0.04] px-3 py-2.5 type-body">
                                {transaction.memo && (
                                    <p className="break-words text-foreground">
                                        {transaction.memo}
                                    </p>
                                )}
                                {transaction.comment && (
                                    <p className="break-words text-label-secondary">
                                        {transaction.comment}
                                    </p>
                                )}
                            </div>
                        )}
                        <p className="text-center type-caption text-label-tertiary">
                            {t("quickLook.hint")}
                        </p>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
