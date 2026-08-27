// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({
        t: (key: string) =>
            ({
                'tax.yearSwitcher.filedAria': 'Filed year',
                'tax.yearSwitcher.frozenAria': 'Frozen calculation',
            })[key] ?? key,
    }),
}));

import { TaxYearStatusIcon } from '../TaxYearStatusIcon';

describe('TaxYearStatusIcon', () => {
    it('gives filed status precedence when both flags are set', () => {
        render(<TaxYearStatusIcon isFiled hasFrozenCalculation />);

        expect(screen.getByLabelText('Filed year')).toHaveClass('lucide-lock');
        expect(screen.queryByLabelText('Frozen calculation')).not.toBeInTheDocument();
    });

    it('renders the frozen marker for an unfiled frozen calculation', () => {
        render(<TaxYearStatusIcon hasFrozenCalculation />);

        expect(screen.getByLabelText('Frozen calculation')).toHaveClass('lucide-snowflake');
    });

    it('renders nothing when the year has no persisted status', () => {
        const { container } = render(<TaxYearStatusIcon />);

        expect(container).toBeEmptyDOMElement();
    });
});
