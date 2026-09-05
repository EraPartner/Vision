import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useDeductionCandidates } from "@/hooks/useDeductionCandidates";
import {
    DEDUCTION_TYPE_PROFILE_FIELDS,
    type BelgianTaxProfile,
} from "@/lib/belgianTax";
import type { DeductionTypeGroup } from "@/lib/api/info";
import {
    dismissCandidate,
    isCandidateDismissed,
    loadDismissedCandidates,
} from "@/lib/deductionCandidatesDismiss";

/**
 * Transaction-derived complement to SuggestedDeductionsCard: lists deductible
 * spending detected in the viewed year's transactions, grouped by CIR-92
 * deduction type. Confirming a group writes its total into the matching
 * BelgianTaxProfile field (plus eligibility flag where one exists) so the tax
 * calculation picks it up; dismissing hides the group persistently for that
 * {year, deductionType} pair. Renders nothing while loading or when no
 * applicable groups remain.
 */
export function DeductionCandidatesCard() {
    const { profile, updateProfile } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        updateProfile: state.updateProfile,
    }));
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    const { data, isLoading } = useDeductionCandidates(profile.taxYear);

    const [dismissed, setDismissed] = useState(loadDismissedCandidates);
    // Session-local "Applied" marker so a confirmed group swaps its buttons for
    // a badge instead of vanishing (the profile write is the durable record).
    const [appliedTypes, setAppliedTypes] = useState<ReadonlySet<string>>(
        new Set(),
    );

    const year = data?.year ?? profile.taxYear;
    const groups = (data?.byDeductionType ?? []).filter(
        (group) =>
            DEDUCTION_TYPE_PROFILE_FIELDS[group.deductionType] !== undefined &&
            group.total > 0 &&
            !isCandidateDismissed(dismissed, year, group.deductionType),
    );

    // No empty card: loading, outage (fail-soft empty response), or everything
    // dismissed/inapplicable all render as nothing (RecurringDetectionPanel pattern).
    if (isLoading || groups.length === 0) return null;
    const currency = data?.currency;

    const handleConfirm = (group: DeductionTypeGroup) => {
        const mapping = DEDUCTION_TYPE_PROFILE_FIELDS[group.deductionType];
        if (!mapping) return;
        // SET semantics: the total replaces the field's current value (shown to
        // the user below), it is never added to it.
        const updates: Record<string, number | boolean> = {
            [mapping.amountField]: group.total,
        };
        if (mapping.eligibilityField) updates[mapping.eligibilityField] = true;
        updateProfile(updates as Partial<BelgianTaxProfile>);
        setAppliedTypes((prev) => new Set(prev).add(group.deductionType));
        toast.success(
            t("tax.deductionCandidates.toastConfirmed", {
                type: t(`tax.deductionCandidates.type.${group.deductionType}`),
            }),
        );
    };

    const handleDismiss = (deductionType: string) => {
        setDismissed(dismissCandidate(year, deductionType));
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle>{t("tax.deductionCandidates.title")}</CardTitle>
                <CardDescription>
                    {t("tax.deductionCandidates.description")}
                </CardDescription>
                <p className="text-xs text-muted-foreground">
                    {t("tax.deductionCandidates.disclaimer")}
                </p>
            </CardHeader>
            <CardContent className="space-y-3">
                {groups.map((group) => {
                    const mapping =
                        DEDUCTION_TYPE_PROFILE_FIELDS[group.deductionType];
                    if (!mapping) return null;
                    const currentValue = profile[mapping.amountField] ?? 0;
                    return (
                        <div
                            key={group.deductionType}
                            className="rounded-lg border bg-card p-3"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-foreground">
                                        {t(
                                            `tax.deductionCandidates.type.${group.deductionType}`,
                                        )}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {t(
                                            "tax.deductionCandidates.fromCategories",
                                            { count: group.categoryCount },
                                        )}
                                    </p>
                                    <ul className="mt-1 space-y-0.5">
                                        {group.categories.map((cat) => (
                                            <li
                                                key={cat.category}
                                                className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
                                            >
                                                <span className="truncate">
                                                    {cat.category}
                                                </span>
                                                <span className="shrink-0">
                                                    {fmt(cat.total, currency)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="text-xs text-muted-foreground mt-1.5">
                                        {t(
                                            "tax.deductionCandidates.currentValue",
                                            {
                                                value: fmt(
                                                    currentValue,
                                                    currency,
                                                ),
                                            },
                                        )}
                                    </p>
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-1.5 text-right">
                                    <span className="text-sm font-bold text-foreground">
                                        {fmt(group.total, currency)}
                                    </span>
                                    {appliedTypes.has(group.deductionType) ? (
                                        <Badge
                                            variant="outline"
                                            className="text-xs text-accent border-accent/30 bg-accent/10"
                                        >
                                            <CheckCircle2 className="h-3 w-3 mr-1" />
                                            {t(
                                                "tax.deductionCandidates.applied",
                                            )}
                                        </Badge>
                                    ) : (
                                        <div className="flex items-center gap-1">
                                            <Button
                                                size="sm"
                                                variant="default"
                                                className="h-7 text-xs"
                                                onClick={() =>
                                                    handleConfirm(group)
                                                }
                                            >
                                                {t(
                                                    "tax.deductionCandidates.confirm",
                                                )}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 text-xs text-muted-foreground"
                                                onClick={() =>
                                                    handleDismiss(
                                                        group.deductionType,
                                                    )
                                                }
                                            >
                                                {t(
                                                    "tax.deductionCandidates.dismiss",
                                                )}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}

export default DeductionCandidatesCard;
