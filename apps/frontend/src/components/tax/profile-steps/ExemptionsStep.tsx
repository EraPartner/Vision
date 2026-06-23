import { parseDecimal } from '@/lib/decimal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import type { StepProps } from './types';

export function ExemptionsStep({ profile, updateProfile }: StepProps) {
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
                    onValueChange={(v) => {
                        const next = parseInt(v);
                        const disabled = Math.min(profile.dependentChildrenDisabled ?? 0, next);
                        updateProfile({ dependentChildren: next, dependentChildrenDisabled: disabled });
                    }}
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

            {profile.dependentChildren > 0 && (
                <div className="space-y-2 pl-3 border-l-2 border-border">
                    <Label htmlFor="dep-children-disabled" className="text-sm font-medium">
                        {t('tax.profile.field.childrenDisabled')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('tax.profile.field.childrenDisabled.desc')}</p>
                    <Select
                        value={String(profile.dependentChildrenDisabled ?? 0)}
                        onValueChange={(v) => updateProfile({ dependentChildrenDisabled: parseInt(v) })}
                    >
                        <SelectTrigger id="dep-children-disabled">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {Array.from({ length: profile.dependentChildren + 1 }, (_, n) => (
                                <SelectItem key={n} value={String(n)}>
                                    {n === 0 ? t('common.none') : String(n)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor="dep-other" className="text-sm font-medium">
                    {t('tax.profile.field.others')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                </Label>
                <p className="text-xs text-muted-foreground">{t('tax.profile.dependents.others.desc')}</p>
                <Select
                    value={String(profile.dependentOtherPersons)}
                    onValueChange={(v) => {
                        const next = parseInt(v);
                        const disabled = Math.min(profile.dependentOtherPersonsDisabled ?? 0, next);
                        updateProfile({ dependentOtherPersons: next, dependentOtherPersonsDisabled: disabled });
                    }}
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

            {profile.dependentOtherPersons > 0 && (
                <div className="space-y-2 pl-3 border-l-2 border-border">
                    <Label htmlFor="dep-other-disabled" className="text-sm font-medium">
                        {t('tax.profile.field.othersDisabled')} <Badge variant="outline" className="text-[10px] ml-1">{t('common.optional')}</Badge>
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('tax.profile.field.othersDisabled.desc')}</p>
                    <Select
                        value={String(profile.dependentOtherPersonsDisabled ?? 0)}
                        onValueChange={(v) => updateProfile({ dependentOtherPersonsDisabled: parseInt(v) })}
                    >
                        <SelectTrigger id="dep-other-disabled">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {Array.from({ length: profile.dependentOtherPersons + 1 }, (_, n) => (
                                <SelectItem key={n} value={String(n)}>
                                    {n === 0 ? t('common.none') : String(n)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}

            <Separator />

            <div>
                <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.otherDeductions.title')}</p>
                <p className="text-xs text-muted-foreground mb-3">{t('tax.profile.section.otherDeductions.desc')}</p>
            </div>

            <div className="grid grid-cols-1 gap-3">
                <div>
                    <Label htmlFor="alimony">{t('tax.profile.field.alimonyPaid')}</Label>
                    <Input id="alimony" type="number" min={0} step={10} value={profile.alimonyPaid || ''} onChange={(e) => updateProfile({ alimonyPaid: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.alimonyPaid')} />
                </div>

                <div>
                    <Label htmlFor="pension">{t('tax.profile.field.personalPensionContributions')}</Label>
                    <Input id="pension" type="number" min={0} step={10} value={profile.personalPensionContributions || ''} onChange={(e) => updateProfile({ personalPensionContributions: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.personalPensionContributions')} />
                    <div className="flex items-center gap-3 mt-2">
                        <Select value={profile.pensionScheme} onValueChange={(v) => updateProfile({ pensionScheme: v as '1050' | '1350' })}>
                            <SelectTrigger id="pension-scheme" className="w-56">
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
                    <Label htmlFor="group-insurance">{t('tax.profile.field.employeeGroupInsuranceContributions')}</Label>
                    <Input id="group-insurance" type="number" min={0} step={10} value={profile.employeeGroupInsuranceContributions || ''} onChange={(e) => updateProfile({ employeeGroupInsuranceContributions: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.employeeGroupInsuranceContributions')} />
                    <div className="flex items-center gap-3 mt-2">
                        <Switch id="group-insurance-eligible" checked={!!profile.employeeGroupInsuranceEligible} onCheckedChange={(v) => updateProfile({ employeeGroupInsuranceEligible: v })} />
                        <Label htmlFor="group-insurance-eligible" className="cursor-pointer">{t('tax.profile.flag.employeeGroupInsuranceEligible')}</Label>
                    </div>
                </div>

                <div>
                    <Label htmlFor="life">{t('tax.profile.field.lifeInsurancePremiums')}</Label>
                    <Input id="life" type="number" min={0} step={10} value={profile.lifeInsurancePremiums || ''} onChange={(e) => updateProfile({ lifeInsurancePremiums: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.lifeInsurancePremiums')} />
                    <div className="flex items-center gap-3 mt-2">
                        <Switch id="life-eligible" checked={!!profile.lifeInsuranceEligible} onCheckedChange={(v) => updateProfile({ lifeInsuranceEligible: v })} />
                        <Label htmlFor="life-eligible" className="cursor-pointer">{t('tax.profile.flag.lifeInsuranceEligible')}</Label>
                    </div>
                </div>

                <div>
                    <Label htmlFor="donations">{t('tax.profile.field.charitableDonations')}</Label>
                    <Input id="donations" type="number" min={0} step={10} value={profile.charitableDonations || ''} onChange={(e) => updateProfile({ charitableDonations: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.charitableDonations')} />
                    <div className="flex items-center gap-3 mt-2">
                        <Switch id="donations-eligible" checked={!!profile.charitableDonationsEligible} onCheckedChange={(v) => updateProfile({ charitableDonationsEligible: v })} />
                        <Label htmlFor="donations-eligible" className="cursor-pointer">{t('tax.profile.flag.charitableDonationsEligible')}</Label>
                    </div>
                </div>

                <div>
                    <Label htmlFor="childcare">{t('tax.profile.field.childcareCosts')}</Label>
                    <Input id="childcare" type="number" min={0} step={10} value={profile.childcareCosts || ''} onChange={(e) => updateProfile({ childcareCosts: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.childcareCosts')} />
                    <div className="mt-2">
                        <Label htmlFor="childcare-days">{t('tax.profile.field.childcareEligibleDays')}</Label>
                        <Input id="childcare-days" type="number" min={0} step={1} value={profile.childcareEligibleDays || ''} onChange={(e) => updateProfile({ childcareEligibleDays: parseInt(e.target.value || '0', 10) || 0 })} placeholder={t('tax.profile.placeholder.childcareEligibleDays')} />
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                        <Switch id="childcare-eligible" checked={!!profile.childcareEligible} onCheckedChange={(v) => updateProfile({ childcareEligible: v })} />
                        <Label htmlFor="childcare-eligible" className="cursor-pointer">{t('tax.profile.flag.childcareEligible')}</Label>
                    </div>
                </div>

                <div>
                    <Label htmlFor="domestic-help">{t('tax.profile.field.domesticHelpCosts')}</Label>
                    <Input id="domestic-help" type="number" min={0} step={10} value={profile.domesticHelpCosts || ''} onChange={(e) => updateProfile({ domesticHelpCosts: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.domesticHelpCosts')} />
                    <div className="flex items-center gap-3 mt-2">
                        <Switch id="domestic-help-eligible" checked={!!profile.domesticHelpEligible} onCheckedChange={(v) => updateProfile({ domesticHelpEligible: v })} />
                        <Label htmlFor="domestic-help-eligible" className="cursor-pointer">{t('tax.profile.flag.domesticHelpEligible')}</Label>
                    </div>
                </div>

                <div>
                    <Label htmlFor="union">{t('tax.profile.field.unionDues')}</Label>
                    <Input id="union" type="number" min={0} step={10} value={profile.unionDues || ''} onChange={(e) => updateProfile({ unionDues: parseDecimal(e.target.value) })} placeholder={t('tax.profile.placeholder.unionDues')} />
                    <p className="text-xs text-muted-foreground">{t('tax.profile.field.unionDues.desc')}</p>
                </div>
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

                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex-1">
                        <Label htmlFor="isolated-parent" className="text-sm font-medium cursor-pointer">{t('tax.profile.field.isolatedParent.label')}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">{t('tax.profile.field.isolatedParent.desc')}</p>
                    </div>
                    <Switch
                        id="isolated-parent"
                        checked={profile.isIsolatedParent ?? false}
                        onCheckedChange={(v) => updateProfile({ isIsolatedParent: v })}
                    />
                </div>
            </div>
        </div>
    );
}
