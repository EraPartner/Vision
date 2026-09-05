import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminKeys } from "@/lib/queryKeys";
import {
    Activity,
    CheckCircle2,
    AlertTriangle,
    XCircle,
    RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { AdminErrorState } from "@/components/shared/AdminErrorState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateTimeStringWithAppSettings } from "@/lib/dateUtils";
import { numberFormatToLocale } from "@/utils/currency";
import { probeProvider } from "@/lib/api/admin";
import type { ProviderHealth } from "@/lib/api/admin";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useProviderHealthQuery } from "@/features/admin/useAdminQueries";

function StatusIcon({ failures }: { failures: number }) {
    if (failures === 0)
        return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (failures <= 2)
        return <AlertTriangle className="h-4 w-4 text-warning" />;
    return <XCircle className="h-4 w-4 text-destructive" />;
}

// Same three-step scale StatusIcon uses, expressed as the shared Badge's own
// status tones instead of a local class string.
function statusBadgeVariant(
    failures: number,
): "success" | "warning" | "destructive" {
    if (failures === 0) return "success";
    if (failures <= 2) return "warning";
    return "destructive";
}

function formatTs(
    ts: string | null,
    neverLabel: string,
    dateFormat: string,
    locale: string,
) {
    if (!ts) return neverLabel;
    return formatDateTimeStringWithAppSettings(ts, dateFormat, locale);
}

interface ProviderRowProps {
    provider: ProviderHealth;
    onProbe: (name: string) => void;
    isProbing: boolean;
}

function ProviderRow({ provider, onProbe, isProbing }: ProviderRowProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const dateFormat = appSettings.dateFormat;
    const neverLabel = t("admin.providers.never");
    const [expanded, setExpanded] = useState(false);

    return (
        <>
            <TableRow>
                <TableCell>
                    <div className="flex items-center gap-2">
                        <StatusIcon failures={provider.consecutive_failures} />
                        <span className="font-medium">{provider.label}</span>
                    </div>
                </TableCell>
                <TableCell>
                    <Badge variant="muted" size="sm">
                        {provider.kind}
                    </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                    {formatTs(
                        provider.last_success_at,
                        neverLabel,
                        dateFormat,
                        locale,
                    )}
                </TableCell>
                <TableCell>
                    <Badge
                        variant={statusBadgeVariant(
                            provider.consecutive_failures,
                        )}
                        size="sm"
                    >
                        {provider.consecutive_failures}
                    </Badge>
                </TableCell>
                <TableCell>
                    {provider.last_error &&
                    provider.consecutive_failures > 0 ? (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            className="text-xs text-destructive hover:underline text-left max-w-[200px] truncate block"
                        >
                            {provider.last_error}
                        </button>
                    ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                    )}
                </TableCell>
                <TableCell>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onProbe(provider.provider)}
                        disabled={isProbing}
                    >
                        {isProbing ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Activity className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1.5">
                            {t("admin.providers.checkNow")}
                        </span>
                    </Button>
                </TableCell>
            </TableRow>
            {expanded &&
                provider.last_error &&
                provider.consecutive_failures > 0 && (
                    <TableRow>
                        <TableCell
                            colSpan={6}
                            className="bg-destructive/5 text-xs text-destructive font-mono py-2 px-4"
                        >
                            {provider.last_error}
                            {provider.last_error_at && (
                                <span className="ml-2 text-muted-foreground">
                                    (
                                    {formatTs(
                                        provider.last_error_at,
                                        neverLabel,
                                        dateFormat,
                                        locale,
                                    )}
                                    )
                                </span>
                            )}
                        </TableCell>
                    </TableRow>
                )}
        </>
    );
}

export default function ProviderHealthPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const qc = useQueryClient();
    const [probingSet, setProbingSet] = useState<Set<string>>(new Set());

    const { data: providers, isLoading, error } = useProviderHealthQuery();

    const probeMutation = useMutation({
        mutationFn: probeProvider,
        onMutate: (name) => {
            setProbingSet((s) => new Set(s).add(name));
        },
        onSuccess: (result) => {
            const label =
                result.provider.label ??
                result.provider.provider ??
                String(result.provider);
            if (result.ok) {
                toast.success(
                    t("admin.providers.probeOk", { provider: label }),
                );
            } else {
                toast.error(
                    t("admin.providers.probeFail", { provider: label }),
                    {
                        description: result.error,
                    },
                );
            }
            void qc.invalidateQueries({ queryKey: adminKeys.providerHealth });
        },
        onError: (_err, name) => {
            toast.error(t("admin.providers.probeError", { provider: name }));
        },
        onSettled: (_data, _err, name) => {
            setProbingSet((s) => {
                const next = new Set(s);
                next.delete(name);
                return next;
            });
        },
    });

    return (
        <PageShell className="p-6">
            <PageHeader
                title={t("admin.providers.title")}
                subtitle={t("admin.providers.description")}
                icon={PAGE_ICONS["/admin/providers"]}
            />

            {error && (
                <AdminErrorState
                    error={error}
                    fallbackMessage={t("admin.providers.loadError")}
                />
            )}

            <Card className="glass-chrome">
                <CardHeader>
                    <CardTitle variant="sm">
                        {t("admin.providers.tableTitle")}
                    </CardTitle>
                </CardHeader>
                {/* TableSkeletonRows renders <tr>s, so the status role goes on
                    the CardContent around the table, only while loading. */}
                <CardContent
                    {...(isLoading ? loadingSurfaceProps : {})}
                    variant="flush"
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>
                                    {t("admin.providers.colProvider")}
                                </TableHead>
                                <TableHead>
                                    {t("admin.providers.colKind")}
                                </TableHead>
                                <TableHead>
                                    {t("admin.providers.colLastSuccess")}
                                </TableHead>
                                <TableHead>
                                    {t("admin.providers.colFailures")}
                                </TableHead>
                                <TableHead>
                                    {t("admin.providers.colLastError")}
                                </TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableSkeletonRows rows={7} cols={6} />
                            ) : (
                                providers?.map((p) => (
                                    <ProviderRow
                                        key={p.provider}
                                        provider={p}
                                        onProbe={(name) =>
                                            probeMutation.mutate(name)
                                        }
                                        isProbing={probingSet.has(p.provider)}
                                    />
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </PageShell>
    );
}
