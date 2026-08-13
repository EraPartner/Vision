import { useRef } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import type {
    BelgianRegion,
    ProfessionalExpenseMethod,
} from '@/contexts/BelgianTaxProfileContext';
import type { StepProps } from './types';

export function IncomeStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    const residenceUids = useRef<string[]>([]);
    const residences = profile.additionalResidences || [];
    while (residenceUids.current.length < residences.length) {
        residenceUids.current.push(crypto.randomUUID());
    }
    if (residenceUids.current.length > residences.length) {
        residenceUids.current.length = residences.length;
    }
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
                    onChange={(e) => updateProfile({ grossAnnualIncome: parseDecimal(e.target.value) })}
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
                    onChange={(e) => updateProfile({ otherTaxableIncome: parseDecimal(e.target.value) })}
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
                            onChange={(e) => updateProfile({ actualProfessionalExpenses: parseDecimal(e.target.value) })}
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
                    onChange={(e) => updateProfile({ cadastralIncome: parseDecimal(e.target.value) })}
                    placeholder={t('tax.profile.placeholder.cadastral')}
                />
            </div>

            <div>
                <p className="text-sm font-semibold text-foreground mb-2">{t('tax.profile.section.residences.title')}</p>
                <p className="text-xs text-muted-foreground mb-3">{t('tax.profile.section.residences.desc')}</p>
                {residences.map((r, idx) => (
                    <div key={residenceUids.current[idx]} className="grid grid-cols-3 gap-2 items-end mb-2">
                        <div className="col-span-1">
                            <Label className="text-xs">{t('tax.profile.field.residenceLabel') || 'Label'}</Label>
                            <Input value={r.label || ''} onChange={(e) => {
                                const copy = [...(profile.additionalResidences || [])];
                                copy[idx] = { ...copy[idx], label: e.target.value };
                                updateProfile({ additionalResidences: copy });
                            }} />
                        </div>
                        <div>
                            <Label className="text-xs">{t('tax.profile.field.cadastralIncome')}</Label>
                            <Input type="number" min={0} step={10} value={r.cadastralIncome || ''} onChange={(e) => {
                                const copy = [...(profile.additionalResidences || [])];
                                copy[idx] = { ...copy[idx], cadastralIncome: parseDecimal(e.target.value) };
                                updateProfile({ additionalResidences: copy });
                            }} />
                        </div>
                        <div>
                            <Label className="text-xs">{t('tax.profile.field.regionLabel')}</Label>
                            <Select value={r.region || profile.region} onValueChange={(v) => {
                                const copy = [...(profile.additionalResidences || [])];
                                copy[idx] = { ...copy[idx], region: v as BelgianRegion };
                                updateProfile({ additionalResidences: copy });
                            }}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="flanders">Flanders</SelectItem>
                                    <SelectItem value="wallonia">Wallonia</SelectItem>
                                    <SelectItem value="brussels">Brussels</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                ))}
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => {
                        const copy = [...(profile.additionalResidences || [])];
                        copy.push({ label: '', cadastralIncome: 0, region: profile.region });
                        updateProfile({ additionalResidences: copy });
                    }}>{t('tax.profile.addResidence') || 'Add residence'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => updateProfile({ additionalResidences: [] })}>{t('common.reset')}</Button>
                </div>
            </div>

            <Separator />

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-semibold text-foreground mb-1">{t('tax.profile.section.ownHome.title')}</p>
                    <p className="text-xs text-muted-foreground mb-3">{t('tax.profile.section.ownHome.desc')}</p>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex-1">
                        <Label htmlFor="own-home-primary" className="text-sm font-medium cursor-pointer">
                            {t('tax.profile.field.mortgageIsPrimaryResidence')}
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {t('tax.profile.field.mortgageIsPrimaryResidence.desc')}
                        </p>
                    </div>
                    <Switch
                        id="own-home-primary"
                        checked={!!profile.mortgageIsPrimaryResidence}
                        onCheckedChange={(v) => updateProfile({ mortgageIsPrimaryResidence: v })}
                    />
                </div>

                {profile.mortgageIsPrimaryResidence && (
                    <div className="space-y-3 pl-1">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="mortgage-year" className="text-xs">
                                    {t('tax.profile.field.mortgageStartYear')}
                                </Label>
                                <Input
                                    id="mortgage-year"
                                    type="number"
                                    min={1990}
                                    max={new Date().getFullYear()}
                                    step={1}
                                    value={profile.mortgageStartYear || ''}
                                    onChange={(e) =>
                                        updateProfile({
                                            mortgageStartYear: e.target.value
                                                ? parseInt(e.target.value, 10)
                                                : undefined,
                                        })
                                    }
                                    placeholder={t('tax.profile.placeholder.mortgageStartYear')}
                                />
                            </div>
                            <div>
                                <Label htmlFor="mortgage-region" className="text-xs">
                                    {t('tax.profile.field.mortgageRegion')}
                                </Label>
                                <Select
                                    value={profile.mortgageRegion ?? profile.region}
                                    onValueChange={(v) =>
                                        updateProfile({ mortgageRegion: v as BelgianRegion })
                                    }
                                >
                                    <SelectTrigger id="mortgage-region" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="flanders">Flanders</SelectItem>
                                        <SelectItem value="wallonia">Wallonia</SelectItem>
                                        <SelectItem value="brussels">Brussels</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="mortgage-interest" className="text-xs">
                                    {t('tax.profile.field.mortgageInterestPaid')}
                                </Label>
                                <Input
                                    id="mortgage-interest"
                                    type="number"
                                    min={0}
                                    step={10}
                                    value={profile.mortgageInterestPaid || ''}
                                    onChange={(e) =>
                                        updateProfile({ mortgageInterestPaid: parseDecimal(e.target.value) })
                                    }
                                    placeholder={t('tax.profile.placeholder.mortgageInterestPaid')}
                                />
                            </div>
                            <div>
                                <Label htmlFor="mortgage-capital" className="text-xs">
                                    {t('tax.profile.field.mortgageCapitalRepaid')}
                                </Label>
                                <Input
                                    id="mortgage-capital"
                                    type="number"
                                    min={0}
                                    step={10}
                                    value={profile.mortgageCapitalRepaid || ''}
                                    onChange={(e) =>
                                        updateProfile({ mortgageCapitalRepaid: parseDecimal(e.target.value) })
                                    }
                                    placeholder={t('tax.profile.placeholder.mortgageCapitalRepaid')}
                                />
                            </div>
                        </div>

                        <p className="text-[11px] text-muted-foreground">
                            {t('tax.profile.section.ownHome.note')}
                        </p>
                    </div>
                )}
            </div>

            <Separator />
        </div>
    );
}
