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
import { useCallback, useState, type ElementType, type ReactNode } from 'react';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Settings, ChevronRight, ChevronLeft, Check, User, Landmark, MapPin, Users, ListChecks, History, Lock } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { useBelgianTaxProfile, type BelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import {
    EmploymentStep,
    IncomeStep,
    IncomeSourcesStep,
    ExemptionsStep,
    RegionStep,
} from './profile-steps';

// eslint-disable-next-line react-refresh/only-export-components
export const STEPS = ['employment', 'income', 'incomeSources', 'exemptions', 'region'] as const;
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

export function TaxProfileDialog({ trigger, initialStep, targetYear }: TaxProfileDialogProps) {
    const {
        profile: liveProfile,
        updateProfile: updateLiveProfile,
        snapshots,
        updateSnapshot,
        isYearFiled,
        unmarkYearAsFiled,
    } = useBelgianTaxProfile();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<Step>('employment');
    const [filedOverride, setFiledOverride] = useState(false);
    const { t } = useLanguage();

    const liveYear = liveProfile.taxYear;
    const effectiveTargetYear = targetYear ?? liveYear;
    const editingHistorical = effectiveTargetYear !== liveYear && !!snapshots[effectiveTargetYear];
    const isFiled = editingHistorical && isYearFiled(effectiveTargetYear);
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
        [isLockedByFiling, editingHistorical, effectiveTargetYear, updateSnapshot, updateLiveProfile],
    );

    const stepIdx = STEPS.indexOf(step);
    const isFirst = stepIdx === 0;
    const isLast = stepIdx === STEPS.length - 1;

    function next() {
        if (!isLast) setStep(STEPS[stepIdx + 1]);
        else {
            // For historical edits, the snapshot is already "configured" by definition —
            // setting `profileConfigured` again is a no-op patch, which is fine.
            updateProfile({ profileConfigured: true });
            setOpen(false);
        }
    }
    function prev() {
        if (!isFirst) setStep(STEPS[stepIdx - 1]);
    }

    function handleOpenChange(o: boolean) {
        setOpen(o);
        if (o) {
            setStep(initialStep ?? 'employment');
            setFiledOverride(false);
        }
    }

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetTrigger asChild>
                {trigger ?? (
                    <Button variant="outline" size="sm" className="gap-2">
                        <Settings className="h-4 w-4" />
                        {t('tax.profile.trigger')}
                    </Button>
                )}
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
                <SheetHeader>
                    <SheetTitle>{t('tax.profile.title')}</SheetTitle>
                    <SheetDescription>{t('tax.profile.description')}</SheetDescription>
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
                                    onClick={() => setStep(s)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors',
                                        active && 'bg-primary text-primary-foreground',
                                        done && 'text-accent',
                                        !active && !done && 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {done ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Icon className="h-3.5 w-3.5" />
                                    )}
                                    <span className="hidden sm:inline">{t(`tax.profile.step.${s}`)}</span>
                                </button>
                                {i < STEPS.length - 1 && (
                                    <div className={cn('flex-1 h-px mx-1', i < stepIdx ? 'bg-accent' : 'bg-border')} />
                                )}
                            </div>
                        );
                    })}
                </div>

                {editingHistorical && !isFiled && (
                    <Alert className="mb-4 border-amber-500/40 bg-amber-500/5">
                        <History className="h-4 w-4 text-amber-600" />
                        <AlertTitle>{t('tax.historical.editWarning.title')}</AlertTitle>
                        <AlertDescription>
                            {t('tax.historical.editWarning.desc', { year: String(effectiveTargetYear) })}
                        </AlertDescription>
                    </Alert>
                )}

                {isFiled && (
                    <Alert className="mb-4 border-amber-500/60 bg-amber-500/10">
                        <Lock className="h-4 w-4 text-amber-700" />
                        <AlertTitle>{t('tax.historical.filedLock.title')}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-3">
                            <span className="text-xs text-muted-foreground">
                                {t('tax.historical.filedLock.desc', { year: String(effectiveTargetYear) })}
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
                                        {t('tax.historical.filedLock.amendCta')}
                                    </Button>
                                ) : (
                                    <span className="text-xs font-medium text-amber-700">
                                        {t('tax.historical.filedLock.amendActive')}
                                    </span>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => unmarkYearAsFiled(effectiveTargetYear)}
                                >
                                    {t('tax.historical.filedLock.unfileCta')}
                                </Button>
                            </div>
                        </AlertDescription>
                    </Alert>
                )}

                {/* Step content */}
                <div className="space-y-5 min-h-[340px]">
                    {step === 'employment' && (
                        <EmploymentStep profile={profile} updateProfile={updateProfile} />
                    )}
                    {step === 'income' && (
                        <IncomeStep profile={profile} updateProfile={updateProfile} />
                    )}
                    {step === 'incomeSources' && (
                        <IncomeSourcesStep profile={profile} updateProfile={updateProfile} />
                    )}
                    {step === 'exemptions' && (
                        <ExemptionsStep profile={profile} updateProfile={updateProfile} />
                    )}
                    {step === 'region' && (
                        <RegionStep profile={profile} updateProfile={updateProfile} />
                    )}
                </div>

                <Separator className="my-6" />

                {/* Navigation */}
                <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={prev} disabled={isFirst} className="gap-1">
                        <ChevronLeft className="h-4 w-4" />
                        {t('common.back')}
                    </Button>
                    <Button size="sm" onClick={next} className="gap-1">
                        {isLast ? (
                            <>
                                <Check className="h-4 w-4" />
                                {t('common.save')}
                            </>
                        ) : (
                            <>
                                {t('common.next')}
                                <ChevronRight className="h-4 w-4" />
                            </>
                        )}
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
}
