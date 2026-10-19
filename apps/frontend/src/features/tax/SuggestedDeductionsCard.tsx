import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionLoader } from "@/components/shared/SectionLoader";
import type { BelgianTaxDashboardSuggestion } from "@/lib/api/belgianTax";
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

interface SuggestedDeductionsCardProps {
    /** Server-built suggestions for the live profile (tax dashboard); undefined while loading. */
    suggestions: BelgianTaxDashboardSuggestion[] | undefined;
}

function SuggestedDeductionsCard({
    suggestions: serverSuggestions,
}: SuggestedDeductionsCardProps) {
    const { t } = useLanguage();

    // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
    const fmt = useCurrencyFormatter();

    const suggestions = useMemo(
        () =>
            serverSuggestions?.map((item) => ({
                id: item.id,
                title: t(item.titleKey),
                desc: t(item.descriptionKey, item.descriptionParams),
                estimate: item.estimate,
                note: item.noteKey ? t(item.noteKey) : undefined,
            })),
        [serverSuggestions, t],
    );

    if (!suggestions) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t("tax.suggestions.title")}</CardTitle>
                </CardHeader>
                <CardContent>
                    <SectionLoader />
                </CardContent>
            </Card>
        );
    }

    if (suggestions.length === 0) {
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
