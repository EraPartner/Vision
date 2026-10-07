import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminKeys } from "@/lib/queryKeys";
import {
    Database,
    HardDrive,
    MoreHorizontal,
    RefreshCw,
    Table2,
    Zap,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/PageHeader";
import { AdminErrorState } from "@/components/shared/AdminErrorState";
import { EmptyState } from "@/components/shared/EmptyState";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateTimeWithAppSettings } from "@/lib/dateUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { vacuumTable } from "@/lib/api/admin";
import type { DbTableStat } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { useDbStats } from "@/features/admin/useAdminQueries";

// ── Row skeleton ──────────────────────────────────────────────────────────────

function SkeletonRow() {
    return (
        <TableRow>
            {Array.from({ length: 7 }).map((_, i) => (
                <TableCell key={i}>
                    <Skeleton className="h-4 w-full" />
                </TableCell>
            ))}
        </TableRow>
    );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function SummaryCard({
    label,
    value,
    icon: Icon,
    loading,
}: {
    label: string;
    value: string;
    icon: React.ElementType;
    loading: boolean;
}) {
    return (
        <Card>
            <CardContent variant="headerless">
                <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-primary/12 text-primary">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <p className="type-callout text-label-secondary">
                            {label}
                        </p>
                        {loading ? (
                            <Skeleton className="mt-1 h-6 w-20" />
                        ) : (
                            <p className="type-title-2 tabular-nums text-foreground">
                                {value}
                            </p>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function TableStatRow({
    row,
    onVacuum,
    isVacuuming,
}: {
    row: DbTableStat;
    onVacuum: (table: string) => void;
    isVacuuming: boolean;
}) {
    const { t } = useLanguage();
    const navigate = useNavigate();
    // App settings, not the browser locale: an eu-format nl user with an
    // en-US browser otherwise saw US date order and separators here.
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const editorHref = `/admin/db/${encodeURIComponent(row.table_name)}`;

    function fmt(ts: string | null) {
        if (!ts) return "—";
        try {
            return formatDateTimeWithAppSettings(
                new Date(ts),
                appSettings.dateFormat,
                locale,
            );
        } catch {
            return ts;
        }
    }

    return (
        <TableRow>
            <TableCell>
                <TextLink to={editorHref} className="font-mono type-footnote">
                    {row.table_name}
                </TextLink>
            </TableCell>
            <TableCell className="text-right tabular-nums">
                {Number(row.live_rows).toLocaleString(locale)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
                <span
                    className={
                        Number(row.dead_rows) > 1000 ? "text-warning" : ""
                    }
                >
                    {Number(row.dead_rows).toLocaleString(locale)}
                </span>
            </TableCell>
            <TableCell className="type-footnote text-label-secondary">
                {fmt(row.last_autovacuum)}
            </TableCell>
            <TableCell className="type-footnote text-label-secondary">
                {fmt(row.last_autoanalyze)}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">
                {row.size}
            </TableCell>
            <TableCell className="text-right">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={t("dbMaintenance.rowMenu", {
                                table: row.table_name,
                            })}
                        >
                            <MoreHorizontal aria-hidden="true" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => navigate(editorHref)}>
                            <Table2
                                aria-hidden="true"
                                className="mr-2 h-4 w-4 text-label-secondary"
                            />
                            {t("dbMaintenance.openTable")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={isVacuuming}
                            onSelect={() => onVacuum(row.table_name)}
                        >
                            <Zap
                                aria-hidden="true"
                                className="mr-2 h-4 w-4 text-label-secondary"
                            />
                            {t("dbMaintenance.vacuumTable")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </TableCell>
        </TableRow>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DbMaintenancePage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const qc = useQueryClient();
    const [vacuumingTable, setVacuumingTable] = useState<string | null>(null);

    const { data, isLoading, error } = useDbStats();

    const vacuumMutation = useMutation({
        mutationFn: (table: string | null) => vacuumTable(table),
        onMutate: (table) => setVacuumingTable(table ?? "__all__"),
        onSuccess: (_, table) => {
            const label = table ?? t("dbMaintenance.allTables");
            toast.success(t("dbMaintenance.vacuumSuccess"), {
                description: label,
            });
            qc.invalidateQueries({ queryKey: adminKeys.dbStats });
        },
        onError: (err: Error, table) => {
            const label = table ?? t("dbMaintenance.allTables");
            toast.error(t("dbMaintenance.vacuumFailed"), {
                description: `${label}: ${apiErrorToMessage(err, t)}`,
            });
        },
        onSettled: () => setVacuumingTable(null),
    });

    function handleVacuumTable(table: string) {
        vacuumMutation.mutate(table);
    }

    function handleVacuumAll() {
        vacuumMutation.mutate(null);
    }

    function handleRefresh() {
        qc.invalidateQueries({ queryKey: adminKeys.dbStats });
    }

    const tableCount = data?.tables.length ?? 0;
    const isVacuuming = vacuumMutation.isPending;

    return (
        <PageShell>
            <PageHeader
                title={t("dbMaintenance.title")}
                subtitle={t("dbMaintenance.subtitle")}
                icon={PAGE_ICONS["/admin/db"]}
                iconColor="from-warning/20 to-warning/5 text-warning"
                actions={
                    <>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t("admin.moreActions")}
                                >
                                    <MoreHorizontal aria-hidden="true" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    disabled={isLoading}
                                    onSelect={handleRefresh}
                                >
                                    <RefreshCw
                                        aria-hidden="true"
                                        className={cn(
                                            "mr-2 h-4 w-4 text-label-secondary",
                                            isLoading && "animate-spin",
                                        )}
                                    />
                                    {t("dbMaintenance.refresh")}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button onClick={handleVacuumAll} disabled={isVacuuming}>
                            <Zap aria-hidden="true" />
                            {isVacuuming && vacuumingTable === "__all__"
                                ? t("dbMaintenance.vacuuming")
                                : t("dbMaintenance.vacuumAll")}
                        </Button>
                    </>
                }
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SummaryCard
                    label={t("dbMaintenance.totalSize")}
                    value={data?.db_size ?? "—"}
                    icon={HardDrive}
                    loading={isLoading}
                />
                <SummaryCard
                    label={t("dbMaintenance.tableCount")}
                    value={tableCount.toString()}
                    icon={Database}
                    loading={isLoading}
                />
            </div>

            {error && (
                <AdminErrorState
                    error={error}
                    fallbackMessage={t("dbMaintenance.loadError")}
                />
            )}

            <Card>
                <CardHeader>
                    <CardTitle variant="sm">
                        {t("dbMaintenance.tableStats")}
                    </CardTitle>
                </CardHeader>
                {/* The skeleton rows live inside <tbody>, where a wrapper
                    element would be invalid HTML; the CardContent around the
                    table carries the status role instead, only while loading. */}
                <CardContent
                    {...(isLoading ? loadingSurfaceProps : {})}
                    variant="flush"
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>
                                    {t("dbMaintenance.col.table")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("dbMaintenance.col.liveRows")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("dbMaintenance.col.deadRows")}
                                </TableHead>
                                <TableHead>
                                    {t("dbMaintenance.col.lastVacuum")}
                                </TableHead>
                                <TableHead>
                                    {t("dbMaintenance.col.lastAnalyze")}
                                </TableHead>
                                <TableHead className="text-right">
                                    {t("dbMaintenance.col.size")}
                                </TableHead>
                                <TableHead className="w-12 text-right">
                                    <span className="sr-only">
                                        {t("dbMaintenance.col.actions")}
                                    </span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 5 }).map((_, i) => (
                                      <SkeletonRow key={i} />
                                  ))
                                : data?.tables.map((row) => (
                                      <TableStatRow
                                          key={row.table_name}
                                          row={row}
                                          onVacuum={handleVacuumTable}
                                          isVacuuming={isVacuuming}
                                      />
                                  ))}
                            {!isLoading && !error && tableCount === 0 && (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={7}>
                                        <EmptyState
                                            size="compact"
                                            headingLevel={3}
                                            icon={Database}
                                            title={t("dbMaintenance.noTables")}
                                            action={
                                                <Button
                                                    variant="outline"
                                                    onClick={handleRefresh}
                                                >
                                                    {t("dbMaintenance.refresh")}
                                                </Button>
                                            }
                                        />
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
                <p className="px-6 pb-5 type-footnote text-label-secondary">
                    {t("dbMaintenance.statsNote")}
                </p>
            </Card>
        </PageShell>
    );
}
