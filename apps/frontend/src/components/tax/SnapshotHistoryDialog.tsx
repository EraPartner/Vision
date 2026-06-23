/**
 * SnapshotHistoryDialog
 *
 * Lists every audit log entry recorded against a snapshot — creation, patches, freezes,
 * filings, and their reversals — newest first. For `'patched'` entries the diff is shown
 * inline so the user can see *what* changed, not just *that* something changed.
 *
 * Read-only. Surfaces the append-only `meta.history` produced by the provider's mutators
 * (ADR-059).
 */
import type { ReactNode } from 'react';
import { History } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import type { SnapshotAuditEntry, SnapshotAuditEntryKind } from '@/lib/belgianTax';
import { cn } from '@/lib/utils';

interface SnapshotHistoryDialogProps {
    trigger?: ReactNode;
    year: number;
}

const KIND_VARIANT: Record<SnapshotAuditEntryKind, string> = {
    created: 'bg-primary/15 text-primary border-primary/30',
    patched: 'bg-warning/10 text-warning border-warning/30',
    frozen: 'bg-sky-500/10 text-sky-700 border-sky-500/30',
    unfrozen: 'bg-muted text-muted-foreground border-border',
    filed: 'bg-success/10 text-success border-success/30',
    unfiled: 'bg-muted text-muted-foreground border-border',
};

function formatTimestamp(iso: string, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

/**
 * Compact one-line summary of a patch. Numbers are formatted, strings are quoted, booleans
 * pass through. Long arrays and objects collapse to `[N items]` / `{N keys}` to keep the
 * timeline scannable.
 */
function summarizePatch(changes: SnapshotAuditEntry['changes']): string {
    if (!changes) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(changes)) {
        if (Array.isArray(v)) {
            parts.push(`${k}: [${v.length} items]`);
        } else if (v !== null && typeof v === 'object') {
            parts.push(`${k}: {${Object.keys(v).length} keys}`);
        } else if (typeof v === 'string') {
            parts.push(`${k}: "${v}"`);
        } else {
            parts.push(`${k}: ${String(v)}`);
        }
    }
    return parts.join(', ');
}

export function SnapshotHistoryDialog({ trigger, year }: SnapshotHistoryDialogProps) {
    const { t, language } = useLanguage();
    const { getSnapshotHistory } = useBelgianTaxProfile();
    const history = getSnapshotHistory(year);
    // Newest first for chronology display.
    const ordered = [...history].reverse();

    return (
        <Dialog>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <History className="h-4 w-4 text-muted-foreground" />
                        {t('tax.history.title', { year: String(year) })}
                    </DialogTitle>
                    <DialogDescription>{t('tax.history.description')}</DialogDescription>
                </DialogHeader>

                {ordered.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        {t('tax.history.empty')}
                    </p>
                ) : (
                    <ScrollArea className="max-h-[60vh] pr-3">
                        <ol className="space-y-3">
                            {ordered.map((entry, idx) => (
                                <li
                                    key={`${entry.at}-${idx}`}
                                    className="flex flex-col gap-1 rounded-md border border-border bg-card/50 px-3 py-2"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge
                                            variant="outline"
                                            className={cn('text-[10px] uppercase tracking-wide', KIND_VARIANT[entry.kind])}
                                        >
                                            {t(`tax.history.kind.${entry.kind}`)}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground tabular-nums">
                                            {formatTimestamp(entry.at, language)}
                                        </span>
                                        {entry.reference && (
                                            <span className="text-xs font-medium text-warning">
                                                ({entry.reference})
                                            </span>
                                        )}
                                    </div>
                                    {entry.changes && Object.keys(entry.changes).length > 0 && (
                                        <p className="text-xs text-muted-foreground break-words">
                                            {summarizePatch(entry.changes)}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </ScrollArea>
                )}
            </DialogContent>
        </Dialog>
    );
}
