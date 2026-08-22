// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string | number>) => {
            const dict: Record<string, string> = {
                'tax.comparison.description': 'Compare the viewed year against another year on file.',
                'tax.comparison.header.delta': 'Delta',
                'tax.comparison.header.metric': 'Metric',
                'tax.comparison.row.effectiveRate': 'Effective tax rate',
                'tax.comparison.row.grossIncome': 'Gross income',
                'tax.comparison.row.netTakeHome': 'Net take-home',
                'tax.comparison.row.totalPIT': 'Total PIT',
                'tax.comparison.selectYear': 'Compare with year',
                'tax.comparison.title': '{year} vs another year',
                'tax.comparison.versus': 'vs',
            };
            let value = dict[key] ?? key;
            for (const [name, replacement] of Object.entries(vars ?? {})) {
                value = value.replaceAll(`{${name}}`, String(replacement));
            }
            return value;
        },
    }),
}));

vi.mock('@/contexts/BelgianTaxProfileContext', () => ({
    useBelgianTaxProfile: vi.fn(),
}));

vi.mock('@/hooks/useAvailableTaxYears', () => ({
    useAvailableTaxYears: vi.fn(),
}));

vi.mock('@/hooks/useCurrencyFormatter', () => ({
    useCurrencyFormatter: () => (value: number) => `€${value}`,
}));

import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { useAvailableTaxYears } from '@/hooks/useAvailableTaxYears';
import { YearComparisonCard } from '../YearComparisonCard';

const mockedProfile = vi.mocked(useBelgianTaxProfile);
const mockedYears = vi.mocked(useAvailableTaxYears);

describe('YearComparisonCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedProfile.mockReturnValue({
            viewedYear: 2026,
            displayCalculationForYear: (year: number) => ({
                grossIncome: year === 2026 ? 60_000 : 55_000,
                totalPIT: year === 2026 ? 15_000 : 13_000,
                effectiveRate: year === 2026 ? 25 : 23.6,
                netTakeHome: year === 2026 ? 40_000 : 38_000,
            }),
        } as unknown as ReturnType<typeof useBelgianTaxProfile>);
        mockedYears.mockReturnValue([
            {
                year: 2026,
                isCurrent: true,
                hasSnapshot: false,
                hasTransactions: true,
                isFiled: false,
                hasFrozenCalculation: false,
            },
            {
                year: 2025,
                isCurrent: false,
                hasSnapshot: true,
                hasTransactions: true,
                isFiled: false,
                hasFrozenCalculation: true,
            },
        ]);
    });

    it('gives the comparison-year selector a localized accessible name', () => {
        render(<YearComparisonCard />);

        expect(screen.getByRole('combobox', { name: 'Compare with year' })).toBeInTheDocument();
    });
});
