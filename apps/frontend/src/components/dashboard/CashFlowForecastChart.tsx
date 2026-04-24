/**
 * CashFlowForecastChart — replaces CashFlowComparisonChart.
 *
 * Shows actual-to-date + 7-method statistical forecast for the rest of the
 * current month. Supports cumulative / daily-net view toggle, with/without
 * planned toggle, per-method legend toggles, and a diagnostics button.
 */

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, FlaskConical } from "lucide-react";

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getChartColor } from "@/components/charts/palette";
import { numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";
import { apiClient } from "@/lib/api";
import type { ForecastMethod } from "@/lib/api/aggregations";
import {
    ACTUAL_COLOR,
    METHOD_COLORS,
} from "@/utils/forecastMerge";
import { CashFlowForecastDiagnostics } from "./CashFlowForecastDiagnostics";
import { ForecastInner } from "./ForecastInner";

const ALL_METHOD_IDS: readonly string[] = [
    "simple_avg",
    "weighted_avg",
    "ewma",
    "holt_winters",
    "prophet_lite",
    "ensemble_imse",
    "monte_carlo_parametric",
    "monte_carlo_block_bootstrap",
];

const DEFAULT_VISIBLE_METHOD_IDS: readonly string[] = [
    "simple_avg",
    "weighted_avg",
    "ewma",
    "holt_winters",
    "prophet_lite",
    "ensemble_imse",
];

const BORDER_COLOR = "hsl(var(--border))";

function methodToggleStyle(color: string, active: boolean) {
    return {
        borderColor: active ? color : BORDER_COLOR,
        opacity: active ? 1 : 0.4,
    };
}

function swatchStyle(color: string) {
    return { background: color };
}

export interface CashFlowForecastChartProps {
    readonly excludedCategoryIds?: number[];
    readonly excludedRecipientIds?: number[];
    readonly currency?: string;
    readonly embedded?: boolean;
}

export function CashFlowForecastChart({
    excludedCategoryIds = [],
    excludedRecipientIds = [],
    currency = "EUR",
    embedded = false,
}: CashFlowForecastChartProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    const [view, setView] = useState<"cumulative" | "daily">("cumulative");
    const [includePlanned, setIncludePlanned] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);

    const [visibleMethodIds, setVisibleMethodIds] = useState<Set<string>>(
        () => new Set(DEFAULT_VISIBLE_METHOD_IDS),
    );

    const queryKey = [
        "cashflowForecastMethods",
        currency,
        excludedCategoryIds,
        excludedRecipientIds,
        includePlanned,
    ] as const;

    const { data, isLoading, error } = useQuery({
        queryKey,
        queryFn: () =>
            apiClient.getCashflowForecastMethods({
                currency,
                excluded_category_ids: excludedCategoryIds,
                excluded_recipient_ids: excludedRecipientIds,
                include_planned: includePlanned,
                include_backtest: true,
                mc_paths: 500,
                mc_percentiles: [25, 75],
            }),
        staleTime: 60_000,
    });

    const toggleMethod = useCallback((id: string) => {
        setVisibleMethodIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const monthName = data
        ? formatMonthYearWithAppSettings(
              new Date(data.month + "-01"),
              appSettings.dateFormat,
              locale,
          )
        : "";


    const controls = (
        <div className="flex flex-wrap items-center gap-4 mb-3">
            <Tabs
                value={view}
                onValueChange={(v) => setView(v as "cumulative" | "daily")}
            >
                <TabsList className="h-8">
                    <TabsTrigger value="cumulative" className="text-xs px-3">
                        {t("cashflow.cumulative")}
                    </TabsTrigger>
                    <TabsTrigger value="daily" className="text-xs px-3">
                        {t("cashflow.dailyNet")}
                    </TabsTrigger>
                </TabsList>
            </Tabs>

            <div className="flex items-center gap-2">
                <Switch
                    id="include-planned"
                    checked={includePlanned}
                    onCheckedChange={setIncludePlanned}
                    className="scale-90"
                />
                <label htmlFor="include-planned" className="text-xs text-muted-foreground cursor-pointer">
                    {t("cashflow.withPlanned")}
                </label>
            </div>

            <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 ml-auto"
                onClick={() => setShowDiagnostics(true)}
            >
                <FlaskConical className="h-3.5 w-3.5" />
                {t("cashflow.diagnostics")}
            </Button>
        </div>
    );

    const methodToggles = data && (
        <div className="flex flex-wrap gap-2 mb-3">
            {/* Non-toggleable "This Month" actual indicator */}
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs"
                style={{ borderColor: ACTUAL_COLOR }}>
                <span className="inline-block size-2 rounded-full" style={swatchStyle(ACTUAL_COLOR)} />
                {t("cashflow.thisMonth")}
            </span>
            {data.methods.map((m: ForecastMethod) => {
                const active = visibleMethodIds.has(m.id);
                const color = METHOD_COLORS[m.id] ?? getChartColor(7);
                return (
                    <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMethod(m.id)}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs transition-opacity"
                        style={methodToggleStyle(color, active)}
                    >
                        <span
                            className="inline-block size-2 rounded-full"
                            style={swatchStyle(color)}
                        />
                        {m.label}
                        {m.error && (
                            <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">
                                err
                            </Badge>
                        )}
                    </button>
                );
            })}
        </div>
    );

    const chartContent = (
        <div>
            {controls}
            {isLoading && (
                <Skeleton className="w-full h-[320px] rounded-lg" />
            )}
            {error && (
                <div className="flex items-center justify-center h-[320px] text-sm text-destructive">
                    {t("cashflow.loadError")}
                </div>
            )}
            {data && !isLoading && (
                <>
                    {methodToggles}
                    <ForecastInner
                        data={data}
                        view={view}
                        visibleMethodIds={visibleMethodIds}
                        currency={data.currency}
                    />
                </>
            )}
            {data?.diagnostics && (
                <CashFlowForecastDiagnostics
                    open={showDiagnostics}
                    onOpenChange={setShowDiagnostics}
                    diagnostics={data.diagnostics}
                    currency={data.currency}
                />
            )}
        </div>
    );

    if (embedded) return chartContent;

    return (
        <Card className="relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm lg:col-span-2">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/10 to-transparent rounded-full -mr-16 -mt-16" />
            <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
                        <Activity className="h-6 w-6" />
                    </div>
                    <div className="flex-1">
                        <CardTitle className="text-xl">
                            {t("cashflow.forecastTitle")}
                        </CardTitle>
                        <CardDescription className="text-base">
                            {t("cashflow.forecastDesc", { monthName })}
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
