import { useCallback, useEffect, useMemo, useState } from "react";
import { parseDecimal } from "@/lib/decimal";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePortfolioTaxAdjustments } from "@/hooks/usePortfolioTaxAdjustments";
import {
    usePortfolioTaxClassifications,
    type EtfStructure,
    type TaxClassificationEntry,
} from "@/hooks/usePortfolioTaxClassifications";
import { getAssetClassLabel, type InvestmentSummary } from "@/types/portfolio";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { List } from "@/components/ui/list";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    formatEditableNumber,
    formatNumberPlaceholder,
} from "@/utils/currency";

type ReyndersChoice = "auto" | "yes" | "no";

function reyndersFromChoice(v: ReyndersChoice): boolean | undefined {
    if (v === "yes") return true;
    if (v === "no") return false;
    return undefined;
}

function choiceFromReynders(v: boolean | undefined): ReyndersChoice {
    if (v === true) return "yes";
    if (v === false) return "no";
    return "auto";
}

type ClassDraftRow = {
    etfStructure?: EtfStructure;
    reynders: ReyndersChoice;
    interestPortion: string;
};

type AmountDraftRow = { taxes: string; fees: string };

const EMPTY_AMOUNTS: AmountDraftRow = { taxes: "", fees: "" };
const EMPTY_CLASS: ClassDraftRow = { reynders: "auto", interestPortion: "" };

interface Props {
    investments: InvestmentSummary[];
    /** Controlled open state; leave undefined to render the dialog's own trigger. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function PortfolioTaxAdjustmentsDialog({
    investments,
    open: controlledOpen,
    onOpenChange,
}: Props) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const zeroPlaceholder = formatNumberPlaceholder(appSettings.numberFormat);
    const profile = useBelgianTaxProfile((state) => state.profile);
    const { getAdjustment, saveManyForYear, isLoading } =
        usePortfolioTaxAdjustments();
    const {
        getClassification,
        setMany: setClassifications,
        isLoading: classificationsLoading,
    } = usePortfolioTaxClassifications();
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const setOpen = useCallback(
        (next: boolean) => {
            if (!isControlled) setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        [isControlled, onOpenChange],
    );

    const sorted = useMemo(
        () => [...investments].sort((a, b) => a.name.localeCompare(b.name)),
        [investments],
    );

    const [draft, setDraft] = useState<Record<number, AmountDraftRow>>({});
    const [classDraft, setClassDraft] = useState<Record<number, ClassDraftRow>>(
        {},
    );

    useEffect(() => {
        if (!open) return;
        const next: Record<number, AmountDraftRow> = {};
        const nextClass: Record<number, ClassDraftRow> = {};
        sorted.forEach((inv) => {
            const current = getAdjustment(profile.taxYear, inv.id);
            next[inv.id] = {
                taxes: current.taxes
                    ? formatEditableNumber(
                          current.taxes,
                          appSettings.numberFormat,
                      )
                    : "",
                fees: current.fees
                    ? formatEditableNumber(
                          current.fees,
                          appSettings.numberFormat,
                      )
                    : "",
            };
            const cls = getClassification(inv.id);
            nextClass[inv.id] = {
                etfStructure: cls.etfStructure,
                reynders: choiceFromReynders(cls.subjectToReynders),
                interestPortion:
                    typeof cls.reyndersInterestPortion === "number"
                        ? String(Math.round(cls.reyndersInterestPortion * 100))
                        : "",
            };
        });
        setDraft(next);
        setClassDraft(nextClass);
    }, [
        appSettings.numberFormat,
        open,
        sorted,
        getAdjustment,
        getClassification,
        profile.taxYear,
    ]);

    const parseNumber = useCallback(
        (v?: string) => parseDecimal(v, appSettings.numberFormat, 0),
        [appSettings.numberFormat],
    );

    const draftTotals = useMemo(() => {
        return sorted.reduce(
            (acc, inv) => {
                const row = draft[inv.id];
                acc.taxes += parseNumber(row?.taxes);
                acc.fees += parseNumber(row?.fees);
                return acc;
            },
            { taxes: 0, fees: 0 },
        );
    }, [sorted, draft, parseNumber]);

    // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
    const fmt = useCurrencyFormatter();

    const updateAmount = (
        id: number,
        field: keyof AmountDraftRow,
        value: string,
    ) =>
        setDraft((prev) => ({
            ...prev,
            [id]: { ...(prev[id] ?? EMPTY_AMOUNTS), [field]: value },
        }));

    const updateClass = (id: number, patch: Partial<ClassDraftRow>) =>
        setClassDraft((prev) => ({
            ...prev,
            [id]: { ...(prev[id] ?? EMPTY_CLASS), ...patch },
        }));

    async function handleSave(e: React.FormEvent) {
        e.preventDefault();
        const payload: Record<number, { taxes: number; fees: number }> = {};
        const classPayload: Record<number, TaxClassificationEntry> = {};
        sorted.forEach((inv) => {
            const row = draft[inv.id];
            payload[inv.id] = {
                taxes: parseNumber(row?.taxes),
                fees: parseNumber(row?.fees),
            };
            const cls = classDraft[inv.id];
            if (cls) {
                const portionPct = parseNumber(cls.interestPortion);
                const portion =
                    portionPct > 0 && portionPct <= 100
                        ? portionPct / 100
                        : undefined;
                classPayload[inv.id] = {
                    etfStructure: cls.etfStructure,
                    subjectToReynders: reyndersFromChoice(cls.reynders),
                    reyndersInterestPortion: portion,
                };
            }
        });
        try {
            await Promise.all([
                saveManyForYear(profile.taxYear, payload),
                setClassifications(classPayload),
            ]);
            toast.success(t("tax.manualAdjustmentsSaved"));
            setOpen(false);
        } catch {
            toast.error(t("tax.manualAdjustmentsSaveFailed"));
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {!isControlled && (
                <DialogTrigger asChild>
                    <Button
                        variant="outline"
                        disabled={isLoading || classificationsLoading}
                    >
                        <SlidersHorizontal aria-hidden="true" />
                        {t("tax.manualAdjustments")}
                    </Button>
                </DialogTrigger>
            )}
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>
                        {t("tax.manualAdjustmentsTitle", {
                            year: String(profile.taxYear),
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("tax.manualAdjustmentsDesc")}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter in any taxes/fees field saves. grid gap-5 mirrors
            DialogContent's layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleSave} className="grid gap-5">
                    <dl className="grid grid-cols-2 gap-6">
                        <div className="min-w-0">
                            <dt className="type-caption text-label-tertiary">
                                {t("tax.totalTaxesPaid")}
                            </dt>
                            <dd className="mt-1 type-title-2 tabular-nums text-loss">
                                {fmt(draftTotals.taxes)}
                            </dd>
                        </div>
                        <div className="min-w-0">
                            <dt className="type-caption text-label-tertiary">
                                {t("tax.totalFeesPaid")}
                            </dt>
                            <dd className="mt-1 type-title-2 tabular-nums text-loss">
                                {fmt(draftTotals.fees)}
                            </dd>
                        </div>
                    </dl>

                    <div className="max-h-[52vh] overflow-y-auto pr-1">
                        <List>
                            {sorted.map((inv) => {
                                const showEtfStructure =
                                    inv.assetClass === "etf";
                                const showReynders =
                                    inv.assetClass === "etf" ||
                                    inv.assetClass === "bond";
                                const cls: ClassDraftRow =
                                    classDraft[inv.id] ?? EMPTY_CLASS;
                                const reyndersResolved =
                                    cls.reynders === "yes" ||
                                    (cls.reynders === "auto" &&
                                        inv.assetClass === "bond");
                                return (
                                    <li
                                        key={inv.id}
                                        role="group"
                                        aria-label={inv.name}
                                        className="space-y-3 px-4 py-3"
                                    >
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="type-body font-medium text-foreground">
                                                {inv.name}
                                            </span>
                                            {inv.symbol && (
                                                <span className="font-mono type-footnote text-label-secondary">
                                                    {inv.symbol}
                                                </span>
                                            )}
                                            <Badge
                                                variant="secondary"
                                                size="sm"
                                            >
                                                {getAssetClassLabel(
                                                    t,
                                                    inv.assetClass,
                                                )}
                                            </Badge>
                                        </div>
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label
                                                    htmlFor={`taxes-${inv.id}`}
                                                >
                                                    {t("tax.taxes")}
                                                </Label>
                                                <Input
                                                    id={`taxes-${inv.id}`}
                                                    aria-label={`${t("tax.taxes")}: ${inv.name}`}
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={
                                                        draft[inv.id]?.taxes ??
                                                        ""
                                                    }
                                                    onChange={(e) =>
                                                        updateAmount(
                                                            inv.id,
                                                            "taxes",
                                                            e.target.value,
                                                        )
                                                    }
                                                    placeholder={
                                                        zeroPlaceholder
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label
                                                    htmlFor={`fees-${inv.id}`}
                                                >
                                                    {t("tax.fees")}
                                                </Label>
                                                <Input
                                                    id={`fees-${inv.id}`}
                                                    aria-label={`${t("tax.fees")}: ${inv.name}`}
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={
                                                        draft[inv.id]?.fees ??
                                                        ""
                                                    }
                                                    onChange={(e) =>
                                                        updateAmount(
                                                            inv.id,
                                                            "fees",
                                                            e.target.value,
                                                        )
                                                    }
                                                    placeholder={
                                                        zeroPlaceholder
                                                    }
                                                />
                                            </div>
                                        </div>
                                        {(showEtfStructure || showReynders) && (
                                            <Disclosure
                                                className="border-t border-border/50 pt-3"
                                                onInvalidCapture={(event) => {
                                                    // Keep optional fields mounted so drafts and native
                                                    // validation survive collapsing this section.
                                                    event.currentTarget.open = true;
                                                    (
                                                        event.target as HTMLElement
                                                    ).focus();
                                                }}
                                            >
                                                <DisclosureSummary
                                                    className="cursor-default rounded-chip"
                                                    aria-label={`${t("tax.treatmentOptions")}: ${inv.name}`}
                                                >
                                                    {t("tax.treatmentOptions")}
                                                </DisclosureSummary>
                                                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                                                    {showEtfStructure && (
                                                        <div className="space-y-2">
                                                            <Label
                                                                htmlFor={`etf-structure-${inv.id}`}
                                                            >
                                                                {t(
                                                                    "tax.etfStructure",
                                                                )}
                                                            </Label>
                                                            <Select
                                                                value={
                                                                    cls.etfStructure ??
                                                                    "accumulating"
                                                                }
                                                                onValueChange={(
                                                                    v,
                                                                ) =>
                                                                    updateClass(
                                                                        inv.id,
                                                                        {
                                                                            etfStructure:
                                                                                v as EtfStructure,
                                                                        },
                                                                    )
                                                                }
                                                            >
                                                                <SelectTrigger
                                                                    id={`etf-structure-${inv.id}`}
                                                                    aria-label={`${t("tax.etfStructure")}: ${inv.name}`}
                                                                >
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="accumulating">
                                                                        {t(
                                                                            "tax.etfStructure.accumulating",
                                                                        )}
                                                                    </SelectItem>
                                                                    <SelectItem value="distributing">
                                                                        {t(
                                                                            "tax.etfStructure.distributing",
                                                                        )}
                                                                    </SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                            <p className="type-footnote text-label-secondary">
                                                                {t(
                                                                    "tax.etfStructure.desc",
                                                                )}
                                                            </p>
                                                        </div>
                                                    )}
                                                    {showReynders && (
                                                        <div className="space-y-2">
                                                            <Label
                                                                htmlFor={`reynders-${inv.id}`}
                                                            >
                                                                {t(
                                                                    "tax.subjectToReynders",
                                                                )}
                                                            </Label>
                                                            <Select
                                                                value={
                                                                    cls.reynders
                                                                }
                                                                onValueChange={(
                                                                    v,
                                                                ) =>
                                                                    updateClass(
                                                                        inv.id,
                                                                        {
                                                                            reynders:
                                                                                v as ReyndersChoice,
                                                                        },
                                                                    )
                                                                }
                                                            >
                                                                <SelectTrigger
                                                                    id={`reynders-${inv.id}`}
                                                                    aria-label={`${t("tax.subjectToReynders")}: ${inv.name}`}
                                                                >
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="auto">
                                                                        {t(
                                                                            "tax.subjectToReynders.auto",
                                                                        )}
                                                                    </SelectItem>
                                                                    <SelectItem value="yes">
                                                                        {t(
                                                                            "tax.subjectToReynders.yes",
                                                                        )}
                                                                    </SelectItem>
                                                                    <SelectItem value="no">
                                                                        {t(
                                                                            "tax.subjectToReynders.no",
                                                                        )}
                                                                    </SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                            <p className="type-footnote text-label-secondary">
                                                                {t(
                                                                    "tax.subjectToReynders.desc",
                                                                )}
                                                            </p>
                                                        </div>
                                                    )}
                                                    {showReynders &&
                                                        reyndersResolved && (
                                                            <div className="space-y-2 md:col-span-2">
                                                                <Label
                                                                    htmlFor={`reynders-interest-${inv.id}`}
                                                                >
                                                                    {t(
                                                                        "tax.reyndersInterestPortion",
                                                                    )}
                                                                </Label>
                                                                <Input
                                                                    id={`reynders-interest-${inv.id}`}
                                                                    aria-label={`${t("tax.reyndersInterestPortion")}: ${inv.name}`}
                                                                    type="number"
                                                                    inputMode="numeric"
                                                                    min={0}
                                                                    max={100}
                                                                    step={1}
                                                                    value={
                                                                        cls.interestPortion
                                                                    }
                                                                    onChange={(
                                                                        e,
                                                                    ) =>
                                                                        updateClass(
                                                                            inv.id,
                                                                            {
                                                                                interestPortion:
                                                                                    e
                                                                                        .target
                                                                                        .value,
                                                                            },
                                                                        )
                                                                    }
                                                                    placeholder="100"
                                                                />
                                                                <p className="type-footnote text-label-secondary">
                                                                    {t(
                                                                        "tax.reyndersInterestPortion.desc",
                                                                    )}
                                                                </p>
                                                            </div>
                                                        )}
                                                </div>
                                            </Disclosure>
                                        )}
                                    </li>
                                );
                            })}
                        </List>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit">
                            {t("tax.manualAdjustmentsSave")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
