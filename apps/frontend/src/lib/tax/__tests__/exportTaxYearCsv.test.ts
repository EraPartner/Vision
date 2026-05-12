import { describe, it, expect } from 'vitest';
import { buildTaxYearCsv } from '../exportTaxYearCsv';
import { computeBelgianPIT, type BelgianTaxProfile } from '@/lib/belgianTax';

function makeProfile(overrides: Partial<BelgianTaxProfile> = {}): BelgianTaxProfile {
    return {
        profileConfigured: true,
        employmentType: 'employee',
        grossAnnualIncome: 50000,
        professionalExpenseMethod: 'lump_sum',
        actualProfessionalExpenses: 0,
        communalSurchargePercent: 7,
        region: 'flanders',
        dependentChildren: 0,
        dependentOtherPersons: 0,
        isDisabled: false,
        isSpouseDisabled: false,
        cadastralIncome: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        personalPensionContributions: 0,
        lifeInsurancePremiums: 0,
        mortgageInterestPaid: 0,
        charitableDonations: 0,
        childcareCosts: 0,
        unionDues: 0,
        medicalExpenses: 0,
        filingStatus: 'single',
        taxYear: 2024,
        ...overrides,
    };
}

describe('buildTaxYearCsv', () => {
    it('starts with a metadata header section that names the year and status', () => {
        const profile = makeProfile();
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'EUR',
            isFiled: true,
            hasFrozenCalculation: true,
            generatedAt: '2026-05-12T08:00:00.000Z',
        });
        const lines = csv.split('\n');
        expect(lines[0]).toBe('# Vision tax year export');
        expect(lines[1]).toBe('Income year,2024');
        expect(lines[2]).toBe('Currency,EUR');
        expect(lines[3]).toBe('Status,filed');
        expect(lines[4]).toBe('Generated at,2026-05-12T08:00:00.000Z');
    });

    it('marks unfilfed, non-frozen years as "live" status', () => {
        const profile = makeProfile();
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'EUR',
            isFiled: false,
            hasFrozenCalculation: false,
            generatedAt: '2026-05-12T08:00:00.000Z',
        });
        expect(csv).toMatch(/Status,live/);
    });

    it('marks frozen-but-not-filed years as "frozen" status', () => {
        const profile = makeProfile();
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'EUR',
            isFiled: false,
            hasFrozenCalculation: true,
            generatedAt: '2026-05-12T08:00:00.000Z',
        });
        expect(csv).toMatch(/Status,frozen/);
    });

    it('includes profile input rows under their own header', () => {
        const profile = makeProfile({ grossAnnualIncome: 65000, region: 'brussels' });
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'EUR',
            isFiled: false,
            hasFrozenCalculation: false,
            generatedAt: '2026-05-12T08:00:00.000Z',
        });
        expect(csv).toMatch(/# Profile inputs/);
        expect(csv).toMatch(/Gross annual income,65000/);
        expect(csv).toMatch(/Region,brussels/);
    });

    it('includes calculation rows under their own header with currency hint', () => {
        const profile = makeProfile();
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'USD',
            isFiled: false,
            hasFrozenCalculation: false,
            generatedAt: '2026-05-12T08:00:00.000Z',
        });
        expect(csv).toMatch(/# Calculation/);
        expect(csv).toMatch(/Component,Amount \(USD\)/);
        expect(csv).toMatch(/Total PIT,/);
    });

    it('quotes cells containing commas or quotes', () => {
        const profile = makeProfile({
            // Region is a controlled enum so we abuse mortgageStartYear to force a string with a comma.
            // For a true edge-case test, inject a value through a cast — keeps the type-safe path
            // for the normal flow.
        });
        const calc = computeBelgianPIT(profile);
        const csv = buildTaxYearCsv({
            year: 2024,
            profile,
            calculation: calc,
            currency: 'EUR',
            isFiled: false,
            hasFrozenCalculation: false,
            generatedAt: '2026-05-12,08:00:00',
        });
        // The "Generated at" value contains a comma → must be quoted.
        expect(csv).toMatch(/"2026-05-12,08:00:00"/);
    });
});
