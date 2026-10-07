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
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { todayYmd } from "@/lib/timezone";

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
    const { data, isLoading, isError, isFetching, refetch } =
        useDeductionCandidates(profile.taxYear);
    const { confirm, ConfirmDialog } = useConfirmDialog();

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

    if (isError) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t("tax.deductionCandidates.title")}</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-4">
                    <p role="alert" className="type-body text-label-secondary">
                        {t("tax.deductionCandidates.unavailable")}
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={isFetching}
                        onClick={() => void refetch()}
                    >
                        {t("common.retry")}
                    </Button>
                </CardContent>
            </Card>
        );
    }

    // A successful empty result or entirely dismissed/inapplicable groups need no card.
    if (isLoading || groups.length === 0) return null;
    const currency = data?.currency;

    const applyCandidate = (group: DeductionTypeGroup) => {
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

    const handleConfirm = async (group: DeductionTypeGroup) => {
        const mapping = DEDUCTION_TYPE_PROFILE_FIELDS[group.deductionType];
        if (!mapping) return;
        const currentYear = Number(todayYmd().slice(0, 4));
        if (year === currentYear) {
            const acknowledged = await confirm({
                title: t("tax.deductionCandidates.incompleteYearTitle", {
                    year,
                }),
                description: t(
                    "tax.deductionCandidates.incompleteYearDescription",
                    {
                        currentValue: fmt(profile[mapping.amountField] ?? 0, {
                            currency,
                        }),
                        candidateValue: fmt(group.total, { currency }),
                    },
                ),
                confirmLabel: t(
                    "tax.deductionCandidates.incompleteYearConfirm",
                ),
            });
            if (!acknowledged) return;
        }
        applyCandidate(group);
    };

    const handleDismiss = (deductionType: string) => {
        setDismissed(dismissCandidate(year, deductionType));
    };

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>{t("tax.deductionCandidates.title")}</CardTitle>
                    <CardDescription>
                        {t("tax.deductionCandidates.description")}
                    </CardDescription>
                    <p className="type-footnote text-label-secondary">
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
                            <section
                                key={group.deductionType}
                                className="rounded-card corner-continuous bg-foreground/[0.04] p-4"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <h3 className="type-headline text-foreground">
                                            {t(
                                                `tax.deductionCandidates.type.${group.deductionType}`,
                                            )}
                                        </h3>
                                        <p className="mt-0.5 type-footnote text-label-secondary">
                                            {t(
                                                "tax.deductionCandidates.fromCategories",
                                                { count: group.categoryCount },
                                            )}
                                        </p>
                                        <ul className="mt-1.5 space-y-0.5">
                                            {group.categories.map((cat) => (
                                                <li
                                                    key={cat.category}
                                                    className="flex items-baseline justify-between gap-2 type-footnote text-label-secondary"
                                                >
                                                    <span className="truncate">
                                                        {cat.category}
                                                    </span>
                                                    <span className="shrink-0 tabular-nums">
                                                        {fmt(cat.total, {
                                                            currency,
                                                        })}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                        <p className="mt-1.5 type-footnote text-label-secondary">
                                            {t(
                                                "tax.deductionCandidates.currentValue",
                                                {
                                                    value: fmt(currentValue, {
                                                        currency,
                                                    }),
                                                },
                                            )}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                                        <span className="type-headline tabular-nums text-foreground">
                                            {fmt(group.total, { currency })}
                                        </span>
                                        {appliedTypes.has(
                                            group.deductionType,
                                        ) ? (
                                            <Badge variant="success" size="sm">
                                                <CheckCircle2
                                                    className="mr-1 h-3 w-3"
                                                    aria-hidden="true"
                                                />
                                                {t(
                                                    "tax.deductionCandidates.applied",
                                                )}
                                            </Badge>
                                        ) : (
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    size="sm"
                                                    onClick={() =>
                                                        void handleConfirm(
                                                            group,
                                                        )
                                                    }
                                                >
                                                    {t(
                                                        "tax.deductionCandidates.confirm",
                                                    )}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
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
                            </section>
                        );
                    })}
                </CardContent>
            </Card>
            <ConfirmDialog />
        </>
    );
}

export default DeductionCandidatesCard;
