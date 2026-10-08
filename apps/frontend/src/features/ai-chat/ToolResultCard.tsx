import { lazy, memo, Suspense, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { numberFormatToLocale } from "@/utils/currency";
import type {
    ToolErrorDetail,
    ToolRenderAs,
    ToolResultPayload,
} from "@/types/aiChat";

const ToolResultChart = lazy(() => import("./ToolResultChart"));

function toolErrorTranslationKey(error: ToolResultPayload["error"]): string {
    if (!error || typeof error === "string") return "aiChat.toolFailed";
    const detail = error as ToolErrorDetail;
    if (detail.code === "VALIDATION_ERROR") {
        return "aiChat.toolError.validation";
    }
    if (detail.code === "UNKNOWN_TOOL") {
        return "aiChat.toolError.unavailable";
    }
    return "aiChat.toolFailed";
}

interface ToolResultCardProps {
    toolName?: string | null;
    result: ToolResultPayload;
}

type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
    if (Array.isArray(data)) {
        return data.filter(
            (r): r is Row => r !== null && typeof r === "object",
        );
    }
    if (data && typeof data === "object") {
        return [data as Row];
    }
    return [];
}

// App number-format locale, not the browser locale — an eu-format user with
// an en-US browser otherwise got US separators in tool-result tables.
function formatCell(value: unknown, locale: string): string {
    if (value === null || value === undefined) return "—";
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return String(value);
        if (Number.isInteger(value)) return value.toLocaleString(locale);
        return value.toLocaleString(locale, { maximumFractionDigits: 2 });
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function inferColumns(rows: Row[], preferred?: string[]): string[] {
    if (preferred && preferred.length > 0) return preferred;
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
}

function ToolResultCardInner({ toolName, result }: ToolResultCardProps) {
    const { t } = useLanguage();
    useEffect(() => {
        if (!result.ok && result.error) {
            logger.error("AI tool returned an error", {
                toolName,
                error: result.error,
            });
        }
    }, [result.error, result.ok, toolName]);

    const rows = useMemo(
        () => asRows(result.ok ? result.data : null),
        [result],
    );
    const meta = result.meta;
    const renderAs: ToolRenderAs | "json" =
        meta?.renderAs ?? (rows.length > 0 ? "table" : "json");

    if (!result.ok) {
        return (
            <Alert variant="destructive" className="px-3 py-2">
                <AlertDescription className="type-footnote font-medium">
                    {t(toolErrorTranslationKey(result.error))}
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <div className="space-y-2">
            {renderAs === "table" && (
                <TableView rows={rows} columns={meta?.columns} />
            )}
            {(renderAs === "line" ||
                renderAs === "bar" ||
                renderAs === "pie") && (
                <Suspense
                    fallback={<Skeleton className="h-56 w-full rounded-card" />}
                >
                    <ToolResultChart
                        kind={renderAs}
                        rows={rows}
                        xKey={meta?.xKey}
                        yKeys={meta?.yKeys}
                    />
                </Suspense>
            )}
            {renderAs === "json" && <JsonView data={result.data} />}
            <Footer meta={meta} rowCount={rows.length} />
        </div>
    );
}

function TableView({ rows, columns }: { rows: Row[]; columns?: string[] }) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const cols = inferColumns(rows, columns);
    if (cols.length === 0 || rows.length === 0) {
        return (
            <p className="type-footnote text-label-secondary">
                {t("aiChat.noRows")}
            </p>
        );
    }
    return (
        <div className="max-h-72 overflow-auto rounded-card corner-continuous border border-border/50 bg-background/60">
            <Table>
                <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                        {cols.map((col) => (
                            <TableHead key={col} className="h-8 px-2">
                                {col}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row, idx) => (
                        <TableRow
                            key={`${idx}-${cols
                                .map((c) => String(row[c] ?? ""))
                                .join("|")
                                .slice(0, 80)}`}
                        >
                            {cols.map((col) => {
                                const val = row[col];
                                const numeric = typeof val === "number";
                                return (
                                    <TableCell
                                        key={col}
                                        className={cn(
                                            "px-2 py-1.5 type-footnote",
                                            numeric &&
                                                "text-right tabular-nums",
                                        )}
                                    >
                                        {formatCell(val, locale)}
                                    </TableCell>
                                );
                            })}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function JsonView({ data }: { data: unknown }) {
    return (
        <pre className="max-h-64 overflow-auto rounded-control border border-border/50 bg-background/60 p-2 type-footnote leading-snug text-foreground/80">
            {JSON.stringify(data, null, 2)}
        </pre>
    );
}

function Footer({
    meta,
    rowCount,
}: {
    meta?: ToolResultPayload["meta"];
    rowCount: number;
}) {
    const { t, tc } = useLanguage();
    const total = typeof meta?.total === "number" ? meta.total : undefined;
    if (total === undefined && rowCount === 0) return null;
    const shown = rowCount;
    const label =
        total !== undefined && total !== shown
            ? t("aiChat.rowsShown", { shown, total })
            : tc("aiChat.rowCount", shown);
    return <p className="type-caption text-label-tertiary">{label}</p>;
}

// Memoized: for completed tool messages the props (toolName/result) are stable
// across streamed AI-chat token chunks, so the whole card — including its
// recharts tree — bails out of the per-token reconcile of the message backlog.
export const ToolResultCard = memo(ToolResultCardInner);
