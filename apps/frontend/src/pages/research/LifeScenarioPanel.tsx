import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSetting, saveSetting } from "@/lib/api/settings";
import { getPortfolioForecast } from "@/lib/api/research";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { parseDecimal } from "@/lib/decimal";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type {
    PortfolioForecast,
    PortfolioForecastInput,
} from "@/types/research";
import type { NumberFormat } from "@/utils/currency";
import { formatCurrency } from "@/utils/currency";

const SETTING_KEY = "life_scenarios";

interface LifeScenario {
    id: string;
    name: string;
    kind: "income_interruption";
    interruptionMonths: 3;
    monthlySurplus: number;
    monthlyIncomeLoss: number;
    monthlyContribution: number;
    goalValue?: number;
    goalDate?: string;
}

interface ScenarioDraft {
    id?: string;
    name: string;
    monthlySurplus: string;
    monthlyIncomeLoss: string;
    monthlyContribution: string;
    goalValue: string;
    goalDate: string;
}

interface Comparison {
    baseline: PortfolioForecast;
    interrupted: PortfolioForecast;
    goalMonth?: number;
    reducedContribution: number;
    monthlyDeficit: number;
    signature: string;
}

interface LifeScenarioPanelProps {
    forecastInput: PortfolioForecastInput;
    currency: string;
    locale: string;
    numberFormat: NumberFormat;
}

const blankDraft = (): ScenarioDraft => ({
    name: "",
    monthlySurplus: "",
    monthlyIncomeLoss: "",
    monthlyContribution: "",
    goalValue: "",
    goalDate: "",
});

function toDraft(scenario: LifeScenario): ScenarioDraft {
    return {
        id: scenario.id,
        name: scenario.name,
        monthlySurplus: String(scenario.monthlySurplus),
        monthlyIncomeLoss: String(scenario.monthlyIncomeLoss),
        monthlyContribution: String(scenario.monthlyContribution),
        goalValue:
            scenario.goalValue === undefined ? "" : String(scenario.goalValue),
        goalDate: scenario.goalDate?.slice(0, 7) ?? "",
    };
}

function monthOfGoal(date: string, horizonMonths: number): number | null {
    if (!/^\d{4}-\d{2}$/.test(date)) return null;
    const parsed = new Date(`${date}-01T12:00:00`);
    if (
        Number.isNaN(parsed.getTime()) ||
        [parsed.getFullYear(), parsed.getMonth() + 1].join("-") !==
            date
                .split("-")
                .map((part) => Number(part))
                .join("-")
    )
        return null;
    const today = new Date();
    const month =
        (parsed.getFullYear() - today.getFullYear()) * 12 +
        parsed.getMonth() -
        today.getMonth();
    return month >= 1 && month <= horizonMonths ? month : null;
}

export default function LifeScenarioPanel({
    forecastInput,
    currency,
    locale,
    numberFormat,
}: LifeScenarioPanelProps) {
    const { t } = useLanguage();
    const [draft, setDraft] = useState<ScenarioDraft>(blankDraft);
    const [comparison, setComparison] = useState<Comparison | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [scenarios, setScenarios] = useState<LifeScenario[]>([]);
    const [loadingSaved, setLoadingSaved] = useState(true);
    const [savedError, setSavedError] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let active = true;
        getSetting(SETTING_KEY)
            .then((result) => {
                if (active) {
                    setScenarios(
                        Array.isArray(result.value)
                            ? (result.value as LifeScenario[])
                            : [],
                    );
                    setLoadingSaved(false);
                }
            })
            .catch(() => {
                if (active) {
                    setSavedError(true);
                    setLoadingSaved(false);
                }
            });
        return () => {
            active = false;
        };
    }, []);

    const edit = (patch: Partial<ScenarioDraft>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setComparison(null);
        setError(null);
    };

    const readScenario = (): {
        scenario: LifeScenario;
        goalMonth?: number;
    } | null => {
        const monthlySurplus = parseDecimal(
            draft.monthlySurplus,
            numberFormat,
            NaN,
        );
        const monthlyIncomeLoss = parseDecimal(
            draft.monthlyIncomeLoss,
            numberFormat,
            NaN,
        );
        const monthlyContribution = parseDecimal(
            draft.monthlyContribution,
            numberFormat,
            NaN,
        );
        const goalValue = draft.goalValue.trim()
            ? parseDecimal(draft.goalValue, numberFormat, NaN)
            : undefined;
        const hasGoalDate = Boolean(draft.goalDate);
        const goalMonth = hasGoalDate
            ? monthOfGoal(draft.goalDate, forecastInput.horizonMonths)
            : undefined;
        if (
            !draft.name.trim() ||
            draft.name.trim().length > 80 ||
            ![monthlySurplus, monthlyIncomeLoss, monthlyContribution].every(
                (value) => Number.isFinite(value) && value >= 0,
            ) ||
            monthlyContribution > monthlySurplus ||
            (goalValue !== undefined && !(goalValue > 0)) ||
            Boolean(goalValue) !== hasGoalDate ||
            (hasGoalDate && goalMonth === null)
        ) {
            setError(t("research.lifeScenario.invalid"));
            return null;
        }
        return {
            scenario: {
                id: draft.id ?? crypto.randomUUID(),
                name: draft.name.trim(),
                kind: "income_interruption",
                interruptionMonths: 3,
                monthlySurplus,
                monthlyIncomeLoss,
                monthlyContribution,
                ...(goalValue !== undefined
                    ? { goalValue, goalDate: `${draft.goalDate}-01` }
                    : {}),
            },
            ...(goalMonth ? { goalMonth } : {}),
        };
    };

    const saveDraft = async () => {
        const parsed = readScenario();
        if (!parsed) return;
        const scenario = parsed.scenario;
        const next = draft.id
            ? scenarios.map((item) => (item.id === draft.id ? scenario : item))
            : [...scenarios, scenario];
        try {
            setSaving(true);
            await saveSetting(SETTING_KEY, next);
            setScenarios(next);
            setDraft(toDraft(scenario));
            setError(null);
        } catch (reason) {
            setError(apiErrorToMessage(reason, t));
        } finally {
            setSaving(false);
        }
    };

    const deleteDraft = async () => {
        if (!draft.id) return;
        try {
            setSaving(true);
            const next = scenarios.filter((item) => item.id !== draft.id);
            await saveSetting(SETTING_KEY, next);
            setScenarios(next);
            setDraft(blankDraft());
            setComparison(null);
            setError(null);
        } catch (reason) {
            setError(apiErrorToMessage(reason, t));
        } finally {
            setSaving(false);
        }
    };

    const run = async () => {
        const parsed = readScenario();
        if (!parsed) return;
        const { scenario, goalMonth } = parsed;
        const reducedContribution = Math.max(
            0,
            Math.min(
                scenario.monthlyContribution,
                scenario.monthlySurplus - scenario.monthlyIncomeLoss,
            ),
        );
        const seed = `life-scenario:${scenario.id}`;
        const signature = JSON.stringify({ draft, forecastInput, currency });
        const common: PortfolioForecastInput = {
            ...forecastInput,
            monthlyContribution: scenario.monthlyContribution,
            targetValue: scenario.goalValue,
            goalMonth,
            seed,
        };
        setRunning(true);
        setError(null);
        setComparison(null);
        try {
            const [baseline, interrupted] = await Promise.all([
                getPortfolioForecast(common),
                getPortfolioForecast({
                    ...common,
                    monthlyContributionSchedule: Array.from(
                        { length: scenario.interruptionMonths },
                        () => reducedContribution,
                    ),
                }),
            ]);
            const comparableInputs = [
                "startValue",
                "historyDays",
                "expectedAnnualReturn",
                "annualVolatility",
                "forwardBlend",
            ] as const;
            if (
                comparableInputs.some(
                    (field) => baseline.data[field] !== interrupted.data[field],
                )
            ) {
                throw new Error(t("research.lifeScenario.inputsChanged"));
            }
            setComparison({
                baseline: baseline.data,
                interrupted: interrupted.data,
                goalMonth,
                reducedContribution,
                monthlyDeficit: Math.max(
                    0,
                    scenario.monthlyIncomeLoss - scenario.monthlySurplus,
                ),
                signature,
            });
        } catch (reason) {
            setError(apiErrorToMessage(reason, t));
        } finally {
            setRunning(false);
        }
    };

    const money = (amount: number | undefined) =>
        amount === undefined
            ? "—"
            : formatCurrency(amount, currency, locale, 0);
    const pct = (value: number | undefined) =>
        value === undefined
            ? "—"
            : new Intl.NumberFormat(locale, {
                  style: "percent",
                  maximumFractionDigits: 1,
              }).format(value);
    const visibleComparison =
        comparison?.signature ===
        JSON.stringify({ draft, forecastInput, currency })
            ? comparison
            : null;
    const available =
        visibleComparison?.baseline.available &&
        visibleComparison.interrupted.available;
    const medianGap =
        available &&
        visibleComparison.interrupted.projected?.p50 !== undefined &&
        visibleComparison.baseline.projected?.p50 !== undefined
            ? visibleComparison.interrupted.projected.p50 -
              visibleComparison.baseline.projected.p50
            : undefined;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("research.lifeScenario.title")}</CardTitle>
                <p className="text-sm text-muted-foreground">
                    {t("research.lifeScenario.subtitle")}
                </p>
            </CardHeader>
            <CardContent className="space-y-5">
                {savedError && (
                    <p role="alert" className="text-sm text-destructive">
                        {t("research.lifeScenario.loadFailed")}
                    </p>
                )}
                <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-56 flex-1 space-y-2">
                        <Label htmlFor="life-scenario-saved">
                            {t("research.lifeScenario.saved")}
                        </Label>
                        <select
                            id="life-scenario-saved"
                            disabled={saving}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={draft.id ?? ""}
                            onChange={(event) => {
                                const selected = scenarios.find(
                                    (item) => item.id === event.target.value,
                                );
                                setDraft(
                                    selected ? toDraft(selected) : blankDraft(),
                                );
                                setComparison(null);
                                setError(null);
                            }}
                        >
                            <option value="">
                                {t("research.lifeScenario.new")}
                            </option>
                            {scenarios.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={saving}
                        onClick={() => {
                            setDraft(blankDraft());
                            setComparison(null);
                            setError(null);
                        }}
                    >
                        {t("research.lifeScenario.new")}
                    </Button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-name">
                            {t("research.lifeScenario.name")}
                        </Label>
                        <Input
                            id="life-scenario-name"
                            disabled={saving}
                            maxLength={80}
                            value={draft.name}
                            onChange={(event) =>
                                edit({ name: event.target.value })
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-surplus">
                            {t("research.lifeScenario.monthlySurplus")}
                        </Label>
                        <Input
                            id="life-scenario-surplus"
                            disabled={saving}
                            type="text"
                            inputMode="decimal"
                            value={draft.monthlySurplus}
                            onChange={(event) =>
                                edit({ monthlySurplus: event.target.value })
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-loss">
                            {t("research.lifeScenario.monthlyIncomeLoss")}
                        </Label>
                        <Input
                            id="life-scenario-loss"
                            disabled={saving}
                            type="text"
                            inputMode="decimal"
                            value={draft.monthlyIncomeLoss}
                            onChange={(event) =>
                                edit({ monthlyIncomeLoss: event.target.value })
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-contribution">
                            {t("research.lifeScenario.monthlyContribution")}
                        </Label>
                        <Input
                            id="life-scenario-contribution"
                            disabled={saving}
                            type="text"
                            inputMode="decimal"
                            value={draft.monthlyContribution}
                            onChange={(event) =>
                                edit({
                                    monthlyContribution: event.target.value,
                                })
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-goal-value">
                            {t("research.lifeScenario.goalValue")}
                        </Label>
                        <Input
                            id="life-scenario-goal-value"
                            disabled={saving}
                            type="text"
                            inputMode="decimal"
                            value={draft.goalValue}
                            onChange={(event) =>
                                edit({ goalValue: event.target.value })
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="life-scenario-goal-date">
                            {t("research.lifeScenario.goalDate")}
                        </Label>
                        <Input
                            id="life-scenario-goal-date"
                            disabled={saving}
                            type="month"
                            value={draft.goalDate}
                            onChange={(event) =>
                                edit({ goalDate: event.target.value })
                            }
                        />
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t("research.lifeScenario.assumption")}
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        onClick={saveDraft}
                        disabled={saving || loadingSaved || savedError}
                    >
                        {t("research.lifeScenario.save")}
                    </Button>
                    {draft.id && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={deleteDraft}
                            disabled={saving}
                        >
                            {t("research.lifeScenario.delete")}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={run}
                        disabled={running || saving}
                    >
                        {running
                            ? t("research.lifeScenario.running")
                            : t("research.lifeScenario.run")}
                    </Button>
                </div>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {visibleComparison && !available && (
                    <p
                        role="status"
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                        <AlertTriangle className="size-4" />
                        {t("research.lifeScenario.unavailable")}
                    </p>
                )}
                {visibleComparison && available && (
                    <div
                        className="space-y-3 rounded-lg border p-4"
                        role="status"
                    >
                        <p className="font-medium">
                            {t("research.lifeScenario.result")}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                                <p className="text-xs text-muted-foreground">
                                    {t("research.lifeScenario.baselineMedian")}
                                </p>
                                <p className="font-medium tabular-nums">
                                    {money(
                                        visibleComparison.baseline.projected
                                            ?.p50,
                                    )}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">
                                    {t(
                                        "research.lifeScenario.interruptedMedian",
                                    )}
                                </p>
                                <p className="font-medium tabular-nums">
                                    {money(
                                        visibleComparison.interrupted.projected
                                            ?.p50,
                                    )}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">
                                    {t("research.lifeScenario.medianGap")}
                                </p>
                                <p className="font-medium tabular-nums">
                                    {money(medianGap)}
                                </p>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("research.lifeScenario.reducedContribution", {
                                amount: money(
                                    visibleComparison.reducedContribution,
                                ),
                            })}
                        </p>
                        {visibleComparison.monthlyDeficit > 0 && (
                            <p className="text-xs text-destructive">
                                {t("research.lifeScenario.deficitExcluded", {
                                    amount: money(
                                        visibleComparison.monthlyDeficit,
                                    ),
                                })}
                            </p>
                        )}
                        {visibleComparison.goalMonth && (
                            <div className="grid gap-3 sm:grid-cols-2">
                                <p>
                                    {t(
                                        "research.lifeScenario.baselineGoalProbability",
                                    )}
                                    :{" "}
                                    {pct(visibleComparison.baseline.probTarget)}
                                </p>
                                <p>
                                    {t(
                                        "research.lifeScenario.interruptedGoalProbability",
                                    )}
                                    :{" "}
                                    {pct(
                                        visibleComparison.interrupted
                                            .probTarget,
                                    )}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
