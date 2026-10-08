/**
 * FileHeadersPanel — shows the detected columns of a selected CSV as soon as a
 * file is chosen, independent of which adapter/parser is selected.
 *
 * Header names render as always-visible chips; a sample of the first rows sits
 * in a collapsible section. When no separator is supplied it is sniffed from
 * the header line. Degrades to a muted notice when the file can't be read as
 * CSV (binary, spreadsheet, empty) instead of rendering nothing or crashing.
 */

import { useEffect, useState } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCsvPreview } from "@/hooks/useCsvPreview";
import { Badge } from "@/components/ui/badge";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    AlertCircle,
    ChevronRight,
    Loader2,
    TableProperties,
} from "lucide-react";
import { PEEK_BYTES, SEPARATOR_LABELS, detectSeparator } from "./csvSeparator";
import { cn } from "@/lib/utils";

/**
 * Sniff a separator from the file's first non-empty line. Only runs while
 * `enabled` (i.e. the caller didn't pin a separator). Returns "," until the
 * read resolves.
 */
function useAutoSeparator(file: File | null, enabled: boolean): string {
    const [sep, setSep] = useState(",");

    useEffect(() => {
        if (!file || !enabled) {
            setSep(",");
            return;
        }
        let cancelled = false;
        const reader = new FileReader();
        reader.onload = () => {
            if (cancelled) return;
            const text = String(reader.result ?? "");
            const firstLine =
                text.split(/\r\n|\r|\n/).find((l) => l.trim().length > 0) ?? "";
            setSep(detectSeparator(firstLine));
        };
        reader.onerror = () => {
            if (!cancelled) setSep(",");
        };
        reader.readAsText(file.slice(0, PEEK_BYTES));
        return () => {
            cancelled = true;
            reader.abort();
        };
    }, [file, enabled]);

    return sep;
}

interface FileHeadersPanelProps {
    file: File | null;
    /** Pin the delimiter; omit to auto-detect from the file. */
    separator?: string;
    encoding?: string;
    skipRows?: number;
    /** Header names to emphasise (e.g. the currently-mapped columns). */
    highlightedHeaders?: string[];
    /** Start with the sample-rows table collapsed. */
    defaultCollapsed?: boolean;
    maxRows?: number;
}

export function FileHeadersPanel({
    file,
    separator,
    encoding = "utf-8",
    skipRows = 0,
    highlightedHeaders = [],
    defaultCollapsed = false,
    maxRows = 5,
}: FileHeadersPanelProps) {
    const { t } = useLanguage();
    const autoSep = useAutoSeparator(file, separator === undefined);
    const effectiveSep = separator ?? autoSep;
    const { preview, isLoading, error } = useCsvPreview(
        file,
        effectiveSep,
        encoding,
        skipRows,
    );
    const [open, setOpen] = useState(!defaultCollapsed);

    if (!file) return null;

    if (isLoading) {
        return (
            <div
                role="status"
                className="flex items-center gap-2 type-footnote text-label-secondary"
            >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("importPage.csvParsing")}
            </div>
        );
    }

    const hasHeaders = Boolean(preview && preview.headers.length > 0);

    if (error || !hasHeaders) {
        return (
            <div className="flex items-center gap-2 rounded-card corner-continuous border border-dashed border-border/60 p-3 type-footnote text-label-secondary">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {t("csvHeaders.unreadable")}
            </div>
        );
    }

    const headers = preview!.headers;
    const rows = preview!.rows.slice(0, maxRows);
    const highlighted = new Set(highlightedHeaders.filter(Boolean));
    const sepLabel = SEPARATOR_LABELS[effectiveSep] ?? effectiveSep;

    return (
        <div className="space-y-3 rounded-card corner-continuous border border-border/60 bg-card/70 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5 type-footnote font-medium text-foreground">
                    <TableProperties className="h-3.5 w-3.5 text-primary" />
                    {t("csvHeaders.title")}
                </span>
                <span className="type-footnote text-label-secondary">
                    {t("csvHeaders.columns", { n: headers.length })}
                </span>
                {separator === undefined && (
                    <span className="type-footnote text-label-secondary">
                        {t("csvHeaders.delimiterDetected", { sep: sepLabel })}
                    </span>
                )}
            </div>

            <div className="flex flex-wrap gap-1.5">
                {headers.map((h, i) => (
                    <Badge
                        key={`${h}-${i}`}
                        variant={highlighted.has(h) ? "default" : "secondary"}
                        className="font-normal"
                    >
                        {h || "—"}
                    </Badge>
                ))}
            </div>

            {rows.length > 0 && (
                <Collapsible open={open} onOpenChange={setOpen}>
                    <CollapsibleTrigger className="flex items-center gap-1 rounded-chip type-footnote font-medium text-label-secondary transition-colors duration-fast ease-glide hover:text-foreground focus-ring">
                        <ChevronRight
                            className={cn(
                                "h-3.5 w-3.5 transition-transform",
                                open && "rotate-90",
                            )}
                        />
                        {t("csvHeaders.sampleRows")}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                        <div className="overflow-x-auto rounded-card corner-continuous border border-border/60">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        {headers.map((h, i) => (
                                            <TableHead
                                                key={`${h}-${i}`}
                                                className={
                                                    highlighted.has(h)
                                                        ? "bg-primary/5 font-medium text-primary"
                                                        : "text-muted-foreground"
                                                }
                                            >
                                                {h}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((row, ri) => (
                                        <TableRow key={ri}>
                                            {row.map((cell, ci) => (
                                                <TableCell
                                                    key={ci}
                                                    className={
                                                        highlighted.has(
                                                            headers[ci],
                                                        )
                                                            ? "text-foreground"
                                                            : "text-muted-foreground"
                                                    }
                                                >
                                                    <span className="line-clamp-1 block max-w-[140px]">
                                                        {cell || "—"}
                                                    </span>
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </CollapsibleContent>
                </Collapsible>
            )}
        </div>
    );
}
