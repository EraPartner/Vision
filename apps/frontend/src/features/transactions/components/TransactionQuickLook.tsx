import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/shared/Money";
import { TagChip } from "@/components/shared/TagInput";
import { Eye } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { getCategoryColor } from "@/utils/categoryColors";
import type { TableTransaction } from "../types";

interface TransactionQuickLookProps {
    transaction: TableTransaction | null;
    onClose: () => void;
}

/**
 * Quick Look: a read-only glass peek at a transaction, toggled with Space on
 * a focused table row (Finder behavior — Space closes it again). Editing
 * lives in TransactionInfoDialog; this stays glanceable.
 */
export function TransactionQuickLook({ transaction, onClose }: TransactionQuickLookProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    return (
        <Dialog open={!!transaction} onOpenChange={(open) => { if (!open) onClose(); }}>
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
                    <DialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <Eye className="h-4 w-4" />
                        {t('quickLook.title')}
                    </DialogTitle>
                    <DialogDescription className="sr-only">{t('quickLook.title')}</DialogDescription>
                </DialogHeader>
                {transaction && (
                    <div className="space-y-4">
                        <div className="space-y-1.5 text-center">
                            <div className={`font-mono text-4xl font-semibold tracking-tight ${transaction.amount >= 0 ? 'text-accent' : 'text-destructive'} ${!transaction.is_active ? 'opacity-50' : ''}`}>
                                {transaction.amount >= 0 ? '+' : '-'}
                                <Money amount={Math.abs(transaction.amount)} currency={transaction.currency} />
                            </div>
                            <div className="text-base font-medium">{transaction.recipient}</div>
                            <div className="text-sm text-muted-foreground">
                                {transaction.date ? formatDateStringWithAppSettings(transaction.date, appSettings.dateFormat) : '—'}
                                {transaction.bank ? ` · ${transaction.bank}` : ''}
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                            <Badge variant="outline" className={`font-medium ${getCategoryColor(transaction.category)}`}>
                                {transaction.category}
                            </Badge>
                            {!transaction.is_active && (
                                <Badge variant="outline" className="text-muted-foreground">
                                    {t('txPage.statusInactive')}
                                </Badge>
                            )}
                            {transaction.tags?.map((tag) => (
                                <TagChip key={tag.slug} tag={tag} />
                            ))}
                        </div>
                        {(transaction.memo || transaction.comment) && (
                            <div className="space-y-1 rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
                                {transaction.memo && <p className="text-foreground/90 break-words">{transaction.memo}</p>}
                                {transaction.comment && <p className="text-muted-foreground break-words">{transaction.comment}</p>}
                            </div>
                        )}
                        <p className="text-center text-[11px] text-muted-foreground/70">{t('quickLook.hint')}</p>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
