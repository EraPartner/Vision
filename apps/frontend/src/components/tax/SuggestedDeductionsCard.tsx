import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useBelgianTaxProfile, PENSION_SAVINGS_CAP_STANDARD, PENSION_SAVINGS_CAP_ALTERNATIVE, LIFE_INSURANCE_CAP, CHARITABLE_DONATION_MIN, CHILDCARE_DAILY_CAP_2025 } from '@/contexts/BelgianTaxProfileContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { numberFormatToLocale } from '@/utils/currency';
import { TaxProfileDialog } from './TaxProfileDialog';

export function SuggestedDeductionsCard() {
    const { profile, calculation } = useBelgianTaxProfile();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    const locale = numberFormatToLocale(appSettings.numberFormat);
    function fmt(val: number) {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: appSettings.defaultCurrency || 'EUR',
            minimumFractionDigits: appSettings.showDecimalPlaces,
            maximumFractionDigits: appSettings.showDecimalPlaces,
        }).format(val);
    }

    const suggestions = useMemo(() => {
        const items: Array<{ id: string; title: string; desc: string; estimate?: number; note?: string }> = [];

        // Pension savings
        const pensionCeiling = profile.pensionScheme === '1350' ? PENSION_SAVINGS_CAP_ALTERNATIVE : PENSION_SAVINGS_CAP_STANDARD;
        const pensionRate = profile.pensionScheme === '1350' ? 0.25 : 0.30;
        const pensionMaxCredit = pensionCeiling * pensionRate;
        if (profile.pensionEligible && !(profile.personalPensionContributions > 0)) {
            items.push({ id: 'pension.no_amount', title: 'Pension savings', desc: t('tax.suggestions.pension.noAmount'), estimate: pensionMaxCredit });
        } else if (!profile.pensionEligible && profile.personalPensionContributions > 0) {
            const est = Math.min(profile.personalPensionContributions, pensionCeiling) * pensionRate;
            items.push({ id: 'pension.not_marked', title: 'Pension savings', desc: t('tax.suggestions.pension.notMarked'), estimate: est });
        } else if (!profile.pensionEligible && profile.grossAnnualIncome > 0 && profile.personalPensionContributions === 0) {
            items.push({ id: 'pension.suggest', title: 'Pension savings', desc: t('tax.suggestions.pension.suggest'), estimate: pensionMaxCredit });
        }

        // Life insurance
        if (profile.lifeInsuranceEligible && !(profile.lifeInsurancePremiums > 0)) {
            items.push({ id: 'life.no_amount', title: 'Life insurance', desc: t('tax.suggestions.life.noAmount'), estimate: LIFE_INSURANCE_CAP * 0.30 });
        } else if (!profile.lifeInsuranceEligible && profile.lifeInsurancePremiums > 0) {
            const est = Math.min(profile.lifeInsurancePremiums, LIFE_INSURANCE_CAP) * 0.30;
            items.push({ id: 'life.not_marked', title: 'Life insurance', desc: t('tax.suggestions.life.notMarked'), estimate: est });
        }

        // Group insurance
        if (profile.employeeGroupInsuranceEligible && !(profile.employeeGroupInsuranceContributions > 0)) {
            items.push({ id: 'group.no_amount', title: 'Employee group insurance', desc: t('tax.suggestions.group.noAmount'), estimate: 0 });
        } else if (!profile.employeeGroupInsuranceEligible && profile.employeeGroupInsuranceContributions > 0) {
            items.push({ id: 'group.not_marked', title: 'Employee group insurance', desc: t('tax.suggestions.group.notMarked'), estimate: profile.employeeGroupInsuranceContributions * 0.30 });
        } else if (!profile.employeeGroupInsuranceEligible && profile.employmentType === 'employee' && !(profile.employeeGroupInsuranceContributions > 0)) {
            items.push({ id: 'group.suggest', title: 'Employee group insurance', desc: t('tax.suggestions.group.suggest'), estimate: 0 });
        }

        // Charitable donations
        if (profile.charitableDonationsEligible && !(profile.charitableDonations > 0)) {
            items.push({ id: 'donations.no_amount', title: 'Charitable donations', desc: t('tax.suggestions.donations.noAmount'), note: t('tax.suggestions.donations.note') });
        } else if (!profile.charitableDonationsEligible && profile.charitableDonations > 0) {
            const est = 0.45 * profile.charitableDonations;
            items.push({ id: 'donations.not_marked', title: 'Charitable donations', desc: t('tax.suggestions.donations.notMarked'), estimate: est });
        }

        // Childcare
        const childcareCap = (profile.childcareEligibleDays || 0) * CHILDCARE_DAILY_CAP_2025;
        if (profile.childcareEligible && !(profile.childcareCosts > 0)) {
            items.push({ id: 'childcare.no_amount', title: 'Childcare costs', desc: t('tax.suggestions.childcare.noAmount'), estimate: 0 });
        } else if (!profile.childcareEligible && profile.childcareCosts > 0) {
            const est = 0.45 * Math.min(profile.childcareCosts, childcareCap);
            items.push({ id: 'childcare.not_marked', title: 'Childcare costs', desc: t('tax.suggestions.childcare.notMarked'), estimate: est });
        } else if (!profile.childcareEligible && profile.dependentChildren > 0 && profile.childcareEligibleDays === 0) {
            // soft suggestion — show example using 120 days
            const exampleDays = 120;
            const exampleEst = 0.45 * (exampleDays * CHILDCARE_DAILY_CAP_2025);
            items.push({ id: 'childcare.suggest', title: 'Childcare costs', desc: t('tax.suggestions.childcare.suggest', { days: exampleDays }), estimate: exampleEst });
        }

        // Domestic help
        if (profile.domesticHelpEligible && !(profile.domesticHelpCosts > 0)) {
            items.push({ id: 'domestic.no_amount', title: 'Domestic help', desc: t('tax.suggestions.domestic.noAmount'), estimate: 0 });
        } else if (!profile.domesticHelpEligible && profile.domesticHelpCosts > 0) {
            const est = 0.30 * profile.domesticHelpCosts;
            items.push({ id: 'domestic.not_marked', title: 'Domestic help', desc: t('tax.suggestions.domestic.notMarked'), estimate: est });
        }

        // Alimony (deduction) — estimate tax saving using marginal rate
        if (profile.alimonyPaid > 0) {
            const deduction = 0.80 * profile.alimonyPaid;
            const marginal = Math.max(0, Math.min(calculation.marginalRate, 100)) / 100;
            const estSaving = deduction * marginal;
            items.push({ id: 'alimony.applied', title: 'Alimony paid', desc: t('tax.suggestions.alimony.applied'), estimate: estSaving });
        }

        return items;
    }, [profile, calculation, t]);

    if (!suggestions || suggestions.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t('tax.suggestions.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">{t('tax.suggestions.none')}</p>
                    <p className="text-xs text-muted-foreground mt-2">{t('tax.suggestions.regionalNote')}</p>
                    <a className="text-sm text-primary mt-2 inline-block" href="https://taxsummaries.pwc.com/belgium/individual/deductions" target="_blank" rel="noreferrer">{t('tax.suggestions.pwcLink')}</a>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('tax.suggestions.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {suggestions.map((s) => (
                    <div key={s.id} className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium">{s.title}</p>
                            <p className="text-xs text-muted-foreground">{s.desc}</p>
                            {s.note && <p className="text-xs text-muted-foreground mt-1">{s.note}</p>}
                        </div>
                        <div className="text-right">
                            {typeof s.estimate === 'number' && s.estimate > 0 ? (
                                <p className="font-semibold">{fmt(s.estimate)}</p>
                            ) : (
                                <p className="text-xs text-muted-foreground">{t('tax.suggestions.estimateNote')}</p>
                            )}
                            <div className="mt-2 flex justify-end">
                                <TaxProfileDialog trigger={<Button size="sm">{t('tax.suggestions.cta')}</Button>} initialStep={'exemptions'} />
                            </div>
                        </div>
                    </div>
                ))}

                <div className="pt-2 border-t mt-2">
                    <p className="text-sm font-semibold">{t('tax.suggestions.regionalTitle')}</p>
                    <p className="text-xs text-muted-foreground">{t('tax.suggestions.regionalDesc')}</p>
                    <p className="text-xs text-muted-foreground mt-2">{t('tax.suggestions.multipleResidencesNote')}</p>
                    <a className="text-sm text-primary mt-2 inline-block" href="https://taxsummaries.pwc.com/belgium/individual/deductions" target="_blank" rel="noreferrer">{t('tax.suggestions.pwcLink')}</a>
                </div>
            </CardContent>
        </Card>
    );
}

export default SuggestedDeductionsCard;
