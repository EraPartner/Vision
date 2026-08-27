import { PAGE_ICONS } from "@/lib/pageIcons";
/**
 * RebalancePage (ADR-098) — cash-aware rebalancing. Pick a built-in preset, a
 * saved custom plan, or build a new custom target allocation, then ask the server
 * how to deploy spendable budgeting cash into underweight sleeves without selling.
 * Custom plans are persisted via useRebalancePlans (the `rebalance_plans` setting).
 */
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/shared/Money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Scale, Loader2, Plus, Trash2, Save } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { formatPercent } from "@/utils/currency";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { cn } from "@/lib/utils";
import { useRebalancePlans } from "@/hooks/useRebalancePlans";
import type {
    ModelPortfolio,
    RebalanceResponse,
} from "@/lib/api/crossWorkspace";
import { PageShell } from "@/components/shared/PageShell";
import { useSearchParams } from "react-router";
import {
    parseRebalanceUrl,
    writeRebalanceUrl,
    type RebalanceUrlDraft,
} from "./rebalanceUrlState";

const MODELS: ModelPortfolio[] = ["sixty_forty", "all_weather", "three_fund"];

// Allocation sleeves offered in the custom editor. Mirrors the rolled-up sleeve
// vocabulary the server reports actuals in (crossWorkspaceDataService SLEEVE_ROLLUP)
// plus the preset-only sleeves, so custom target keys line up with actual values.
const SLEEVES = [
    "stocks",
    "intl_stocks",
    "bonds",
    "gold",
    "commodities",
    "crypto",
    "real_estate",
    "savings",
];

// Preset weights for seeding the editor from a preset ("load from preset"). Mirrors
// CLASSIC_PORTFOLIOS in services/portfolio/allocationAnalytics.js — keep in sync.
const PRESET_WEIGHTS: Record<ModelPortfolio, Record<string, number>> = {
    sixty_forty: { stocks: 0.6, bonds: 0.4 },
    all_weather: { stocks: 0.3, bonds: 0.55, gold: 0.075, commodities: 0.075 },
    three_fund: { stocks: 0.48, intl_stocks: 0.12, bonds: 0.4 },
};

interface Row {
    sleeve: string;
    pct: string;
}

const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
// A cap value only counts when entered and finite; blank/invalid means "deploy all".
const resolveCap = (raw: string, available: number): number | undefined => {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, 0, available) : undefined;
};
const fractionToPct = (w: number) => String(+(w * 100).toFixed(2));

function weightsToRows(weights: Record<string, number>): Row[] {
    const rows = Object.entries(weights).map(([sleeve, w]) => ({
        sleeve,
        pct: fractionToPct(w),
    }));
    return rows.length ? rows : [{ sleeve: "stocks", pct: "" }];
}

function actualsToRows(actuals: Record<string, number>): Row[] {
    const entries = Object.entries(actuals).filter(([, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (total <= 0)
        return [
            { sleeve: "stocks", pct: "60" },
            { sleeve: "bonds", pct: "40" },
        ];
    return entries.map(([sleeve, v]) => ({
        sleeve,
        pct: fractionToPct(v / total),
    }));
}

export default function RebalancePage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const currency = appSettings.defaultCurrency || "EUR";

    const {
        plans,
        upsertPlan,
        deletePlan,
        isSaving,
        isLoading: plansLoading,
    } = useRebalancePlans();
    const [searchParams, setSearchParams] = useSearchParams();
    const draft = useMemo(
        () => parseRebalanceUrl(searchParams),
        [searchParams],
    );
    const updateDraft = useCallback(
        (
            update:
                | RebalanceUrlDraft
                | ((previous: RebalanceUrlDraft) => RebalanceUrlDraft),
        ) => {
            setSearchParams(
                (previousParams) => {
                    const previousDraft = parseRebalanceUrl(previousParams);
                    const nextDraft =
                        typeof update === "function"
                            ? update(previousDraft)
                            : update;
                    return writeRebalanceUrl(previousParams, nextDraft);
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    // Source select value: `model:<preset>` | `plan:<id>` | `custom`.
    const source = draft.source;
    const isPreset = source.startsWith("model:");
    const presetModel = isPreset
        ? (source.slice(6) as ModelPortfolio)
        : undefined;
    const editingPlanId = source.startsWith("plan:")
        ? source.slice(5)
        : undefined;

    const rows = draft.rows;
    const planName = draft.name;
    const useCashCap = draft.capEnabled;
    const cashCapInput = draft.cap;

    useEffect(() => {
        if (plansLoading || !editingPlanId) return;
        const plan = plans.find((candidate) => candidate.id === editingPlanId);
        if (plan && !searchParams.has("target")) {
            updateDraft({
                source: `plan:${plan.id}`,
                rows: weightsToRows(plan.targetWeights),
                name: plan.name,
                capEnabled: plan.cashCap != null,
                cap: plan.cashCap != null ? String(plan.cashCap) : "",
            });
        } else if (!plan) {
            updateDraft((previous) => ({ ...previous, source: "custom" }));
        }
    }, [editingPlanId, plans, plansLoading, searchParams, updateDraft]);

    // Shared cached currency formatter. Also fixes a locale bug: the old inline
    // Intl.NumberFormat passed `undefined` locale, ignoring the user's
    // number-format setting; amounts now follow it like every other page.
    const fmtCurrency = useCurrencyFormatter(currency);
    const fmt = (v: number) => fmtCurrency(v, currency, 0);
    // Show up to one decimal so fractional targets (e.g. All Weather's 7.5%) read
    // accurately and the column doesn't visibly sum to 101% from rounding.
    // `minDigits: 0` preserves that "up to" behaviour; the shared formatter
    // replaces the old browser-locale toLocaleString, which ignored the app's
    // number-format setting (a third convention on this page).
    const pct = (v: number) =>
        formatPercent(v * 100, { digits: 1, minDigits: 0 });
    // t() returns the key itself when a translation is missing; fall back to the
    // raw sleeve key for asset classes outside the labelled set (e.g. `other`).
    const sleeveLabel = (sleeve: string) => {
        const key = `rebalance.sleeve.${sleeve}`;
        const label = t(key);
        return label === key ? sleeve : label;
    };

    // Lightweight inputs read: the rebalance endpoint returns available cash + actual
    // sleeve values regardless of target, so a throwaway preset call gives us the
    // figures needed to show available cash, default the cap, and seed "current mix".
    const inputs = useQuery({
        queryKey: ["rebalance-inputs", currency],
        queryFn: () =>
            apiClient.computeRebalance({ model: "sixty_forty", currency }),
        staleTime: 60_000,
    });
    const availableCash = inputs.data?.availableCash ?? 0;
    const currentActuals = inputs.data?.actualValues ?? {};

    const compute = useMutation({
        mutationFn: () => {
            if (isPreset && presetModel)
                return apiClient.computeRebalance({
                    model: presetModel,
                    currency,
                });
            const targetWeights = rowsToWeights(rows);
            const availableCashArg = useCashCap
                ? resolveCap(cashCapInput, availableCash)
                : undefined;
            return apiClient.computeRebalance({
                targetWeights,
                currency,
                availableCash: availableCashArg,
            });
        },
        // Errors render inline below the form (compute.isError) — keep the global
        // mutation-error backstop from also toasting the same failure.
        meta: { suppressErrorToast: true },
    });
    const result: RebalanceResponse | undefined = compute.data;

    const totalDeployed = result
        ? Object.values(result.deployment).reduce((s, v) => s + v, 0)
        : 0;

    const weightTotalPct = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
    const hasValidRows = rows.some((r) => r.sleeve && Number(r.pct) > 0);

    function rowsToWeights(rs: Row[]): Record<string, number> {
        const out: Record<string, number> = {};
        for (const r of rs) {
            if (!r.sleeve) continue;
            const n = Number(r.pct);
            if (!Number.isFinite(n) || n <= 0) continue;
            out[r.sleeve] = (out[r.sleeve] ?? 0) + n / 100;
        }
        return out;
    }

    function handleSourceChange(value: string) {
        compute.reset();
        if (value.startsWith("model:")) {
            updateDraft({
                source: value,
                rows: weightsToRows(
                    PRESET_WEIGHTS[value.slice(6) as ModelPortfolio],
                ),
                name: "",
                capEnabled: false,
                cap: "",
            });
            return;
        }
        if (value === "custom") {
            updateDraft({
                source: "custom",
                rows: Object.keys(currentActuals).length
                    ? actualsToRows(currentActuals)
                    : [
                          { sleeve: "stocks", pct: "60" },
                          { sleeve: "bonds", pct: "40" },
                      ],
                name: "",
                capEnabled: false,
                cap: "",
            });
            return;
        }
        const plan = plans.find((p) => `plan:${p.id}` === value);
        if (plan) {
            updateDraft({
                source: value,
                rows: weightsToRows(plan.targetWeights),
                name: plan.name,
                capEnabled: plan.cashCap != null,
                cap: plan.cashCap != null ? String(plan.cashCap) : "",
            });
        }
    }

    const updateRow = (i: number, patch: Partial<Row>) =>
        updateDraft((previous) => ({
            ...previous,
            rows: previous.rows.map((row, index) =>
                index === i ? { ...row, ...patch } : row,
            ),
        }));
    const addRow = () => {
        const used = new Set(rows.map((r) => r.sleeve));
        const next = SLEEVES.find((s) => !used.has(s)) ?? "";
        updateDraft((previous) => ({
            ...previous,
            rows: [...previous.rows, { sleeve: next, pct: "" }],
        }));
    };
    const removeRow = (i: number) =>
        updateDraft((previous) => ({
            ...previous,
            rows: previous.rows.filter((_, index) => index !== i),
        }));

    const seedFromCurrent = () =>
        updateDraft((previous) => ({
            ...previous,
            rows: actualsToRows(currentActuals),
        }));
    const seedFromPreset = (m: ModelPortfolio) =>
        updateDraft((previous) => ({
            ...previous,
            rows: weightsToRows(PRESET_WEIGHTS[m]),
        }));

    const onSave = async () => {
        const name = planName.trim();
        if (!name) {
            toast.error(t("rebalance.plan.nameRequired"));
            return;
        }
        const targetWeights = rowsToWeights(rows);
        if (!Object.keys(targetWeights).length) {
            toast.error(t("rebalance.editor.needSleeve"));
            return;
        }
        const id = editingPlanId ?? crypto.randomUUID();
        const cashCap = useCashCap
            ? resolveCap(cashCapInput, availableCash)
            : undefined;
        await upsertPlan({
            id,
            name,
            targetWeights,
            ...(cashCap != null ? { cashCap } : {}),
        });
        updateDraft((previous) => ({
            ...previous,
            source: `plan:${id}`,
        }));
    };

    const onDelete = async () => {
        if (!editingPlanId) return;
        await deletePlan(editingPlanId);
        updateDraft({
            source: "model:sixty_forty",
            rows: weightsToRows(PRESET_WEIGHTS.sixty_forty),
            name: "",
            capEnabled: false,
            cap: "",
        });
        compute.reset();
    };

    const showEditor = !isPreset;

    return (
        <PageShell className="">
            <PageHeader
                title={t("rebalance.title")}
                subtitle={t("rebalance.subtitle")}
                icon={PAGE_ICONS["/portfolio/rebalance"]}
            />

            <Card>
                <CardContent
                    variant="compact"
                    className="flex flex-wrap items-end gap-3"
                >
                    <div className="space-y-1.5">
                        <label
                            className="text-xs text-muted-foreground"
                            htmlFor="rebalance-source"
                        >
                            {t("rebalance.targetModel")}
                        </label>
                        <Select
                            value={source}
                            onValueChange={handleSourceChange}
                        >
                            <SelectTrigger
                                id="rebalance-source"
                                className="w-64"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectLabel>
                                        {t("rebalance.presets")}
                                    </SelectLabel>
                                    {MODELS.map((m) => (
                                        <SelectItem
                                            key={m}
                                            value={`model:${m}`}
                                        >
                                            {t(`rebalance.model.${m}`)}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                                {plans.length > 0 && (
                                    <>
                                        <SelectSeparator />
                                        <SelectGroup>
                                            <SelectLabel>
                                                {t("rebalance.savedPlans")}
                                            </SelectLabel>
                                            {plans.map((p) => (
                                                <SelectItem
                                                    key={p.id}
                                                    value={`plan:${p.id}`}
                                                >
                                                    {p.name}
                                                </SelectItem>
                                            ))}
                                        </SelectGroup>
                                    </>
                                )}
                                <SelectSeparator />
                                <SelectItem value="custom">
                                    {t("rebalance.customNew")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <Button
                        onClick={() => compute.mutate()}
                        disabled={
                            compute.isPending || (showEditor && !hasValidRows)
                        }
                        className="gap-2"
                    >
                        {compute.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Scale className="h-4 w-4" />
                        )}
                        {t("rebalance.compute")}
                    </Button>
                </CardContent>
            </Card>

            {showEditor && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle variant="sm">
                            {t("rebalance.editor.title")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={seedFromCurrent}
                            >
                                {t("rebalance.editor.loadCurrent")}
                            </Button>
                            <Select
                                onValueChange={(v) =>
                                    seedFromPreset(v as ModelPortfolio)
                                }
                            >
                                <SelectTrigger className="h-8 w-48 text-sm">
                                    <SelectValue
                                        placeholder={t(
                                            "rebalance.editor.loadPreset",
                                        )}
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    {MODELS.map((m) => (
                                        <SelectItem key={m} value={m}>
                                            {t(`rebalance.model.${m}`)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            {rows.map((row, i) => (
                                <div
                                    key={i}
                                    className="flex items-center gap-2"
                                >
                                    <Select
                                        value={row.sleeve}
                                        onValueChange={(v) =>
                                            updateRow(i, { sleeve: v })
                                        }
                                    >
                                        <SelectTrigger className="w-44">
                                            <SelectValue
                                                placeholder={t(
                                                    "rebalance.editor.sleevePlaceholder",
                                                )}
                                            />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SLEEVES.map((s) => (
                                                <SelectItem key={s} value={s}>
                                                    {t(`rebalance.sleeve.${s}`)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <div className="relative w-28">
                                        <Input
                                            type="number"
                                            min={0}
                                            max={100}
                                            step="any"
                                            inputMode="decimal"
                                            value={row.pct}
                                            onChange={(e) =>
                                                updateRow(i, {
                                                    pct: e.target.value,
                                                })
                                            }
                                            className="pr-6 text-right tabular-nums"
                                            aria-label={t("rebalance.target")}
                                        />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                            %
                                        </span>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removeRow(i)}
                                        aria-label={t(
                                            "rebalance.editor.removeSleeve",
                                        )}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                            <div className="flex items-center justify-between pt-1">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-1"
                                    onClick={addRow}
                                    disabled={rows.length >= SLEEVES.length}
                                >
                                    <Plus className="h-4 w-4" />
                                    {t("rebalance.editor.addSleeve")}
                                </Button>
                                <span
                                    className={cn(
                                        "text-sm tabular-nums",
                                        Math.round(weightTotalPct) === 100
                                            ? "text-muted-foreground"
                                            : "text-warning",
                                    )}
                                >
                                    {t("rebalance.editor.total")}:{" "}
                                    {formatPercent(weightTotalPct, {
                                        digits: 0,
                                    })}
                                </span>
                            </div>
                            {Math.round(weightTotalPct) !== 100 &&
                                weightTotalPct > 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        {t("rebalance.editor.normalizeNote")}
                                    </p>
                                )}
                        </div>

                        <div className="space-y-2 border-t pt-4">
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={useCashCap}
                                    onChange={(e) =>
                                        updateDraft((previous) => ({
                                            ...previous,
                                            capEnabled: e.target.checked,
                                        }))
                                    }
                                    className="h-4 w-4"
                                />
                                {t("rebalance.editor.capCash")}
                            </label>
                            {useCashCap && (
                                <div className="space-y-1">
                                    <Input
                                        type="number"
                                        min={0}
                                        max={availableCash}
                                        step="any"
                                        inputMode="decimal"
                                        value={cashCapInput}
                                        onChange={(e) =>
                                            updateDraft((previous) => ({
                                                ...previous,
                                                cap: e.target.value,
                                            }))
                                        }
                                        placeholder={String(
                                            Math.round(availableCash),
                                        )}
                                        className="w-40 text-right tabular-nums"
                                        aria-label={t(
                                            "rebalance.editor.capCash",
                                        )}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        {t("rebalance.editor.capHint", {
                                            amount: fmt(availableCash),
                                        })}
                                    </p>
                                </div>
                            )}
                        </div>

                        <div className="flex flex-wrap items-end gap-2 border-t pt-4">
                            <div className="space-y-1.5">
                                <Label
                                    htmlFor="plan-name"
                                    className="text-xs text-muted-foreground"
                                >
                                    {t("rebalance.plan.name")}
                                </Label>
                                <Input
                                    id="plan-name"
                                    value={planName}
                                    onChange={(e) =>
                                        updateDraft((previous) => ({
                                            ...previous,
                                            name: e.target.value,
                                        }))
                                    }
                                    placeholder={t(
                                        "rebalance.plan.namePlaceholder",
                                    )}
                                    className="w-56"
                                    maxLength={80}
                                />
                            </div>
                            <Button
                                onClick={onSave}
                                disabled={isSaving || !hasValidRows}
                                className="gap-2"
                            >
                                {isSaving ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Save className="h-4 w-4" />
                                )}
                                {editingPlanId
                                    ? t("rebalance.plan.update")
                                    : t("rebalance.plan.save")}
                            </Button>
                            {editingPlanId && (
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button
                                            variant="outline"
                                            className="gap-2 text-destructive"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                            {t("rebalance.plan.delete")}
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>
                                                {t(
                                                    "rebalance.plan.deleteTitle",
                                                )}
                                            </AlertDialogTitle>
                                            <AlertDialogDescription>
                                                {t(
                                                    "rebalance.plan.deleteConfirm",
                                                    { name: planName },
                                                )}
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>
                                                {t("common.cancel")}
                                            </AlertDialogCancel>
                                            <AlertDialogAction
                                                onClick={onDelete}
                                            >
                                                {t("rebalance.plan.delete")}
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {compute.isError && (
                <p className="text-sm text-destructive">
                    {apiErrorToMessage(compute.error, t)}
                </p>
            )}

            {result && (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle variant="label">
                                    {t("rebalance.availableCash")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-2xl font-bold text-primary">
                                    <Money
                                        amount={
                                            availableCash ||
                                            result.availableCash
                                        }
                                        currency={currency}
                                        fractionDigits={0}
                                    />
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {t("rebalance.availableCashHint")}
                                </p>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle variant="label">
                                    {t("rebalance.totalDeployed")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-2xl font-bold text-accent">
                                    <Money
                                        amount={totalDeployed}
                                        currency={currency}
                                        fractionDigits={0}
                                    />
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {t("rebalance.totalDeployedHint")}
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("rebalance.deploymentPlan")}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>
                                            {t("rebalance.sleeve")}
                                        </TableHead>
                                        <TableHead className="text-right">
                                            {t("rebalance.current")}
                                        </TableHead>
                                        <TableHead className="text-right">
                                            {t("rebalance.target")}
                                        </TableHead>
                                        <TableHead className="text-right">
                                            {t("rebalance.deploy")}
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {Array.from(
                                        new Set([
                                            ...Object.keys(result.actualValues),
                                            ...Object.keys(
                                                result.targetWeights,
                                            ),
                                        ]),
                                    )
                                        .sort()
                                        .map((sleeve) => {
                                            const deploy =
                                                result.deployment[sleeve] ?? 0;
                                            return (
                                                <TableRow key={sleeve}>
                                                    <TableCell className="font-medium">
                                                        {sleeveLabel(sleeve)}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        <Money
                                                            amount={
                                                                result
                                                                    .actualValues[
                                                                    sleeve
                                                                ] ?? 0
                                                            }
                                                            currency={currency}
                                                            fractionDigits={0}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {pct(
                                                            result
                                                                .targetWeights[
                                                                sleeve
                                                            ] ?? 0,
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {deploy > 0 ? (
                                                            <Badge variant="secondary">
                                                                <Money
                                                                    amount={
                                                                        deploy
                                                                    }
                                                                    currency={
                                                                        currency
                                                                    }
                                                                    fractionDigits={
                                                                        0
                                                                    }
                                                                    signed
                                                                />
                                                            </Badge>
                                                        ) : (
                                                            <span className="text-muted-foreground">
                                                                —
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                </TableBody>
                            </Table>
                            <p className="text-xs text-muted-foreground mt-3">
                                {t("rebalance.noSellNote")}
                            </p>
                        </CardContent>
                    </Card>
                </>
            )}
        </PageShell>
    );
}
