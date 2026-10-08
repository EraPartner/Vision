/**
 * ExportDialog — PDF report export configuration dialog.
 *
 * Lets the user pick report type (financial / portfolio / tax), period,
 * sections, and currency before triggering a server-side PDF download.
 */

import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { List } from "@/components/ui/list";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
import { todayYmd } from "@/lib/timezone";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useSettings } from "@/stores/hydration/SettingsHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { SUPPORTED_CURRENCIES } from "@/utils/currency";
import {
    downloadFinancialReport,
    downloadPortfolioReport,
    downloadTaxReport,
    type ReportPeriod,
} from "@/lib/api/reports";
import {
    SECTIONS_BY_TYPE,
    type ReportType,
    type SectionDef,
} from "@/features/reports/reportSections";

// ─── Constants ───────────────────────────────────────────────────────────────

type PeriodPreset = "ytd" | "rolling3" | "rolling12" | "year" | "custom";

// First 12 of the canonical list: EUR..CZK (unchanged dropdown contents).
const CURRENCIES = SUPPORTED_CURRENCIES.slice(0, 12);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPeriod(
    preset: PeriodPreset,
    customYear: string,
    customFrom: string,
    customTo: string,
): ReportPeriod {
    switch (preset) {
        case "ytd":
            return { kind: "ytd" };
        case "rolling3":
            return { kind: "rolling", months: 3 };
        case "rolling12":
            return { kind: "rolling", months: 12 };
        case "year":
            return {
                kind: "year",
                year: Number(customYear),
            };
        case "custom":
            return { kind: "custom", from: customFrom, to: customTo };
    }
}

function allSectionsEnabled(
    sections: ReadonlySet<string>,
    defs: SectionDef[],
): boolean {
    return defs.every((d) => sections.has(d.id));
}

function defaultSectionSet(defs: SectionDef[]): Set<string> {
    return new Set(defs.map((d) => d.id));
}

function isCustomRangeValid(from: string, to: string): boolean {
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(from) &&
        /^\d{4}-\d{2}-\d{2}$/.test(to) &&
        from <= to
    );
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ExportDialogProps {
    /**
     * Custom trigger element; defaults to an "Export PDF" button. Pass `null`
     * to render no trigger and drive the dialog through `open`/`onOpenChange`
     * (for example from a ••• menu item).
     */
    trigger?: React.ReactNode;
    /** Pre-selected report type when the dialog opens. Defaults to 'financial'. */
    defaultType?: ReportType;
    /** Controlled open state; leave undefined to let the trigger own it. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function ExportDialog({
    trigger,
    defaultType = "financial",
    open: controlledOpen,
    onOpenChange,
}: ExportDialogProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { settings: dashSettings } = useSettings();
    const { profile: taxProfile, calculation: pitCalc } = useBelgianTaxProfile(
        (state) => ({ profile: state.profile, calculation: state.calculation }),
    );
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const currentYear = new Date().getFullYear();

    // ── Dialog state (controlled when `open` is given)
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const open = controlledOpen ?? uncontrolledOpen;
    const setOpen = (next: boolean) => {
        if (controlledOpen === undefined) setUncontrolledOpen(next);
        onOpenChange?.(next);
    };

    // ── Form state
    const [reportType, setReportType] = useState<ReportType>(defaultType);
    const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("rolling12");
    const [customYear, setCustomYear] = useState(String(currentYear));
    const [customFrom, setCustomFrom] = useState(`${currentYear - 1}-01-01`);
    const [customTo, setCustomTo] = useState(todayYmd());
    const [sections, setSections] = useState<Set<string>>(() =>
        defaultSectionSet(SECTIONS_BY_TYPE[defaultType]),
    );
    const [currency, setCurrency] = useState(defaultCurrency);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const sectionDefs = SECTIONS_BY_TYPE[reportType];
    const customRangeInvalid =
        periodPreset === "custom" && !isCustomRangeValid(customFrom, customTo);

    const customYearInvalid =
        periodPreset === "year" &&
        (!/^\d{4}$/.test(customYear) ||
            Number(customYear) < 2000 ||
            Number(customYear) > currentYear + 1);
    const filtersApply =
        reportType === "financial" &&
        (dashSettings.exclusionScope === "everywhere" ||
            dashSettings.exclusionScope === "statistics");
    const excludedCategoryIds = filtersApply
        ? [...dashSettings.excludedCategoryIds]
        : [];
    const excludedRecipientIds = filtersApply
        ? [...dashSettings.excludedRecipientIds]
        : [];

    // Reset sections when report type changes
    function handleReportTypeChange(type: ReportType) {
        setReportType(type);
        setSections(defaultSectionSet(SECTIONS_BY_TYPE[type]));
    }

    function toggleSection(id: string, checked: boolean) {
        setSections((prev) => {
            const next = new Set(prev);
            if (checked) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }

    function toggleAllSections(checked: boolean) {
        setSections(checked ? defaultSectionSet(sectionDefs) : new Set());
    }

    async function handleDownload(e: React.FormEvent) {
        e.preventDefault();
        if (
            customRangeInvalid ||
            customYearInvalid ||
            sections.size === 0 ||
            isSubmitting
        )
            return;
        const period = buildPeriod(
            periodPreset,
            customYear,
            customFrom,
            customTo,
        );

        // If all sections selected (or none deselected), send empty to use backend defaults.
        const selectedSections = allSectionsEnabled(sections, sectionDefs)
            ? []
            : [...sections];

        const baseOpts = {
            currency,
            period,
            sections: selectedSections,
            excludedCategoryIds,
            excludedRecipientIds,
        };

        setIsSubmitting(true);
        try {
            if (reportType === "financial") {
                await downloadFinancialReport(baseOpts);
            } else if (reportType === "portfolio") {
                await downloadPortfolioReport(baseOpts);
            } else {
                const resolvedTaxProfile = taxProfile.profileConfigured
                    ? {
                          filingStatus: taxProfile.employmentType,
                          region: taxProfile.region,
                          taxYear: taxProfile.taxYear,
                      }
                    : undefined;
                const resolvedPIT = taxProfile.profileConfigured
                    ? {
                          taxableIncome: pitCalc.taxableIncome,
                          totalTax: pitCalc.totalPIT,
                          brackets: pitCalc.breakdown
                              .filter((e) => e.bracket)
                              // Translate the bracket label here rather than shipping pit.ts's
                              // English one into the report: reuses the same
                              // `tax.pit.row.bracket{n}` keys PitBreakdownCard renders on
                              // screen, so the exported report matches the UI in both
                              // languages. Rates are identical across tax years (25/40/45/50),
                              // only the boundaries move, so the fixed-rate key text is safe.
                              .map((e) => ({
                                  label: e.bracketNumber
                                      ? t(
                                            `tax.pit.row.bracket${e.bracketNumber}`,
                                        )
                                      : e.label,
                                  rate: e.rate,
                                  taxAmount: e.amount,
                              })),
                      }
                    : undefined;
                await downloadTaxReport({
                    ...baseOpts,
                    taxProfile: resolvedTaxProfile,
                    precomputedPIT: resolvedPIT,
                });
            }
            toast.success(t("statsPage.report.downloadSuccess"));
            setOpen(false);
        } catch (err: unknown) {
            toast.error(t("statsPage.report.downloadError"), {
                description: apiErrorToMessage(err, t),
            });
        } finally {
            setIsSubmitting(false);
        }
    }

    const allChecked = allSectionsEnabled(sections, sectionDefs);
    const someChecked = sections.size > 0 && !allChecked;
    const optionRowClass =
        "flex cursor-pointer items-center gap-3 px-4 py-2.5 type-body text-foreground transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04]";

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {trigger !== null && (
                <DialogTrigger asChild>
                    {trigger ?? (
                        <Button variant="outline">
                            <FileDown />
                            {t("export.openDialog")}
                        </Button>
                    )}
                </DialogTrigger>
            )}

            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("export.title")}</DialogTitle>
                    <DialogDescription>
                        {t("export.description")}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter (e.g. in the year field) downloads. grid gap-5
            mirrors DialogContent's layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleDownload} className="grid gap-5">
                    <div className="grid gap-5">
                        <section className="grid gap-2">
                            <h3
                                id="export-report-type-label"
                                className="type-headline text-foreground"
                            >
                                {t("export.reportType")}
                            </h3>
                            <SegmentedControl
                                aria-labelledby="export-report-type-label"
                                value={reportType}
                                onValueChange={(v) =>
                                    handleReportTypeChange(v as ReportType)
                                }
                                className="w-full"
                            >
                                {(
                                    ["financial", "portfolio", "tax"] as const
                                ).map((type) => (
                                    <SegmentedControlItem
                                        key={type}
                                        value={type}
                                    >
                                        {t(`export.reportType.${type}`)}
                                    </SegmentedControlItem>
                                ))}
                            </SegmentedControl>
                        </section>

                        <section className="grid gap-2">
                            <h3
                                id="export-period-label"
                                className="type-headline text-foreground"
                            >
                                {t("export.period")}
                            </h3>
                            <RadioGroup
                                aria-labelledby="export-period-label"
                                value={periodPreset}
                                onValueChange={(v) =>
                                    setPeriodPreset(v as PeriodPreset)
                                }
                                className="block"
                            >
                                <List>
                                    {(
                                        [
                                            "ytd",
                                            "rolling3",
                                            "rolling12",
                                            "year",
                                            "custom",
                                        ] as const
                                    ).map((preset) => (
                                        <li key={preset}>
                                            <label
                                                htmlFor={`export-period-${preset}`}
                                                className={optionRowClass}
                                            >
                                                <RadioGroupItem
                                                    id={`export-period-${preset}`}
                                                    value={preset}
                                                />
                                                <span>
                                                    {t(
                                                        `export.period.${preset}`,
                                                    )}
                                                </span>
                                            </label>
                                        </li>
                                    ))}
                                </List>
                            </RadioGroup>

                            {periodPreset === "year" && (
                                <div className="flex items-center gap-3 pt-1">
                                    <Label htmlFor="export-year">
                                        {t("export.period.year.label")}
                                    </Label>
                                    <Input
                                        id="export-year"
                                        type="number"
                                        aria-invalid={
                                            customYearInvalid || undefined
                                        }
                                        aria-describedby={
                                            customYearInvalid
                                                ? "export-year-error"
                                                : undefined
                                        }
                                        min={2000}
                                        max={currentYear + 1}
                                        value={customYear}
                                        onChange={(e) =>
                                            setCustomYear(e.target.value)
                                        }
                                        className="w-28"
                                    />
                                </div>
                            )}

                            {customYearInvalid && (
                                <p
                                    id="export-year-error"
                                    role="alert"
                                    className="type-footnote text-destructive"
                                >
                                    {t("export.period.year.invalid", {
                                        max: currentYear + 1,
                                    })}
                                </p>
                            )}

                            {periodPreset === "custom" && (
                                <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                                    <div className="grid gap-1.5">
                                        <Label htmlFor="export-from">
                                            {t("export.period.from")}
                                        </Label>
                                        <DatePicker
                                            id="export-from"
                                            value={
                                                customFrom
                                                    ? parseLocalDateFromYmd(
                                                          customFrom,
                                                      )
                                                    : undefined
                                            }
                                            onChange={(d) =>
                                                setCustomFrom(d ? toYmd(d) : "")
                                            }
                                            placeholder={t(
                                                "export.period.from",
                                            )}
                                            aria-invalid={
                                                customRangeInvalid || undefined
                                            }
                                            aria-describedby={
                                                customRangeInvalid
                                                    ? "export-range-error"
                                                    : undefined
                                            }
                                        />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <Label htmlFor="export-to">
                                            {t("export.period.to")}
                                        </Label>
                                        <DatePicker
                                            id="export-to"
                                            value={
                                                customTo
                                                    ? parseLocalDateFromYmd(
                                                          customTo,
                                                      )
                                                    : undefined
                                            }
                                            onChange={(d) =>
                                                setCustomTo(d ? toYmd(d) : "")
                                            }
                                            placeholder={t("export.period.to")}
                                            aria-invalid={
                                                customRangeInvalid || undefined
                                            }
                                            aria-describedby={
                                                customRangeInvalid
                                                    ? "export-range-error"
                                                    : undefined
                                            }
                                        />
                                    </div>
                                    {customRangeInvalid && (
                                        <p
                                            id="export-range-error"
                                            role="alert"
                                            className="type-footnote text-destructive sm:col-span-2"
                                        >
                                            {t("export.period.invalidRange")}
                                        </p>
                                    )}
                                </div>
                            )}
                        </section>

                        <section className="grid gap-2">
                            <div className="flex items-center justify-between gap-3">
                                <h3
                                    id="export-sections-label"
                                    className="type-headline text-foreground"
                                >
                                    {t("export.sections")}
                                </h3>
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        id="export-sections-all"
                                        checked={
                                            allChecked ||
                                            (someChecked
                                                ? "indeterminate"
                                                : false)
                                        }
                                        onCheckedChange={(checked) =>
                                            toggleAllSections(checked === true)
                                        }
                                    />
                                    <Label
                                        htmlFor="export-sections-all"
                                        className="text-label-secondary"
                                    >
                                        {t("export.sections.all")}
                                    </Label>
                                </div>
                            </div>

                            <List
                                role="group"
                                aria-labelledby="export-sections-label"
                            >
                                {sectionDefs.map((def) => (
                                    <li key={def.id}>
                                        <label
                                            htmlFor={`section-${def.id}`}
                                            className={optionRowClass}
                                        >
                                            <Checkbox
                                                id={`section-${def.id}`}
                                                checked={sections.has(def.id)}
                                                onCheckedChange={(checked) =>
                                                    toggleSection(
                                                        def.id,
                                                        checked === true,
                                                    )
                                                }
                                            />
                                            <span>{t(def.labelKey)}</span>
                                        </label>
                                    </li>
                                ))}
                            </List>
                        </section>

                        <section className="flex items-center justify-between gap-3">
                            <Label
                                htmlFor="export-currency"
                                className="type-headline text-foreground"
                            >
                                {t("export.currency")}
                            </Label>
                            <Select
                                value={currency}
                                onValueChange={setCurrency}
                            >
                                <SelectTrigger
                                    id="export-currency"
                                    className="w-32"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {CURRENCIES.map((c) => (
                                        <SelectItem key={c} value={c}>
                                            {c}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </section>
                    </div>

                    {(excludedCategoryIds.length > 0 ||
                        excludedRecipientIds.length > 0) && (
                        <p className="type-footnote text-label-secondary">
                            {t("export.exclusionsSummary", {
                                categories: excludedCategoryIds.length,
                                recipients: excludedRecipientIds.length,
                            })}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setOpen(false)}
                            disabled={isSubmitting}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                isSubmitting ||
                                sections.size === 0 ||
                                customRangeInvalid ||
                                customYearInvalid
                            }
                        >
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="animate-spin" />
                                    {t("export.downloading")}
                                </>
                            ) : (
                                <>
                                    <FileDown />
                                    {t("export.download")}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
