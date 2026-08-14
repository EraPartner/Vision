import { parseDecimal } from '@/lib/decimal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import {
    DEFAULT_COMMUNAL_SURCHARGE,
    type BelgianRegion,
} from '@/contexts/BelgianTaxProfileContext';
import type { StepProps } from './types';

export function RegionStep({ profile, updateProfile }: StepProps) {
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
                        onChange={(e) => updateProfile({ communalSurchargePercent: parseDecimal(e.target.value) })}
                        className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">{t('tax.profile.communalSurchargePct')}</span>
                </div>
            </div>
        </div>
    );
}
