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
import { useState, type ElementType, type ReactNode } from 'react';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Settings, ChevronRight, ChevronLeft, Check, User, Landmark, MapPin, Users } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import {
    useBelgianTaxProfile,
    DEFAULT_COMMUNAL_SURCHARGE,
    type EmploymentType,
    type BelgianRegion,
    type ProfessionalExpenseMethod,
} from '@/contexts/BelgianTaxProfileContext';

const STEPS = ['employment', 'income', 'exemptions', 'region'] as const;
type Step = (typeof STEPS)[number];

const STEP_LABELS: Record<Step, string> = {
    employment: 'Employment',
    income: 'Income',
    exemptions: 'Deductions',
    region: 'Region',
};

const STEP_ICONS: Record<Step, ElementType> = {
    employment: User,
    income: Landmark,
    exemptions: Users,
    region: MapPin,
};

interface TaxProfileDialogProps {
    trigger?: ReactNode;
}

export function TaxProfileDialog({ trigger }: TaxProfileDialogProps) {
    const { profile, updateProfile } = useBelgianTaxProfile();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<Step>('employment');
    const { t } = useLanguage();

    const stepIdx = STEPS.indexOf(step);
    const isFirst = stepIdx === 0;
    const isLast = stepIdx === STEPS.length - 1;

    function next() {
        if (!isLast) setStep(STEPS[stepIdx + 1]);
        else {
            updateProfile({ profileConfigured: true });
            setOpen(false);
        }
    }
    function prev() {
        if (!isFirst) setStep(STEPS[stepIdx - 1]);
    }

    function handleOpenChange(o: boolean) {
        setOpen(o);
        if (o) setStep('employment');
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

                {/* Step content */}
                <div className="space-y-5 min-h-[340px]">
                    {step === 'employment' && (
                        <EmploymentStep profile={profile} updateProfile={updateProfile} />
                    )}
                    {step === 'income' && (
                        <IncomeStep profile={profile} updateProfile={updateProfile} />
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

// ──────────────────────────────────────────────────────────────────────────────
// Step components
// ──────────────────────────────────────────────────────────────────────────────

function EmploymentStep({
    profile,
    updateProfile,
}: {
    profile: ReturnType<typeof useBelgianTaxProfile>['profile'];
    updateProfile: (updates: Partial<ReturnType<typeof useBelgianTaxProfile>['profile']>) => void;
}) {
    const { t } = useLanguage();
    const types: { value: EmploymentType; label: string; desc: string }[] = [
        { value: 'employee', label: t('tax.profile.employment.employee.label'), desc: t('tax.profile.employment.employee.desc') },
        { value: 'civil_servant', label: t('tax.profile.employment.civil_servant.label'), desc: t('tax.profile.employment.civil_servant.desc') },
        { value: 'self_employed', label: t('tax.profile.employment.self_employed.label'), desc: t('tax.profile.employment.self_employed.desc') },
        { value: 'retired', label: t('tax.profile.employment.retired.label'), desc: t('tax.profile.employment.retired.desc') },
        { value: 'other', label: t('tax.profile.employment.other.label'), desc: t('tax.profile.employment.other.desc') },
    ];
    return (
        <div className="space-y-4">
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.employment.title')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('tax.profile.section.employment.desc')}</p>
            </div>
            <RadioGroup
                value={profile.employmentType}
                onValueChange={(v) => updateProfile({ employmentType: v as EmploymentType })}
                className="space-y-2"
            >
                {types.map(({ value, label, desc }) => (
                    <div key={value} className={cn(
                        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        profile.employmentType === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                    )}>
                        <RadioGroupItem value={value} id={`emp-${value}`} className="mt-0.5" />
                        <Label htmlFor={`emp-${value}`} className="cursor-pointer flex-1">
                            <span className="font-medium text-sm block">{label}</span>
                            <span className="text-xs text-muted-foreground">{desc}</span>
                        </Label>
                    </div>
                ))}
            </RadioGroup>
        </div>
    );
}

function IncomeStep({
    profile,
    updateProfile,
}: {
    profile: ReturnType<typeof useBelgianTaxProfile>['profile'];
    updateProfile: (updates: Partial<ReturnType<typeof useBelgianTaxProfile>['profile']>) => void;
}) {
    const { t } = useLanguage();
    return (
        <div className="space-y-5">
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.income.title')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('tax.profile.section.income.desc')}</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="gross-income" className="text-sm font-medium">
                    {t('tax.profile.field.grossAnnualIncome')}
                </Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.field.grossAnnualIncome.desc')}</p>
                <Input
                    id="gross-income"
                    type="number"
                    min={0}
                    step={100}
                    value={profile.grossAnnualIncome || ''}
                    onChange={(e) => updateProfile({ grossAnnualIncome: parseFloat(e.target.value) || 0 })}
                    placeholder={t('tax.profile.placeholder.grossIncome')}
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor="other-income" className="text-sm font-medium">
                    {t('tax.profile.field.otherTaxableIncome')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                </Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.field.otherTaxableIncome.desc')}</p>
                <Input
                    id="other-income"
                    type="number"
                    min={0}
                    step={100}
                    value={profile.otherTaxableIncome || ''}
                    onChange={(e) => updateProfile({ otherTaxableIncome: parseFloat(e.target.value) || 0 })}
                    placeholder={t('tax.profile.placeholder.otherIncome')}
                />
            </div>

            <Separator />

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.professionalExpenses.title')}</p>
                    <p className="text-xs text-muted-foreground mb-3">{t('tax.profile.section.professionalExpenses.desc')}</p>
                </div>
                <RadioGroup
                    value={profile.professionalExpenseMethod}
                    onValueChange={(v) => updateProfile({ professionalExpenseMethod: v as ProfessionalExpenseMethod })}
                    className="space-y-2"
                >
                    <div className={cn(
                        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        profile.professionalExpenseMethod === 'lump_sum' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                    )}>
                        <RadioGroupItem value="lump_sum" id="exp-lump" className="mt-0.5" />
                        <Label htmlFor="exp-lump" className="cursor-pointer flex-1">
                            <span className="font-medium text-sm block">{t('tax.profile.profExp.lump.label')}</span>
                            <span className="text-xs text-muted-foreground">{t('tax.profile.profExp.lump.desc')}</span>
                        </Label>
                    </div>
                    <div className={cn(
                        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        profile.professionalExpenseMethod === 'actual' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                    )}>
                        <RadioGroupItem value="actual" id="exp-actual" className="mt-0.5" />
                        <Label htmlFor="exp-actual" className="cursor-pointer flex-1">
                            <span className="font-medium text-sm block">{t('tax.profile.profExp.actual.label')}</span>
                            <span className="text-xs text-muted-foreground">{t('tax.profile.profExp.actual.desc')}</span>
                        </Label>
                    </div>
                </RadioGroup>

                {profile.professionalExpenseMethod === 'actual' && (
                    <div className="space-y-2 pt-1">
                        <Label htmlFor="actual-expenses" className="text-sm font-medium">{t('tax.profile.field.actualProfessionalExpenses')}</Label>
                        <Input
                            id="actual-expenses"
                            type="number"
                            min={0}
                            step={100}
                            value={profile.actualProfessionalExpenses || ''}
                            onChange={(e) => updateProfile({ actualProfessionalExpenses: parseFloat(e.target.value) || 0 })}
                            placeholder={t('tax.profile.placeholder.actualExpenses')}
                        />
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <Label htmlFor="cadastral" className="text-sm font-medium">
                    {t('tax.profile.field.cadastralIncome')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                </Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.field.cadastralIncome.desc')}</p>
                <Input
                    id="cadastral"
                    type="number"
                    min={0}
                    step={10}
                    value={profile.cadastralIncome || ''}
                    onChange={(e) => updateProfile({ cadastralIncome: parseFloat(e.target.value) || 0 })}
                    placeholder={t('tax.profile.placeholder.cadastral')}
                />
            </div>

            <Separator />

            <div className="space-y-3">
                <p className="text-sm font-semibold text-foreground">{t('tax.profile.section.otherDeductions.title')}</p>
                <p className="text-xs text-muted-foreground mb-3">{t('tax.profile.section.otherDeductions.desc')}</p>

                    <div className="grid grid-cols-1 gap-3">
                        <div>
                            <Label htmlFor="pension">{t('tax.profile.field.personalPensionContributions')}</Label>
                        <Input id="pension" type="number" min={0} step={10} value={profile.personalPensionContributions || ''} onChange={(e) => updateProfile({ personalPensionContributions: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.personalPensionContributions')} />
                        <div className="flex items-center gap-3 mt-2">
                            <Select value={profile.pensionScheme} onValueChange={(v) => updateProfile({ pensionScheme: v as '1050' | '1350' })}>
                                <SelectTrigger id="pension-scheme" className="w-48">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="1050">Standard: €1,050 (30% credit)</SelectItem>
                                    <SelectItem value="1350">Alternative: €1,350 (25% credit)</SelectItem>
                                </SelectContent>
                            </Select>
                            <div className="flex items-center gap-2">
                                <Switch id="pension-eligible" checked={!!profile.pensionEligible} onCheckedChange={(v) => updateProfile({ pensionEligible: v })} />
                                <Label htmlFor="pension-eligible" className="cursor-pointer">{t('tax.profile.flag.pensionEligible')}</Label>
                            </div>
                        </div>
                    </div>
                    <div>
                        <Label htmlFor="alimony">{t('tax.profile.field.alimonyPaid')}</Label>
                        <Input id="alimony" type="number" min={0} step={10} value={profile.alimonyPaid || ''} onChange={(e) => updateProfile({ alimonyPaid: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.alimonyPaid')} />
                    </div>
                    <div>
                        <Label htmlFor="life">{t('tax.profile.field.lifeInsurancePremiums')}</Label>
                        <Input id="life" type="number" min={0} step={10} value={profile.lifeInsurancePremiums || ''} onChange={(e) => updateProfile({ lifeInsurancePremiums: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.lifeInsurancePremiums')} />
                        <div className="flex items-center gap-3 mt-2">
                            <Switch id="life-eligible" checked={!!profile.lifeInsuranceEligible} onCheckedChange={(v) => updateProfile({ lifeInsuranceEligible: v })} />
                            <Label htmlFor="life-eligible" className="cursor-pointer">{t('tax.profile.flag.lifeInsuranceEligible')}</Label>
                        </div>
                    </div>
                    <div>
                        <Label htmlFor="mortgage">{t('tax.profile.field.mortgageInterestPaid')}</Label>
                        <Input id="mortgage" type="number" min={0} step={10} value={profile.mortgageInterestPaid || ''} onChange={(e) => updateProfile({ mortgageInterestPaid: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.mortgageInterestPaid')} />
                    </div>
                    <div>
                        <Label htmlFor="donations">{t('tax.profile.field.charitableDonations')}</Label>
                        <Input id="donations" type="number" min={0} step={10} value={profile.charitableDonations || ''} onChange={(e) => updateProfile({ charitableDonations: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.charitableDonations')} />
                        <div className="flex items-center gap-3 mt-2">
                            <Switch id="donations-eligible" checked={!!profile.charitableDonationsEligible} onCheckedChange={(v) => updateProfile({ charitableDonationsEligible: v })} />
                            <Label htmlFor="donations-eligible" className="cursor-pointer">{t('tax.profile.flag.charitableDonationsEligible')}</Label>
                        </div>
                    </div>
                    <div>
                        <Label htmlFor="childcare">{t('tax.profile.field.childcareCosts')}</Label>
                        <Input id="childcare" type="number" min={0} step={10} value={profile.childcareCosts || ''} onChange={(e) => updateProfile({ childcareCosts: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.childcareCosts')} />
                        <div className="flex items-center gap-3 mt-2">
                            <Switch id="childcare-eligible" checked={!!profile.childcareEligible} onCheckedChange={(v) => updateProfile({ childcareEligible: v })} />
                            <Label htmlFor="childcare-eligible" className="cursor-pointer">{t('tax.profile.flag.childcareEligible')}</Label>
                        </div>
                    </div>
                    <div>
                        <Label htmlFor="union">{t('tax.profile.field.unionDues')}</Label>
                        <Input id="union" type="number" min={0} step={10} value={profile.unionDues || ''} onChange={(e) => updateProfile({ unionDues: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.unionDues')} />
                    </div>
                    <div>
                        <Label htmlFor="medical">{t('tax.profile.field.medicalExpenses')}</Label>
                        <Input id="medical" type="number" min={0} step={10} value={profile.medicalExpenses || ''} onChange={(e) => updateProfile({ medicalExpenses: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.medicalExpenses')} />
                    </div>
                    <div>
                        <Label htmlFor="domestic-help">{t('tax.profile.field.domesticHelpCosts')}</Label>
                        <Input id="domestic-help" type="number" min={0} step={10} value={profile.domesticHelpCosts || ''} onChange={(e) => updateProfile({ domesticHelpCosts: parseFloat(e.target.value) || 0 })} placeholder={t('tax.profile.placeholder.domesticHelpCosts')} />
                        <div className="flex items-center gap-3 mt-2">
                            <Switch id="domestic-help-eligible" checked={!!profile.domesticHelpEligible} onCheckedChange={(v) => updateProfile({ domesticHelpEligible: v })} />
                            <Label htmlFor="domestic-help-eligible" className="cursor-pointer">{t('tax.profile.flag.domesticHelpEligible')}</Label>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ExemptionsStep({
    profile,
    updateProfile,
}: {
    profile: ReturnType<typeof useBelgianTaxProfile>['profile'];
    updateProfile: (updates: Partial<ReturnType<typeof useBelgianTaxProfile>['profile']>) => void;
}) {
    const { t } = useLanguage();
    return (
        <div className="space-y-5">
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.exemptions.title')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('tax.profile.section.exemptions.desc')}</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="dep-children" className="text-sm font-medium">{t('tax.profile.field.children')}</Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.dependents.children.desc')}</p>
                <Select
                    value={String(profile.dependentChildren)}
                    onValueChange={(v) => updateProfile({ dependentChildren: parseInt(v) })}
                >
                    <SelectTrigger id="dep-children">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {[0, 1, 2, 3, 4, 5].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                                {n === 0 ? t('common.none') : n === 1 ? `${n} ${t('tax.profile.field.children.singular')}` : `${n} ${t('tax.profile.field.children')}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-2">
                <Label htmlFor="dep-other" className="text-sm font-medium">
                    {t('tax.profile.field.others')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                </Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.dependents.others.desc')}</p>
                <Select
                    value={String(profile.dependentOtherPersons)}
                    onValueChange={(v) => updateProfile({ dependentOtherPersons: parseInt(v) })}
                >
                    <SelectTrigger id="dep-other">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {[0, 1, 2, 3].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                                {n === 0 ? t('common.none') : n === 1 ? `${n} ${t('tax.profile.field.others.singular')}` : `${n} ${t('tax.profile.field.others')}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <Separator />

            <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex-1">
                        <Label htmlFor="disabled" className="text-sm font-medium cursor-pointer">{t('tax.profile.field.disabilityExemption.self')}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">{t('tax.profile.field.disabilityExemption.desc')}</p>
                    </div>
                    <Switch
                        id="disabled"
                        checked={profile.isDisabled}
                        onCheckedChange={(v) => updateProfile({ isDisabled: v })}
                    />
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex-1">
                        <Label htmlFor="spouse-disabled" className="text-sm font-medium cursor-pointer">{t('tax.profile.field.disabilityExemption.spouse')}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">{t('tax.profile.field.disabilityExemption.desc')}</p>
                    </div>
                    <Switch
                        id="spouse-disabled"
                        checked={profile.isSpouseDisabled}
                        onCheckedChange={(v) => updateProfile({ isSpouseDisabled: v })}
                    />
                </div>
            </div>
        </div>
    );
}

function RegionStep({
    profile,
    updateProfile,
}: {
    profile: ReturnType<typeof useBelgianTaxProfile>['profile'];
    updateProfile: (updates: Partial<ReturnType<typeof useBelgianTaxProfile>['profile']>) => void;
}) {
    const { t } = useLanguage();
    const regions: { value: BelgianRegion; label: string; desc: string; defaultSurcharge: number }[] = [
        { value: 'flanders', label: 'Flanders (Vlaanderen)', desc: 'Flemish Region — property taxes and some surcharges differ from other regions.', defaultSurcharge: DEFAULT_COMMUNAL_SURCHARGE.flanders },
        { value: 'wallonia', label: 'Wallonia (Wallonie)', desc: 'Walloon Region — slightly higher average communal surcharges.', defaultSurcharge: DEFAULT_COMMUNAL_SURCHARGE.wallonia },
        { value: 'brussels', label: 'Brussels Capital Region', desc: 'Brussels-Capital — cosmopolitan municipality rates.', defaultSurcharge: DEFAULT_COMMUNAL_SURCHARGE.brussels },
    ];
    return (
        <div className="space-y-5">
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.region.title')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('tax.profile.section.region.desc')}</p>
            </div>

            <div className="space-y-3">
                <Label className="text-sm font-medium">{t('tax.profile.field.regionLabel')}</Label>
                <RadioGroup
                    value={profile.region}
                    onValueChange={(v) => {
                        const r = v as BelgianRegion;
                        updateProfile({ region: r, communalSurchargePercent: DEFAULT_COMMUNAL_SURCHARGE[r] });
                    }}
                    className="space-y-2"
                >
                    {regions.map(({ value, label, desc, defaultSurcharge }) => (
                        <div key={value} className={cn(
                            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                            profile.region === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                        )}>
                            <RadioGroupItem value={value} id={`region-${value}`} className="mt-0.5" />
                            <Label htmlFor={`region-${value}`} className="cursor-pointer flex-1">
                                <span className="font-medium text-sm block">{t(`tax.profile.region.${value}.label`) || label}</span>
                                <span className="text-xs text-muted-foreground">{t(`tax.profile.region.${value}.desc`) || desc}</span>
                                <span className="text-xs text-muted-foreground"> {t('tax.profile.region.defaultSurcharge', { pct: defaultSurcharge })}</span>
                            </Label>
                        </div>
                    ))}
                </RadioGroup>
            </div>

            <div className="space-y-2">
                <Label htmlFor="communal-surcharge" className="text-sm font-medium">{t('tax.profile.field.communalSurcharge')}</Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.field.communalSurcharge.desc')}</p>
                <div className="flex items-center gap-3">
                    <Input
                        id="communal-surcharge"
                        type="number"
                        min={0}
                        max={9}
                        step={0.1}
                        value={profile.communalSurchargePercent}
                        onChange={(e) => updateProfile({ communalSurchargePercent: parseFloat(e.target.value) || 0 })}
                        className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">{t('tax.profile.communalSurchargePct')}</span>
                </div>
            </div>
        </div>
    );
}
