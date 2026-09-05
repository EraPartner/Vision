/**
 * TaxProfileDialog
 *
 * A multi-step sheet/dialog for configuring the user's Belgian tax profile.
 * Steps:
 *   1. Employment type
 *   2. Income details
 *   3. Exemptions & dependents
 *   4. Region & surcharge
 */
// @refresh reset
import { useCallback, useState, type ElementType, type ReactNode } from "react";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    Settings,
    ChevronRight,
    ChevronLeft,
    Check,
    User,
    Landmark,
    MapPin,
    Users,
    ListChecks,
    History,
    Lock,
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import type { BelgianTaxProfile } from "@/lib/belgianTax";
import { taxProfileIncomeStepSchema } from "./taxProfileSchema";
import {
    EmploymentStep,
    IncomeStep,
    IncomeSourcesStep,
    ExemptionsStep,
    RegionStep,
} from "./profile-steps";

// eslint-disable-next-line react-refresh/only-export-components
export const STEPS = [
    "employment",
    "income",
    "incomeSources",
    "exemptions",
    "region",
] as const;
export type Step = (typeof STEPS)[number];

const STEP_ICONS: Record<Step, ElementType> = {
    employment: User,
    income: Landmark,
    incomeSources: ListChecks,
    exemptions: Users,
    region: MapPin,
};

interface TaxProfileDialogProps {
    trigger?: ReactNode;
    /** Optional initial step to open the dialog on (useful for CTAs linking directly to a step) */
    initialStep?: Step;
    /**
     * Income year this dialog should edit. Defaults to the live profile's `taxYear`.
     * When supplied and a snapshot exists for that year, the dialog reads/writes the
     * snapshot (historical-edit mode) and renders a warning banner.
     */
    targetYear?: number;
}

export function TaxProfileDialog({
    trigger,
    initialStep,
    targetYear,
}: TaxProfileDialogProps) {
    const {
        profile: liveProfile,
        updateProfile: updateLiveProfile,
        snapshots,
        updateSnapshot,
        snapshotMetas,
        unmarkYearAsFiled,
    } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        updateProfile: state.updateProfile,
        snapshots: state.snapshots,
        updateSnapshot: state.updateSnapshot,
        snapshotMetas: state.snapshotMetas,
        unmarkYearAsFiled: state.unmarkYearAsFiled,
    }));
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<Step>("employment");
    const [filedOverride, setFiledOverride] = useState(false);
    const { t } = useLanguage();

    const liveYear = liveProfile.taxYear;
    const effectiveTargetYear = targetYear ?? liveYear;
    const editingHistorical =
        effectiveTargetYear !== liveYear && !!snapshots[effectiveTargetYear];
    const isFiled =
        editingHistorical &&
        Boolean(snapshotMetas[effectiveTargetYear]?.filing);
    const isLockedByFiling = isFiled && !filedOverride;
    const profile: BelgianTaxProfile = editingHistorical
        ? snapshots[effectiveTargetYear]
        : liveProfile;

    const updateProfile = useCallback(
        (updates: Partial<BelgianTaxProfile>) => {
            if (isLockedByFiling) return;
            if (editingHistorical) {
                // Strip `taxYear` from patches so the snapshot key/year remains pinned.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { taxYear, ...rest } = updates;
                updateSnapshot(effectiveTargetYear, rest);
                return;
            }
            updateLiveProfile(updates);
        },
        [
            isLockedByFiling,
            editingHistorical,
            effectiveTargetYear,
            updateSnapshot,
            updateLiveProfile,
        ],
    );

    const stepIdx = STEPS.indexOf(step);
    const isFirst = stepIdx === 0;
    const isLast = stepIdx === STEPS.length - 1;

    // Per-step required-field validation. Returns a user-facing error message when
    // the step's required fields are missing/invalid, or null when the step is OK.
    // The rules live in taxProfileIncomeStepSchema (Zod) — only the income step
    // has hard requirements; the schema's issue messages are i18n keys,
    // translated here so the toast copy is unchanged.
    const stepError = useCallback(
        (s: Step): string | null => {
            if (s === "income") {
                const result = taxProfileIncomeStepSchema.safeParse(profile);
                if (!result.success) return t(result.error.issues[0].message);
            }
            return null;
        },
        [profile, t],
    );

    // Index of the earliest invalid step strictly before `targetIdx`, or -1 if all
    // are valid. Used to block forward navigation past an incomplete step.
    const firstInvalidStepBefore = useCallback(
        (targetIdx: number): number => {
            for (let i = 0; i < targetIdx; i++) {
                if (stepError(STEPS[i])) return i;
            }
            return -1;
        },
        [stepError],
    );

    function next() {
        // Block leaving the current step until its required fields are valid.
        const err = stepError(step);
        if (err) {
            toast.error(err);
            return;
        }
        if (!isLast) {
            setStep(STEPS[stepIdx + 1]);
            return;
        }
        // Final step → save. Guard against reaching here (e.g. via initialStep or
        // tab jumps) with an earlier step still incomplete.
        const bad = firstInvalidStepBefore(STEPS.length - 1);
        if (bad !== -1) {
            toast.error(stepError(STEPS[bad])!);
            setStep(STEPS[bad]);
            return;
        }
        // For historical edits, the snapshot is already "configured" by definition —
        // setting `profileConfigured` again is a no-op patch, which is fine.
        updateProfile({ profileConfigured: true });
        setOpen(false);
    }
    function prev() {
        if (!isFirst) setStep(STEPS[stepIdx - 1]);
    }

    // Tab navigation: going back to an earlier/current step is always free; jumping
    // forward is only allowed once every step in between has its required fields.
    function goToStep(target: Step) {
        const targetIdx = STEPS.indexOf(target);
        if (targetIdx <= stepIdx) {
            setStep(target);
            return;
        }
        const bad = firstInvalidStepBefore(targetIdx);
        if (bad !== -1) {
            toast.error(stepError(STEPS[bad])!);
            setStep(STEPS[bad]);
            return;
        }
        setStep(target);
    }

    function handleOpenChange(o: boolean) {
        setOpen(o);
        if (o) {
            setStep(initialStep ?? "employment");
            setFiledOverride(false);
        }
    }

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetTrigger asChild>
                {trigger ?? (
                    <Button variant="outline" size="sm" className="gap-2">
                        <Settings className="h-4 w-4" />
                        {t("tax.profile.trigger")}
                    </Button>
                )}
            </SheetTrigger>
            <SheetContent
                side="right"
                className="w-full sm:max-w-lg overflow-y-auto"
            >
                <SheetHeader>
                    <SheetTitle>{t("tax.profile.title")}</SheetTitle>
                    <SheetDescription>
                        {t("tax.profile.description")}
                    </SheetDescription>
                </SheetHeader>

                {/* Step progress */}
                <div className="flex items-center gap-1 mt-6 mb-8">
                    {STEPS.map((s, i) => {
                        const Icon = STEP_ICONS[s];
                        const done = i < stepIdx;
                        const active = i === stepIdx;
                        return (
                            <div key={s} className="flex items-center flex-1">
                                <button
                                    onClick={() => goToStep(s)}
                                    className={cn(
                                        "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors",
                                        active &&
                                            "bg-primary text-primary-foreground",
                                        done && "text-accent",
                                        !active &&
                                            !done &&
                                            "text-muted-foreground hover:text-foreground",
                                    )}
                                >
                                    {done ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Icon className="h-3.5 w-3.5" />
                                    )}
                                    <span className="hidden sm:inline">
                                        {t(`tax.profile.step.${s}`)}
                                    </span>
                                </button>
                                {i < STEPS.length - 1 && (
                                    <div
                                        className={cn(
                                            "flex-1 h-px mx-1",
                                            i < stepIdx
                                                ? "bg-accent"
                                                : "bg-border",
                                        )}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>

                {editingHistorical && !isFiled && (
                    <Alert className="mb-4 border-warning/40 bg-warning/5">
                        <History className="h-4 w-4 text-warning" />
                        <AlertTitle>
                            {t("tax.historical.editWarning.title")}
                        </AlertTitle>
                        <AlertDescription>
                            {t("tax.historical.editWarning.desc", {
                                year: String(effectiveTargetYear),
                            })}
                        </AlertDescription>
                    </Alert>
                )}

                {isFiled && (
                    <Alert className="mb-4 border-warning/60 bg-warning/10">
                        <Lock className="h-4 w-4 text-warning" />
                        <AlertTitle>
                            {t("tax.historical.filedLock.title")}
                        </AlertTitle>
                        <AlertDescription className="flex flex-col gap-3">
                            <span className="text-xs text-muted-foreground">
                                {t("tax.historical.filedLock.desc", {
                                    year: String(effectiveTargetYear),
                                })}
                            </span>
                            <div className="flex flex-wrap gap-2">
                                {!filedOverride ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setFiledOverride(true)}
                                        className="gap-1"
                                    >
                                        <Lock className="h-3 w-3" />
                                        {t("tax.historical.filedLock.amendCta")}
                                    </Button>
                                ) : (
                                    <span className="text-xs font-medium text-warning">
                                        {t(
                                            "tax.historical.filedLock.amendActive",
                                        )}
                                    </span>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        unmarkYearAsFiled(effectiveTargetYear)
                                    }
                                >
                                    {t("tax.historical.filedLock.unfileCta", {
                                        year: String(effectiveTargetYear),
                                    })}
                                </Button>
                            </div>
                        </AlertDescription>
                    </Alert>
                )}

                {/* Step content */}
                <div className="space-y-5 min-h-[340px]">
                    {step === "employment" && (
                        <EmploymentStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                    {step === "income" && (
                        <IncomeStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                    {step === "incomeSources" && (
                        <IncomeSourcesStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                    {step === "exemptions" && (
                        <ExemptionsStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                    {step === "region" && (
                        <RegionStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                </div>

                <Separator className="my-6" />

                {/* Navigation */}
                <div className="flex items-center justify-between">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={prev}
                        disabled={isFirst}
                        className="gap-1"
                    >
                        <ChevronLeft className="h-4 w-4" />
                        {t("common.back")}
                    </Button>
                    <Button size="sm" onClick={next} className="gap-1">
                        {isLast ? (
                            <>
                                <Check className="h-4 w-4" />
                                {t("common.save")}
                            </>
                        ) : (
                            <>
                                {t("common.next")}
                                <ChevronRight className="h-4 w-4" />
                            </>
                        )}
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
}
