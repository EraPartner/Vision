import { lazy, memo, Suspense, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { numberFormatToLocale } from "@/utils/currency";
import type {
    ToolErrorDetail,
    ToolRenderAs,
    ToolResultPayload,
} from "@/types/aiChat";

const ToolResultChart = lazy(() => import("./ToolResultChart"));

function formatToolError(
    error: ToolResultPayload["error"],
    fallback: string,
): string {
    if (!error) return fallback;
    if (typeof error === "string") return error;
    const detail = error as ToolErrorDetail;
    const parts: string[] = [];
    if (detail.field) parts.push(detail.field);
    if (detail.message) parts.push(detail.message);
    if (parts.length === 0) {
        if (detail.code) parts.push(detail.code);
        else {
            try {
                return JSON.stringify(detail);
            } catch {
                return fallback;
            }
        }
    }
    return parts.join(": ");
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
    const rows = useMemo(
        () => asRows(result.ok ? result.data : null),
        [result],
    );
    const meta = result.meta;
    const renderAs: ToolRenderAs | "json" =
        meta?.renderAs ?? (rows.length > 0 ? "table" : "json");

    if (!result.ok) {
        return (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-xs font-medium text-destructive">
                    {toolName ? `${toolName}: ` : ""}
                    {formatToolError(result.error, t("aiChat.toolFailed"))}
                </p>
            </div>
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
                    fallback={
                        <div
                            className="h-56 w-full animate-pulse rounded-lg bg-muted/35"
                            aria-hidden="true"
                        />
                    }
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
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const cols = inferColumns(rows, columns);
    if (cols.length === 0 || rows.length === 0) {
        return <p className="text-xs text-muted-foreground">No rows.</p>;
    }
    return (
        <div className="max-h-72 overflow-auto rounded-lg border border-border/40 bg-background/60">
            <table className="w-full border-collapse text-2xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                        {cols.map((col) => (
                            <th
                                key={col}
                                className="border-b border-border/40 px-2 py-1.5 text-left eyebrow"
                            >
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, idx) => (
                        <tr
                            key={`${idx}-${cols
                                .map((c) => String(row[c] ?? ""))
                                .join("|")
                                .slice(0, 80)}`}
                            className={cn(
                                "border-b border-border/20 last:border-b-0",
                                idx % 2 === 1 && "bg-muted/20",
                            )}
                        >
                            {cols.map((col) => {
                                const val = row[col];
                                const numeric = typeof val === "number";
                                return (
                                    <td
                                        key={col}
                                        className={cn(
                                            "px-2 py-1 text-foreground/90",
                                            numeric &&
                                                "text-right tabular-nums",
                                        )}
                                    >
                                        {formatCell(val, locale)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function JsonView({ data }: { data: unknown }) {
    return (
        <pre className="max-h-64 overflow-auto rounded-md border border-border/40 bg-background/60 p-2 text-2xs leading-snug text-foreground/80">
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
    const total = typeof meta?.total === "number" ? meta.total : undefined;
    if (total === undefined && rowCount === 0) return null;
    const shown = rowCount;
    const label =
        total !== undefined && total !== shown
            ? `Showing ${shown} of ${total}`
            : `${shown} row${shown === 1 ? "" : "s"}`;
    return <p className="eyebrow">{label}</p>;
}

// Memoized: for completed tool messages the props (toolName/result) are stable
// across streamed AI-chat token chunks, so the whole card — including its
// recharts tree — bails out of the per-token reconcile of the message backlog.
export const ToolResultCard = memo(ToolResultCardInner);
