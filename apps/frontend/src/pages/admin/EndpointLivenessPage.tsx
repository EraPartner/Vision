import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Radar, Search } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TableSkeletonRows } from "@/components/shared/TableSkeletonRows";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { RouteMetric, EndpointEntry } from "@/lib/api/admin";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useEndpointLivenessQueries } from "@/features/admin/useAdminQueries";

function methodBadgeClass(method: string) {
    switch (method) {
        case "GET":
            return "bg-info/10 text-info";
        case "POST":
            return "bg-success/10 text-success";
        case "PATCH":
        case "PUT":
            return "bg-warning/10 text-warning";
        case "DELETE":
            return "bg-destructive/10 text-destructive";
        default:
            return "bg-foreground/[0.06] text-label-secondary";
    }
}

function errorRateClass(rate: number) {
    if (rate >= 10) return "text-destructive font-medium";
    if (rate > 2) return "text-warning";
    return "text-label-secondary";
}

type MergedRow = EndpointEntry & Partial<RouteMetric>;

export default function EndpointLivenessPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [filter, setFilter] = useState("");

    const { manifest: manifestQuery, metrics: metricsQuery } =
        useEndpointLivenessQueries();
    const { data: manifest, isLoading: manifestLoading } = manifestQuery;
    const { data: metrics } = metricsQuery;

    const rows = useMemo<MergedRow[]>(() => {
        if (!manifest) return [];

        const metricsByKey = new Map<string, RouteMetric>();
        for (const m of metrics ?? []) {
            metricsByKey.set(`${m.method}:${m.path}`, m);
        }

        return manifest.map((entry) => {
            const metric = metricsByKey.get(`${entry.method}:${entry.path}`);
            return { ...entry, ...metric };
        });
    }, [manifest, metrics]);

    const filtered = useMemo(() => {
        if (!filter) return rows;
        const q = filter.toLowerCase();
        return rows.filter(
            (r) =>
                r.path.toLowerCase().includes(q) ||
                r.method.toLowerCase().includes(q),
        );
    }, [rows, filter]);

    return (
        <PageShell>
            <PageHeader
                title={t("admin.endpoints.title")}
                subtitle={t("admin.endpoints.description")}
                icon={PAGE_ICONS["/admin/endpoints"]}
            />

            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-4">
                    <CardTitle variant="sm">
                        {t("admin.endpoints.tableTitle")}
                    </CardTitle>
                    <div className="relative w-full sm:w-64">
                        <Search
                            aria-hidden="true"
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-label-tertiary"
                        />
                        <Input
                            placeholder={t("admin.endpoints.filterPlaceholder")}
                            aria-label={t("admin.endpoints.filterPlaceholder")}
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            className="pl-9"
                        />
                    </div>
                </CardHeader>
                {/* TableSkeletonRows renders <tr>s, so the status role goes on
                    the CardContent around the table, only while loading. */}
                <CardContent
                    {...(manifestLoading ? loadingSurfaceProps : {})}
                    variant="flush"
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-24">
                                    {t("admin.endpoints.colMethod")}
                                </TableHead>
                                <TableHead>
                                    {t("admin.endpoints.colPath")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("admin.endpoints.colRequests")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("admin.endpoints.colErrors")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("admin.endpoints.colErrorRate")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("admin.endpoints.colP50")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("admin.endpoints.colP95")}
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {manifestLoading ? (
                                <TableSkeletonRows rows={10} cols={7} />
                            ) : filtered.length === 0 ? (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={7}>
                                        <EmptyState
                                            size="compact"
                                            headingLevel={3}
                                            icon={Radar}
                                            title={t(
                                                "admin.endpoints.noMatches",
                                            )}
                                        />
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filtered.map((row) => (
                                    <TableRow key={`${row.method}:${row.path}`}>
                                        <TableCell>
                                            <span
                                                className={cn(
                                                    "inline-flex items-center rounded-chip px-1.5 py-0.5 font-mono type-caption",
                                                    methodBadgeClass(
                                                        row.method,
                                                    ),
                                                )}
                                            >
                                                {row.method}
                                            </span>
                                        </TableCell>
                                        <TableCell className="font-mono type-footnote">
                                            {row.path}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {row.count ?? "—"}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {row.errors ?? "—"}
                                        </TableCell>
                                        <TableCell
                                            className={cn(
                                                "text-right tabular-nums",
                                                row.error_rate !== undefined
                                                    ? errorRateClass(
                                                          row.error_rate * 100,
                                                      )
                                                    : "text-label-secondary",
                                            )}
                                        >
                                            {row.error_rate !== undefined
                                                ? formatPercent(
                                                      row.error_rate * 100,
                                                      { digits: 1 },
                                                  )
                                                : "—"}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums text-label-secondary">
                                            {row.p50_ms !== undefined
                                                ? `${row.p50_ms}ms`
                                                : "—"}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums text-label-secondary">
                                            {row.p95_ms !== undefined
                                                ? `${row.p95_ms}ms`
                                                : "—"}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </PageShell>
    );
}
