/**
 * CashFlowForecastChart — replaces CashFlowComparisonChart.
 *
 * Shows actual-to-date + 7-method statistical forecast for the rest of the
 * current month. Supports cumulative / daily-net view toggle, with/without
 * planned toggle, per-method legend toggles, and a diagnostics button.
 */

import { useState, useCallback } from "react";
import { useSearchParams } from "react-router";
import { AlertCircle, FlaskConical } from "lucide-react";

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Badge } from "@/components/ui/badge";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Label } from "@/components/ui/label";
import { StateBlock } from "@/components/shared/StateBlock";
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

const BORDER_COLOR = "hsl(var(--border))";
const EMPTY_IDS: number[] = [];

function methodToggleStyle(color: string, active: boolean) {
    return {
        borderColor: active ? color : BORDER_COLOR,
        opacity: active ? 1 : 0.5,
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

    const [selectedMethodIds, setVisibleMethodIds] = useState<
        Set<string> | undefined
    >();

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

    const availableMethods =
        data?.methods.filter(
            (method) => !method.error && method.daily.length > 0,
        ) ?? [];
    const defaultMethod =
        availableMethods.find((method) => method.id === "ensemble_imse") ??
        availableMethods[0];
    const visibleMethodIds =
        selectedMethodIds ?? new Set(defaultMethod ? [defaultMethod.id] : []);

    const toggleMethod = useCallback(
        (id: string) => {
            setVisibleMethodIds((prev) => {
                const next = new Set(
                    prev ?? (defaultMethod ? [defaultMethod.id] : []),
                );
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return next;
            });
        },
        [defaultMethod],
    );

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
        <SegmentedControl
            size="sm"
            value={mode}
            onValueChange={(v) => setMode(v as ForecastMode)}
            aria-label={t("cashflow.forecastTitle")}
            className="mb-3"
        >
            <SegmentedControlItem value="month">
                {t("cashflow.modeMonth")}
            </SegmentedControlItem>
            <SegmentedControlItem value="rolling">
                {t("cashflow.modeRolling")}
            </SegmentedControlItem>
        </SegmentedControl>
    );

    const rollingPresets = mode === "rolling" && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
            <span
                id="cashflow-rolling-window-label"
                className="type-footnote text-label-secondary"
            >
                {t("cashflow.rollingWindow")}
            </span>
            <SegmentedControl
                size="sm"
                value={String(rollingDays)}
                onValueChange={(v) => setRollingDays(Number(v) as RollingDays)}
                aria-labelledby="cashflow-rolling-window-label"
            >
                {ROLLING_PRESETS.map((days) => (
                    <SegmentedControlItem key={days} value={String(days)}>
                        {t("cashflow.windowDays", { days })}
                    </SegmentedControlItem>
                ))}
            </SegmentedControl>
        </div>
    );

    const controls = (
        <div className="mb-3 flex flex-wrap items-center gap-4">
            <SegmentedControl
                size="sm"
                value={view}
                onValueChange={(v) => setView(v as "cumulative" | "daily")}
                aria-label={t("cashflow.cumulative")}
            >
                <SegmentedControlItem value="cumulative">
                    {t("cashflow.cumulative")}
                </SegmentedControlItem>
                <SegmentedControlItem value="daily">
                    {t("cashflow.dailyNet")}
                </SegmentedControlItem>
            </SegmentedControl>

            <div className="flex items-center gap-2">
                <Switch
                    id="include-planned"
                    checked={includePlanned}
                    onCheckedChange={setIncludePlanned}
                />
                <Label
                    htmlFor="include-planned"
                    className="font-normal text-label-secondary"
                >
                    {t("cashflow.withPlanned")}
                </Label>
            </div>

            <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setShowDiagnostics(true)}
            >
                <FlaskConical />
                {t("cashflow.diagnostics")}
            </Button>
        </div>
    );

    const methodToggles = data && (
        <div className="flex flex-wrap gap-2 mb-3">
            {/* Non-toggleable "This Month" actual indicator */}
            <span
                className="flex min-h-8 items-center gap-1.5 rounded-chip border px-2 py-0.5 type-footnote text-foreground"
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
                        aria-pressed={active}
                        className="flex min-h-8 items-center gap-1.5 rounded-chip border px-2 py-0.5 type-footnote text-foreground transition-opacity duration-fast ease-glide focus-ring"
                        style={methodToggleStyle(color, active)}
                    >
                        <span
                            className="inline-block size-2 rounded-full"
                            style={swatchStyle(color)}
                        />
                        {m.label}
                        {m.error && (
                            <Badge variant="destructive" size="sm">
                                {t("cashflow.methodError")}
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
                    className="h-[320px] w-full rounded-card"
                />
            )}
            {error && (
                <StateBlock
                    icon={AlertCircle}
                    tone="destructive"
                    size="compact"
                    headingLevel={3}
                    title={t("cashflow.loadError")}
                />
            )}
            {data && !isLoading && (
                <>
                    <Disclosure className="mb-3">
                        <DisclosureSummary
                            tone="footnote"
                            className="rounded-chip py-2"
                        >
                            {t("cashflow.compareMethods")}
                        </DisclosureSummary>
                        <p className="mb-3 type-footnote text-label-secondary">
                            {t("cashflow.compareMethodsHelp")}
                        </p>
                        {methodToggles}
                    </Disclosure>
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
            <CardHeader className="space-y-3">
                <div>
                    <CardTitle variant="sm">
                        {t("cashflow.forecastTitle")}
                    </CardTitle>
                    <CardDescription>{description}</CardDescription>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
