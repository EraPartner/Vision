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
import type { ReactNode } from "react";
import { History } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { List } from "@/components/ui/list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/shared/EmptyState";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import type {
    SnapshotAuditEntry,
    SnapshotAuditEntryKind,
} from "@/lib/belgianTax";

interface SnapshotHistoryDialogProps {
    trigger?: ReactNode;
    year: number;
}

const EMPTY_HISTORY: SnapshotAuditEntry[] = [];

const KIND_BADGE: Record<
    SnapshotAuditEntryKind,
    { variant: BadgeProps["variant"]; className?: string }
> = {
    created: { variant: "default" },
    patched: { variant: "warning" },
    frozen: { variant: "outline", className: "text-info" },
    unfrozen: { variant: "muted" },
    filed: { variant: "success" },
    unfiled: { variant: "muted" },
};

function formatTimestamp(iso: string, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
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
function summarizePatch(changes: SnapshotAuditEntry["changes"]): string {
    if (!changes) return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(changes)) {
        if (Array.isArray(v)) {
            parts.push(`${k}: [${v.length} items]`);
        } else if (v !== null && typeof v === "object") {
            parts.push(`${k}: {${Object.keys(v).length} keys}`);
        } else if (typeof v === "string") {
            parts.push(`${k}: "${v}"`);
        } else {
            parts.push(`${k}: ${String(v)}`);
        }
    }
    return parts.join(", ");
}

export function SnapshotHistoryDialog({
    trigger,
    year,
}: SnapshotHistoryDialogProps) {
    const { t, language } = useLanguage();
    const history = useBelgianTaxProfile(
        (state) => state.snapshotMetas[year]?.history ?? EMPTY_HISTORY,
    );
    // Newest first for chronology display.
    const ordered = [...history].reverse();

    return (
        <Dialog>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {t("tax.history.title", { year: String(year) })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("tax.history.description")}
                    </DialogDescription>
                </DialogHeader>

                {ordered.length === 0 ? (
                    <EmptyState
                        size="compact"
                        headingLevel={3}
                        icon={History}
                        title={t("tax.history.empty")}
                    />
                ) : (
                    <ScrollArea className="max-h-[60vh] pr-3">
                        <List>
                            {ordered.map((entry, idx) => {
                                const badge = KIND_BADGE[entry.kind];
                                const summary = entry.changes
                                    ? summarizePatch(entry.changes)
                                    : "";
                                return (
                                    <li
                                        key={`${entry.at}-${idx}`}
                                        className="flex flex-col gap-1 px-4 py-3"
                                    >
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge
                                                variant={badge.variant}
                                                size="sm"
                                                className={badge.className}
                                            >
                                                {t(
                                                    `tax.history.kind.${entry.kind}`,
                                                )}
                                            </Badge>
                                            <span className="type-footnote tabular-nums text-label-secondary">
                                                {formatTimestamp(
                                                    entry.at,
                                                    language,
                                                )}
                                            </span>
                                            {entry.reference && (
                                                <span className="type-footnote font-medium text-warning">
                                                    ({entry.reference})
                                                </span>
                                            )}
                                        </div>
                                        {summary && (
                                            <p className="break-words type-footnote text-label-secondary">
                                                {summary}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </List>
                    </ScrollArea>
                )}
            </DialogContent>
        </Dialog>
    );
}
