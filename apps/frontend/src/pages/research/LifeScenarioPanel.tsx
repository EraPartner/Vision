import { useEffect, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { List, ListRow } from "@/components/ui/list";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { getSetting, saveSetting } from "@/lib/api/settings";
import { getPortfolioForecast } from "@/lib/api/research";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { parseDecimal } from "@/lib/decimal";
import { undoToast } from "@/lib/undoToast";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type {
    PortfolioForecast,
    PortfolioForecastInput,
} from "@/types/research";
import type { NumberFormat } from "@/utils/currency";
import { formatCurrency, formatEditableNumber } from "@/utils/currency";

const SETTING_KEY = "life_scenarios";
/** Radix Select items need a non-empty value; this one stands for "new scenario". */
const NEW_SCENARIO = "__new__";

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

function toDraft(
    scenario: LifeScenario,
    numberFormat: NumberFormat,
): ScenarioDraft {
    return {
        id: scenario.id,
        name: scenario.name,
        monthlySurplus: formatEditableNumber(
            scenario.monthlySurplus,
            numberFormat,
        ),
        monthlyIncomeLoss: formatEditableNumber(
            scenario.monthlyIncomeLoss,
            numberFormat,
        ),
        monthlyContribution: formatEditableNumber(
            scenario.monthlyContribution,
            numberFormat,
        ),
        goalValue:
            scenario.goalValue === undefined
                ? ""
                : formatEditableNumber(scenario.goalValue, numberFormat),
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
    const [loadAttempt, setLoadAttempt] = useState(0);

    useEffect(() => {
        let active = true;
        getSetting(SETTING_KEY)
            .then((result) => {
                if (active) {
                    setSavedError(false);
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
    }, [loadAttempt]);

    const edit = (patch: Partial<ScenarioDraft>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setComparison(null);
        setError(null);
    };

    const startNew = () => {
        setDraft(blankDraft());
        setComparison(null);
        setError(null);
    };

    const selectSaved = (id: string) => {
        const selected = scenarios.find((item) => item.id === id);
        setDraft(selected ? toDraft(selected, numberFormat) : blankDraft());
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
            setDraft(toDraft(scenario, numberFormat));
            setError(null);
        } catch (reason) {
            setError(apiErrorToMessage(reason, t));
        } finally {
            setSaving(false);
        }
    };

    // Deleting happens at once; the saved list is a setting we hold in memory,
    // so Undo can write the previous list back (ADR-179 "forgive, don't warn").
    const deleteDraft = async () => {
        if (!draft.id) return;
        const previous = scenarios;
        const removed = scenarios.find((item) => item.id === draft.id);
        try {
            setSaving(true);
            const next = scenarios.filter((item) => item.id !== draft.id);
            await saveSetting(SETTING_KEY, next);
            setScenarios(next);
            setDraft(blankDraft());
            setComparison(null);
            setError(null);
            undoToast({
                message: t("research.lifeScenario.deleted"),
                undoLabel: t("common.undo"),
                undo: async () => {
                    try {
                        await saveSetting(SETTING_KEY, previous);
                        setScenarios(previous);
                        if (removed) setDraft(toDraft(removed, numberFormat));
                    } catch (reason) {
                        setError(apiErrorToMessage(reason, t));
                    }
                },
            });
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
                <CardDescription>
                    {t("research.lifeScenario.subtitle")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                {savedError && (
                    <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                            <span>{t("research.lifeScenario.loadFailed")}</span>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={loadingSaved}
                                onClick={() => {
                                    setLoadingSaved(true);
                                    setLoadAttempt((attempt) => attempt + 1);
                                }}
                            >
                                {t("common.retry")}
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-56 flex-1 space-y-2">
                        <Label htmlFor="life-scenario-saved">
                            {t("research.lifeScenario.saved")}
                        </Label>
                        <Select
                            value={draft.id ?? NEW_SCENARIO}
                            disabled={saving}
                            onValueChange={(value) =>
                                value === NEW_SCENARIO
                                    ? startNew()
                                    : selectSaved(value)
                            }
                        >
                            <SelectTrigger id="life-scenario-saved">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NEW_SCENARIO}>
                                    {t("research.lifeScenario.new")}
                                </SelectItem>
                                {scenarios.map((item) => (
                                    <SelectItem key={item.id} value={item.id}>
                                        {item.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {draft.id && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={saving}
                            onClick={startNew}
                        >
                            <Plus aria-hidden="true" />
                            {t("research.lifeScenario.new")}
                        </Button>
                    )}
                </div>

                <div className="space-y-2">
                    <Label htmlFor="life-scenario-name">
                        {t("research.lifeScenario.name")}
                    </Label>
                    <Input
                        id="life-scenario-name"
                        disabled={saving}
                        maxLength={80}
                        value={draft.name}
                        onChange={(event) => edit({ name: event.target.value })}
                    />
                </div>

                <p className="type-footnote text-label-secondary">
                    {t("research.lifeScenario.amountsHelp", { currency })}
                </p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                </div>

                <fieldset className="space-y-3">
                    <legend className="type-headline text-foreground">
                        {t("research.lifeScenario.optionalGoal")}
                    </legend>
                    <div className="grid gap-4 sm:grid-cols-2">
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
                </fieldset>

                <p className="type-footnote text-label-secondary">
                    {t("research.lifeScenario.assumption")}
                </p>

                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        onClick={run}
                        disabled={running || saving}
                    >
                        {running
                            ? t("research.lifeScenario.running")
                            : t("research.lifeScenario.run")}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={saveDraft}
                        disabled={saving || loadingSaved || savedError}
                    >
                        {t("research.lifeScenario.save")}
                    </Button>
                    {draft.id && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={deleteDraft}
                            disabled={saving}
                        >
                            {t("research.lifeScenario.delete")}
                        </Button>
                    )}
                </div>

                {error && (
                    <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                {visibleComparison && !available && (
                    <Alert role="status">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertDescription>
                            {t("research.lifeScenario.unavailable")}
                        </AlertDescription>
                    </Alert>
                )}
                {visibleComparison && available && (
                    <section role="status" className="space-y-3">
                        <div className="space-y-1">
                            <h3 className="type-headline text-foreground">
                                {t("research.lifeScenario.result")}
                            </h3>
                            <p className="type-footnote text-label-secondary">
                                {t("research.lifeScenario.resultHelp")}
                            </p>
                        </div>
                        <List>
                            <ListRow
                                title={t("research.lifeScenario.baselineMedian")}
                                trailing={
                                    <span className="text-foreground">
                                        {money(
                                            visibleComparison.baseline.projected
                                                ?.p50,
                                        )}
                                    </span>
                                }
                            />
                            <ListRow
                                title={t(
                                    "research.lifeScenario.interruptedMedian",
                                )}
                                trailing={
                                    <span className="text-foreground">
                                        {money(
                                            visibleComparison.interrupted
                                                .projected?.p50,
                                        )}
                                    </span>
                                }
                            />
                            <ListRow
                                title={t("research.lifeScenario.medianGap")}
                                trailing={
                                    <span className="text-foreground">
                                        {money(medianGap)}
                                    </span>
                                }
                            />
                            {visibleComparison.goalMonth && (
                                <>
                                    <ListRow
                                        title={t(
                                            "research.lifeScenario.baselineGoalProbability",
                                        )}
                                        trailing={
                                            <span className="text-foreground">
                                                {pct(
                                                    visibleComparison.baseline
                                                        .probTarget,
                                                )}
                                            </span>
                                        }
                                    />
                                    <ListRow
                                        title={t(
                                            "research.lifeScenario.interruptedGoalProbability",
                                        )}
                                        trailing={
                                            <span className="text-foreground">
                                                {pct(
                                                    visibleComparison
                                                        .interrupted.probTarget,
                                                )}
                                            </span>
                                        }
                                    />
                                </>
                            )}
                        </List>
                        <p className="type-footnote text-label-secondary">
                            {t("research.lifeScenario.reducedContribution", {
                                amount: money(
                                    visibleComparison.reducedContribution,
                                ),
                            })}
                        </p>
                        {visibleComparison.monthlyDeficit > 0 && (
                            <p className="type-footnote text-destructive">
                                {t("research.lifeScenario.deficitExcluded", {
                                    amount: money(
                                        visibleComparison.monthlyDeficit,
                                    ),
                                })}
                            </p>
                        )}
                    </section>
                )}
            </CardContent>
        </Card>
    );
}
