/**
 * CashFlowForecastChart — replaces CashFlowComparisonChart.
 *
 * Shows actual-to-date + 7-method statistical forecast for the rest of the
 * current month. Supports cumulative / daily-net view toggle, with/without
 * planned toggle, per-method legend toggles, and a diagnostics button.
 */

import { useState, useCallback } from "react";
import { CardSheen } from "@/components/shared/CardSheen";
import { useSearchParams } from "react-router";
import { FlaskConical } from "lucide-react";

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
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getChartColor } from "@/components/charts/palette";
import { numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatMonthYearWithAppSettings } from "@/lib/dateUtils";
import type { CashflowForecastMethod } from "@/lib/api/aggregations";
import { ACTUAL_COLOR, METHOD_COLORS } from "@/utils/forecastMerge";
import { CashFlowForecastDiagnostics } from "./CashFlowForecastDiagnostics";
import { ForecastInner } from "./ForecastInner";
import { ForecastInnerRolling } from "./ForecastInnerRolling";
import { useCashflowForecastQueries } from "./useDashboardQueries";

type ForecastMode = "month" | "rolling";
type RollingDays = 30 | 60 | 90 | 180;
const ROLLING_PRESETS: ReadonlyArray<RollingDays> = [30, 60, 90, 180];

const DEFAULT_VISIBLE_METHOD_IDS: readonly string[] = [
    "simple_avg",
    "weighted_avg",
    "ewma",
    "holt_winters",
    "prophet_lite",
    "ensemble_imse",
    "monte_carlo_block_bootstrap",
];

const BORDER_COLOR = "hsl(var(--border))";
const EMPTY_IDS: number[] = [];

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
    excludedCategoryIds = EMPTY_IDS,
    excludedRecipientIds = EMPTY_IDS,
    currency = "EUR",
    embedded = false,
}: CashFlowForecastChartProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    const [searchParams, setSearchParams] = useSearchParams();
    const mode: ForecastMode =
        searchParams.get("forecastMode") === "rolling" ? "rolling" : "month";
    const rollingDays: RollingDays = (() => {
        const v = Number(searchParams.get("rollingDays"));
        return (ROLLING_PRESETS as readonly number[]).includes(v)
            ? (v as RollingDays)
            : 90;
    })();

    function setMode(newMode: ForecastMode) {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.set("forecastMode", newMode);
                return next;
            },
            { replace: true },
        );
    }
    function setRollingDays(days: RollingDays) {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.set("rollingDays", String(days));
                return next;
            },
            { replace: true },
        );
    }

    const [view, setView] = useState<"cumulative" | "daily">("cumulative");
    const [includePlanned, setIncludePlanned] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);

    const [visibleMethodIds, setVisibleMethodIds] = useState<Set<string>>(
        () => new Set(DEFAULT_VISIBLE_METHOD_IDS),
    );

    const { monthQuery, rollingQuery, rollingDiagnosticsQuery } =
        useCashflowForecastQueries({
            currency,
            excludedCategoryIds,
            excludedRecipientIds,
            includePlanned,
            mode,
            rollingDays,
            showDiagnostics,
        });

    const data = mode === "month" ? monthQuery.data : rollingQuery.data;
    const isLoading =
        mode === "month" ? monthQuery.isLoading : rollingQuery.isLoading;
    const error = mode === "month" ? monthQuery.error : rollingQuery.error;

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

    const monthName =
        mode === "month" && monthQuery.data
            ? formatMonthYearWithAppSettings(
                  new Date(monthQuery.data.month + "-01T00:00:00"),
                  appSettings.dateFormat,
                  locale,
              )
            : "";

    const description =
        mode === "rolling"
            ? t("cashflow.rollingDesc", { n: rollingDays })
            : t("cashflow.forecastDesc", { monthName });

    const modeTabs = (
        <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as ForecastMode)}
            className="mb-3"
        >
            <TabsList className="h-8">
                <TabsTrigger value="month" className="text-xs px-3">
                    {t("cashflow.modeMonth")}
                </TabsTrigger>
                <TabsTrigger value="rolling" className="text-xs px-3">
                    {t("cashflow.modeRolling")}
                </TabsTrigger>
            </TabsList>
        </Tabs>
    );

    const rollingPresets = mode === "rolling" && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-muted-foreground">
                {t("cashflow.rollingWindow")}
            </span>
            {ROLLING_PRESETS.map((days) => {
                const active = rollingDays === days;
                return (
                    <button
                        key={days}
                        type="button"
                        onClick={() => setRollingDays(days)}
                        className="px-3 py-0.5 rounded-full border text-xs transition-opacity"
                        style={{
                            borderColor: active
                                ? "hsl(var(--primary))"
                                : BORDER_COLOR,
                            opacity: active ? 1 : 0.55,
                            background: active
                                ? "hsl(var(--primary) / 0.08)"
                                : "transparent",
                        }}
                    >
                        {t(`cashflow.window${days}`)}
                    </button>
                );
            })}
        </div>
    );

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
                <label
                    htmlFor="include-planned"
                    className="text-xs text-muted-foreground cursor-pointer"
                >
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
            <span
                className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs"
                style={{ borderColor: ACTUAL_COLOR }}
            >
                <span
                    className="inline-block size-2 rounded-full"
                    style={swatchStyle(ACTUAL_COLOR)}
                />
                {t("cashflow.thisMonth")}
            </span>
            {data.methods.map((m: CashflowForecastMethod) => {
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
                            <Badge
                                variant="destructive"
                                className="text-2xs px-1 py-0 h-4"
                            >
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
            {modeTabs}
            {rollingPresets}
            {controls}
            {isLoading && (
                <Skeleton
                    {...loadingSurfaceProps}
                    className="w-full h-[320px] rounded-lg"
                />
            )}
            {error && (
                <div className="flex items-center justify-center h-[320px] text-sm text-destructive">
                    {t("cashflow.loadError")}
                </div>
            )}
            {data && !isLoading && (
                <>
                    {methodToggles}
                    {mode === "month" && monthQuery.data ? (
                        <ForecastInner
                            data={monthQuery.data}
                            view={view}
                            visibleMethodIds={visibleMethodIds}
                            currency={monthQuery.data.currency}
                        />
                    ) : null}
                    {mode === "rolling" && rollingQuery.data ? (
                        <ForecastInnerRolling
                            data={rollingQuery.data}
                            view={view}
                            visibleMethodIds={visibleMethodIds}
                            currency={rollingQuery.data.currency}
                        />
                    ) : null}
                </>
            )}
            {(() => {
                const diag =
                    mode === "month"
                        ? monthQuery.data?.diagnostics
                        : rollingDiagnosticsQuery.data?.diagnostics;
                const cur =
                    mode === "month"
                        ? monthQuery.data?.currency
                        : (rollingQuery.data?.currency ??
                          rollingDiagnosticsQuery.data?.currency);
                return diag && cur ? (
                    <CashFlowForecastDiagnostics
                        open={showDiagnostics}
                        onOpenChange={setShowDiagnostics}
                        diagnostics={diag}
                        currency={cur}
                    />
                ) : null;
            })()}
        </div>
    );

    if (embedded) return chartContent;

    return (
        <Card className="relative overflow-hidden lg:col-span-2">
            <CardSheen />
            <CardHeader className="space-y-3">
                <div>
                    <CardTitle variant="sm">
                        {t("cashflow.forecastTitle")}
                    </CardTitle>
                    <CardDescription className="text-base">
                        {description}
                    </CardDescription>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
