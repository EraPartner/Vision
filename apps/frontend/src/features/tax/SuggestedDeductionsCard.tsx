import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { getTaxTable } from "@/lib/belgianTax";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { TaxProfileDialog } from "./TaxProfileDialog";

const PWC_DEDUCTIONS_URL =
    "https://taxsummaries.pwc.com/belgium/individual/deductions";

function PwcGuideLink() {
    const { t } = useLanguage();
    return (
        <a
            className="inline-flex items-center gap-1 rounded-chip type-callout text-primary hover:underline focus-ring"
            href={PWC_DEDUCTIONS_URL}
            target="_blank"
            rel="noreferrer"
        >
            {t("tax.suggestions.pwcLink")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
    );
}

export function SuggestedDeductionsCard() {
    const { profile, calculation } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        calculation: state.calculation,
    }));
    const { t } = useLanguage();

    // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
    const fmt = useCurrencyFormatter();

    const suggestions = useMemo(() => {
        const items: Array<{
            id: string;
            title: string;
            desc: string;
            estimate?: number;
            note?: string;
        }> = [];
        // All rates / caps resolved from the year-aware tax table so suggestions stay
        // accurate when historical (or future) tax years are selected.
        const table = getTaxTable(profile.taxYear);
        const donationRate = table.charitableDonationRate;
        const childcareRate = table.childcareRate;
        const childcareDailyCap = table.childcareDailyCap;
        const lifeInsuranceRate = table.lifeInsuranceRate;
        const lifeInsuranceCap = table.lifeInsuranceCap;
        const groupInsuranceRate = table.groupInsuranceRate;
        const domesticHelpRate = table.domesticHelpRate;
        const alimonyFraction = table.alimonyDeductibleFraction;

        // Pension savings
        const pensionCeiling =
            profile.pensionScheme === "1350"
                ? table.pensionSavingsCapAlternative
                : table.pensionSavingsCapStandard;
        const pensionRate =
            profile.pensionScheme === "1350"
                ? table.pensionSavingsRateAlternative
                : table.pensionSavingsRateStandard;
        const pensionMaxCredit = pensionCeiling * pensionRate;
        if (
            profile.pensionEligible &&
            !(profile.personalPensionContributions > 0)
        ) {
            items.push({
                id: "pension.no_amount",
                title: t("tax.suggestions.item.pension"),
                desc: t("tax.suggestions.pension.noAmount"),
                estimate: pensionMaxCredit,
            });
        } else if (
            !profile.pensionEligible &&
            profile.personalPensionContributions > 0
        ) {
            const est =
                Math.min(profile.personalPensionContributions, pensionCeiling) *
                pensionRate;
            items.push({
                id: "pension.not_marked",
                title: t("tax.suggestions.item.pension"),
                desc: t("tax.suggestions.pension.notMarked"),
                estimate: est,
            });
        } else if (
            !profile.pensionEligible &&
            profile.grossAnnualIncome > 0 &&
            profile.personalPensionContributions === 0
        ) {
            items.push({
                id: "pension.suggest",
                title: t("tax.suggestions.item.pension"),
                desc: t("tax.suggestions.pension.suggest"),
                estimate: pensionMaxCredit,
            });
        }

        // Life insurance
        if (
            profile.lifeInsuranceEligible &&
            !(profile.lifeInsurancePremiums > 0)
        ) {
            items.push({
                id: "life.no_amount",
                title: t("tax.suggestions.item.life"),
                desc: t("tax.suggestions.life.noAmount"),
                estimate: lifeInsuranceCap * lifeInsuranceRate,
            });
        } else if (
            !profile.lifeInsuranceEligible &&
            profile.lifeInsurancePremiums > 0
        ) {
            const est =
                Math.min(profile.lifeInsurancePremiums, lifeInsuranceCap) *
                lifeInsuranceRate;
            items.push({
                id: "life.not_marked",
                title: t("tax.suggestions.item.life"),
                desc: t("tax.suggestions.life.notMarked"),
                estimate: est,
            });
        }

        // Group insurance
        if (
            profile.employeeGroupInsuranceEligible &&
            !((profile.employeeGroupInsuranceContributions ?? 0) > 0)
        ) {
            items.push({
                id: "group.no_amount",
                title: t("tax.suggestions.item.group"),
                desc: t("tax.suggestions.group.noAmount"),
                estimate: 0,
            });
        } else if (
            !profile.employeeGroupInsuranceEligible &&
            (profile.employeeGroupInsuranceContributions ?? 0) > 0
        ) {
            items.push({
                id: "group.not_marked",
                title: t("tax.suggestions.item.group"),
                desc: t("tax.suggestions.group.notMarked"),
                estimate:
                    (profile.employeeGroupInsuranceContributions ?? 0) *
                    groupInsuranceRate,
            });
        } else if (
            !profile.employeeGroupInsuranceEligible &&
            profile.employmentType === "employee" &&
            !((profile.employeeGroupInsuranceContributions ?? 0) > 0)
        ) {
            items.push({
                id: "group.suggest",
                title: t("tax.suggestions.item.group"),
                desc: t("tax.suggestions.group.suggest"),
                estimate: 0,
            });
        }

        // Charitable donations
        if (
            profile.charitableDonationsEligible &&
            !(profile.charitableDonations > 0)
        ) {
            items.push({
                id: "donations.no_amount",
                title: t("tax.suggestions.item.donations"),
                desc: t("tax.suggestions.donations.noAmount"),
                note: t("tax.suggestions.donations.note"),
            });
        } else if (
            !profile.charitableDonationsEligible &&
            profile.charitableDonations > 0
        ) {
            const est = donationRate * profile.charitableDonations;
            items.push({
                id: "donations.not_marked",
                title: t("tax.suggestions.item.donations"),
                desc: t("tax.suggestions.donations.notMarked"),
                estimate: est,
            });
        }

        // Childcare
        const childcareCap =
            (profile.childcareEligibleDays || 0) * childcareDailyCap;
        if (profile.childcareEligible && !(profile.childcareCosts > 0)) {
            items.push({
                id: "childcare.no_amount",
                title: t("tax.suggestions.item.childcare"),
                desc: t("tax.suggestions.childcare.noAmount"),
                estimate: 0,
            });
        } else if (!profile.childcareEligible && profile.childcareCosts > 0) {
            const est =
                childcareRate * Math.min(profile.childcareCosts, childcareCap);
            items.push({
                id: "childcare.not_marked",
                title: t("tax.suggestions.item.childcare"),
                desc: t("tax.suggestions.childcare.notMarked"),
                estimate: est,
            });
        } else if (
            !profile.childcareEligible &&
            profile.dependentChildren > 0 &&
            profile.childcareEligibleDays === 0
        ) {
            // soft suggestion — show example using 120 days
            const exampleDays = 120;
            const exampleEst =
                childcareRate * (exampleDays * childcareDailyCap);
            items.push({
                id: "childcare.suggest",
                title: t("tax.suggestions.item.childcare"),
                desc: t("tax.suggestions.childcare.suggest", {
                    days: exampleDays,
                }),
                estimate: exampleEst,
            });
        }

        // Domestic help
        if (
            profile.domesticHelpEligible &&
            !((profile.domesticHelpCosts ?? 0) > 0)
        ) {
            items.push({
                id: "domestic.no_amount",
                title: t("tax.suggestions.item.domestic"),
                desc: t("tax.suggestions.domestic.noAmount"),
                estimate: 0,
            });
        } else if (
            !profile.domesticHelpEligible &&
            (profile.domesticHelpCosts ?? 0) > 0
        ) {
            const est = domesticHelpRate * (profile.domesticHelpCosts ?? 0);
            items.push({
                id: "domestic.not_marked",
                title: t("tax.suggestions.item.domestic"),
                desc: t("tax.suggestions.domestic.notMarked"),
                estimate: est,
            });
        }

        // Alimony (deduction) — estimate tax saving using marginal rate
        if (profile.alimonyPaid > 0) {
            const deduction = alimonyFraction * profile.alimonyPaid;
            const marginal =
                Math.max(0, Math.min(calculation.marginalRate, 100)) / 100;
            const estSaving = deduction * marginal;
            items.push({
                id: "alimony.applied",
                title: t("tax.suggestions.item.alimony"),
                desc: t("tax.suggestions.alimony.applied"),
                estimate: estSaving,
            });
        }

        return items;
    }, [profile, calculation, t]);

    if (!suggestions || suggestions.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t("tax.suggestions.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <p className="type-body text-label-secondary">
                        {t("tax.suggestions.none")}
                    </p>
                    <p className="type-footnote text-label-secondary">
                        {t("tax.suggestions.regionalNote")}
                    </p>
                    <PwcGuideLink />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.suggestions.title")}</CardTitle>
            </CardHeader>
            <CardContent>
                <ul className="divide-y divide-border/50">
                    {suggestions.map((s) => (
                        <li
                            key={s.id}
                            className="flex items-start justify-between gap-4 py-3 first:pt-0"
                        >
                            <div className="min-w-0 space-y-0.5">
                                <p className="type-body font-medium text-foreground">
                                    {s.title}
                                </p>
                                <p className="type-footnote text-label-secondary">
                                    {s.desc}
                                </p>
                                {s.note && (
                                    <p className="type-footnote text-label-secondary">
                                        {s.note}
                                    </p>
                                )}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                                {typeof s.estimate === "number" &&
                                s.estimate > 0 ? (
                                    <p className="type-headline tabular-nums text-gain">
                                        {fmt(s.estimate)}
                                    </p>
                                ) : (
                                    <p className="type-footnote text-label-secondary">
                                        {t("tax.suggestions.estimateNote")}
                                    </p>
                                )}
                                <TaxProfileDialog
                                    trigger={
                                        <Button size="sm" variant="outline">
                                            {t("tax.suggestions.cta")}
                                        </Button>
                                    }
                                    initialStep={"exemptions"}
                                />
                            </div>
                        </li>
                    ))}
                </ul>

                <div className="mt-3 space-y-1 border-t border-border/60 pt-4">
                    <p className="type-headline text-foreground">
                        {t("tax.suggestions.regionalTitle")}
                    </p>
                    <p className="type-footnote text-label-secondary">
                        {t("tax.suggestions.regionalDesc")}
                    </p>
                    <p className="type-footnote text-label-secondary">
                        {t("tax.suggestions.multipleResidencesNote")}
                    </p>
                    <div className="pt-1">
                        <PwcGuideLink />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

export default SuggestedDeductionsCard;
