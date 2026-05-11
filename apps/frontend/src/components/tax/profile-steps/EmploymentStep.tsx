import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import type { EmploymentType } from '@/contexts/BelgianTaxProfileContext';
import type { StepProps } from './types';

export function EmploymentStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    const types: { value: EmploymentType; label: string; desc: string }[] = [
        { value: 'employee', label: t('tax.profile.employment.employee.label'), desc: t('tax.profile.employment.employee.desc') },
        { value: 'civil_servant', label: t('tax.profile.employment.civil_servant.label'), desc: t('tax.profile.employment.civil_servant.desc') },
        { value: 'self_employed', label: t('tax.profile.employment.self_employed.label'), desc: t('tax.profile.employment.self_employed.desc') },
        { value: 'director', label: t('tax.profile.employment.director.label'), desc: t('tax.profile.employment.director.desc') },
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
