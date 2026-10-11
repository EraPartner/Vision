/**
 * TaxProfileDialog
 *
 * A multi-step sheet for configuring the user's Belgian tax profile.
 * Steps:
 *   1. Household (assessment, partner, relationship events, claims)
 *   2. Income (activities per partner, expenses, other income)
 *   3. Home & property
 *   4. Taxable income sources
 *   5. Exemptions, dependents and reductions per partner
 *   6. Region & surcharge
 *
 * Household steps edit the v2 household (ADR-200) through `updateHousehold`; the others
 * still edit the v1 projection through `updateProfile`, which keeps household-only data.
 *
 * Opens from its own trigger, or, with `open`/`onOpenChange`, from a menu item
 * elsewhere on the page.
 */
// @refresh reset
import {
    useCallback,
    useReducer,
    useState,
    type ElementType,
    type ReactNode,
} from "react";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Settings,
    ChevronRight,
    ChevronLeft,
    Check,
    Briefcase,
    Building2,
    Receipt,
    MapPin,
    Users,
    ListChecks,
    History,
    Lock,
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import type { BelgianTaxProfile } from "@/lib/belgianTax";
import type { PartnerId } from "@/lib/belgianTax/householdTypes";
import type { HouseholdUpdate } from "@/stores/belgianTaxStore";
import { householdIncomeStepSchema } from "./taxProfileSchema";
import {
    HouseholdStep,
    IncomeStep,
    HomeStep,
    IncomeSourcesStep,
    ExemptionsStep,
    RegionStep,
} from "./profile-steps";
import { resolvePartnerId } from "./profile-steps/householdEditing";

// eslint-disable-next-line react-refresh/only-export-components
export const STEPS = [
    "household",
    "income",
    "home",
    "incomeSources",
    "exemptions",
    "region",
] as const;
export type Step = (typeof STEPS)[number];

const STEP_ICONS: Record<Step, ElementType> = {
    household: Users,
    income: Briefcase,
    home: Building2,
    incomeSources: ListChecks,
    exemptions: Receipt,
    region: MapPin,
};

interface TaxProfileDialogProps {
    /** Custom trigger; `null` renders none (drive the sheet through `open`). */
    trigger?: ReactNode | null;
    /** Optional initial step to open the dialog on (useful for CTAs linking directly to a step) */
    initialStep?: Step;
    /**
     * Income year this dialog should edit. Defaults to the live profile's `taxYear`.
     * When supplied and a snapshot exists for that year, the dialog reads/writes the
     * snapshot (historical-edit mode) and renders a warning banner.
     */
    targetYear?: number;
    /** Controlled open state; leave undefined to let the trigger own it. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function TaxProfileDialog({
    trigger,
    initialStep,
    targetYear,
    open: controlledOpen,
    onOpenChange,
}: TaxProfileDialogProps) {
    const {
        profile: liveProfile,
        updateProfile: updateLiveProfile,
        snapshots,
        updateSnapshot,
        liveHousehold,
        householdSnapshots,
        updateLiveHousehold,
        updateHouseholdSnapshot,
        snapshotMetas,
        unmarkYearAsFiled,
    } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        updateProfile: state.updateProfile,
        snapshots: state.snapshots,
        updateSnapshot: state.updateSnapshot,
        liveHousehold: state.household,
        householdSnapshots: state.householdSnapshots,
        updateLiveHousehold: state.updateHousehold,
        updateHouseholdSnapshot: state.updateHouseholdSnapshot,
        snapshotMetas: state.snapshotMetas,
        unmarkYearAsFiled: state.unmarkYearAsFiled,
    }));
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const [step, setStep] = useState<Step>("household");
    const [selectedPartner, setSelectedPartner] = useState<PartnerId>("A");
    const [portalContainer, setPortalContainer] =
        useState<HTMLDivElement | null>(null);
    const [filedOverride, setFiledOverride] = useState(false);
    // Remount key for the step picker: when a forward jump is refused and the
    // user stays on the same step, the control's pill must snap back.
    const [pickerKey, resetPicker] = useReducer((n: number) => n + 1, 0);
    const { t } = useLanguage();

    const liveYear = liveProfile.taxYear;
    const effectiveTargetYear = targetYear ?? liveYear;
    const historicalSnapshot =
        effectiveTargetYear !== liveYear
            ? snapshots[effectiveTargetYear]
            : undefined;
    const editingHistorical = !!historicalSnapshot;
    const isFiled =
        editingHistorical &&
        Boolean(snapshotMetas[effectiveTargetYear]?.filing);
    const isLockedByFiling = isFiled && !filedOverride;
    const profile: BelgianTaxProfile = historicalSnapshot ?? liveProfile;
    const household = editingHistorical
        ? (householdSnapshots[effectiveTargetYear] ?? null)
        : liveHousehold;
    const partnerId = household
        ? resolvePartnerId(household, selectedPartner)
        : "A";

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

    const updateHousehold = useCallback(
        (update: HouseholdUpdate) => {
            if (isLockedByFiling) return;
            if (editingHistorical) {
                updateHouseholdSnapshot(effectiveTargetYear, update);
                return;
            }
            updateLiveHousehold(update);
        },
        [
            isLockedByFiling,
            editingHistorical,
            effectiveTargetYear,
            updateHouseholdSnapshot,
            updateLiveHousehold,
        ],
    );

    const stepIdx = STEPS.indexOf(step);
    const isFirst = stepIdx === 0;
    const isLast = stepIdx === STEPS.length - 1;

    // Per-step required-field validation. Returns a user-facing error message when
    // the step's required fields are missing/invalid, or null when the step is OK.
    // The rules live in householdIncomeStepSchema (Zod) — only the income step
    // has hard requirements; the schema's issue messages are i18n keys,
    // translated here so the toast copy is unchanged.
    const stepError = useCallback(
        (s: Step): string | null => {
            if (s === "income" && household) {
                const result = householdIncomeStepSchema.safeParse(household);
                const issue = result.success
                    ? undefined
                    : result.error.issues[0];
                if (issue) return t(issue.message);
            }
            return null;
        },
        [household, t],
    );

    // The earliest invalid step strictly before `targetIdx` with its error, or
    // undefined if all are valid. Used to block forward navigation past an
    // incomplete step.
    const firstInvalidStepBefore = useCallback(
        (targetIdx: number): { step: Step; error: string } | undefined => {
            for (const s of STEPS.slice(0, targetIdx)) {
                const error = stepError(s);
                if (error) return { step: s, error };
            }
            return undefined;
        },
        [stepError],
    );

    function setOpen(o: boolean) {
        if (!isControlled) setUncontrolledOpen(o);
        onOpenChange?.(o);
    }

    function next() {
        // Block leaving the current step until its required fields are valid.
        const err = stepError(step);
        if (err) {
            toast.error(err);
            return;
        }
        const nextStep = isLast ? undefined : STEPS[stepIdx + 1];
        if (nextStep !== undefined) {
            setStep(nextStep);
            return;
        }
        // Final step → save. Guard against reaching here (e.g. via initialStep or
        // tab jumps) with an earlier step still incomplete.
        const bad = firstInvalidStepBefore(STEPS.length - 1);
        if (bad) {
            toast.error(bad.error);
            setStep(bad.step);
            return;
        }
        // For historical edits, the snapshot is already "configured" by definition —
        // setting `profileConfigured` again is a no-op patch, which is fine.
        updateProfile({ profileConfigured: true });
        setOpen(false);
    }
    function prev() {
        const prevStep = isFirst ? undefined : STEPS[stepIdx - 1];
        if (prevStep !== undefined) setStep(prevStep);
    }

    // Step picker: going back to an earlier/current step is always free; jumping
    // forward is only allowed once every step in between has its required fields.
    function goToStep(target: Step) {
        const targetIdx = STEPS.indexOf(target);
        if (targetIdx <= stepIdx) {
            setStep(target);
            return;
        }
        const bad = firstInvalidStepBefore(targetIdx);
        if (bad) {
            toast.error(bad.error);
            if (bad.step === step) resetPicker();
            setStep(bad.step);
            return;
        }
        setStep(target);
    }

    function handleOpenChange(o: boolean) {
        setOpen(o);
        if (o) {
            setStep(initialStep ?? "household");
            setSelectedPartner("A");
            setFiledOverride(false);
        }
    }

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            {trigger !== null && (
                <SheetTrigger asChild>
                    {trigger ?? (
                        <Button variant="outline">
                            <Settings aria-hidden="true" />
                            {t("tax.profile.trigger")}
                        </Button>
                    )}
                </SheetTrigger>
            )}
            <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
            >
                <SheetHeader className="px-6 pt-6">
                    <SheetTitle>{t("tax.profile.title")}</SheetTitle>
                    <SheetDescription>
                        {t("tax.profile.description")}
                    </SheetDescription>
                </SheetHeader>

                <div className="space-y-2 px-6 pt-4">
                    <SegmentedControl
                        key={pickerKey}
                        value={step}
                        onValueChange={(value) => goToStep(value as Step)}
                        aria-label={t("tax.profile.title")}
                        className="w-full"
                    >
                        {STEPS.map((s, i) => {
                            const Icon = i < stepIdx ? Check : STEP_ICONS[s];
                            return (
                                <SegmentedControlItem
                                    key={s}
                                    value={s}
                                    aria-label={t(`tax.profile.step.${s}`)}
                                    className="px-2"
                                >
                                    <Icon
                                        className="h-4 w-4 shrink-0"
                                        aria-hidden="true"
                                    />
                                    <span className="hidden sm:inline">
                                        {t(`tax.profile.step.${s}`)}
                                    </span>
                                </SegmentedControlItem>
                            );
                        })}
                    </SegmentedControl>
                    <p className="type-footnote text-label-secondary">
                        {t("tax.profile.stepProgress", {
                            current: stepIdx + 1,
                            total: STEPS.length,
                        })}
                    </p>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
                    {editingHistorical && !isFiled && (
                        <Alert variant="warning">
                            <History className="h-4 w-4" aria-hidden="true" />
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
                        <Alert variant="warning">
                            <Lock className="h-4 w-4" aria-hidden="true" />
                            <AlertTitle>
                                {t("tax.historical.filedLock.title")}
                            </AlertTitle>
                            <AlertDescription className="flex flex-col gap-3">
                                <span className="text-label-secondary">
                                    {t("tax.historical.filedLock.desc", {
                                        year: String(effectiveTargetYear),
                                    })}
                                </span>
                                <div className="flex flex-wrap items-center gap-2">
                                    {!filedOverride ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                setFiledOverride(true)
                                            }
                                        >
                                            {t(
                                                "tax.historical.filedLock.amendCta",
                                            )}
                                        </Button>
                                    ) : (
                                        <span className="type-footnote font-medium text-warning">
                                            {t(
                                                "tax.historical.filedLock.amendActive",
                                            )}
                                        </span>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                            unmarkYearAsFiled(
                                                effectiveTargetYear,
                                            )
                                        }
                                    >
                                        {t(
                                            "tax.historical.filedLock.unfileCta",
                                            {
                                                year: String(
                                                    effectiveTargetYear,
                                                ),
                                            },
                                        )}
                                    </Button>
                                </div>
                            </AlertDescription>
                        </Alert>
                    )}

                    {!household &&
                        (step === "household" ||
                            step === "income" ||
                            step === "home" ||
                            step === "exemptions") && (
                            <div className="space-y-3" aria-busy="true">
                                <Skeleton className="h-6 w-1/2" />
                                <Skeleton className="h-24 w-full" />
                            </div>
                        )}
                    {step === "household" && household && (
                        <HouseholdStep
                            household={household}
                            updateHousehold={updateHousehold}
                            portalContainer={portalContainer}
                        />
                    )}
                    {step === "income" && household && (
                        <IncomeStep
                            household={household}
                            updateHousehold={updateHousehold}
                            partnerId={partnerId}
                            onPartnerChange={setSelectedPartner}
                            portalContainer={portalContainer}
                        />
                    )}
                    {step === "home" && household && (
                        <HomeStep
                            profile={profile}
                            updateProfile={updateProfile}
                            household={household}
                            updateHousehold={updateHousehold}
                        />
                    )}
                    {step === "incomeSources" && (
                        <IncomeSourcesStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                    {step === "exemptions" && household && (
                        <ExemptionsStep
                            profile={profile}
                            updateProfile={updateProfile}
                            household={household}
                            updateHousehold={updateHousehold}
                            partnerId={partnerId}
                            onPartnerChange={setSelectedPartner}
                        />
                    )}
                    {step === "region" && (
                        <RegionStep
                            profile={profile}
                            updateProfile={updateProfile}
                        />
                    )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border/50 px-6 py-4">
                    <Button variant="ghost" onClick={prev} disabled={isFirst}>
                        <ChevronLeft aria-hidden="true" />
                        {t("common.back")}
                    </Button>
                    <Button onClick={next}>
                        {isLast ? (
                            t("tax.profile.save")
                        ) : (
                            <>
                                {t("common.next")}
                                <ChevronRight aria-hidden="true" />
                            </>
                        )}
                    </Button>
                </div>
                <div ref={setPortalContainer} />
            </SheetContent>
        </Sheet>
    );
}
