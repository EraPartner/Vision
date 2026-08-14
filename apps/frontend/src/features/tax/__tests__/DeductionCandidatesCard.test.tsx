// @vitest-environment jsdom
import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppSettingsProvider } from '@/contexts/AppSettingsContext';
import type { BelgianTaxProfile } from '@/lib/belgianTax';
import type { DeductionCandidatesResponse } from '@/lib/api/info';
import { DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY } from '@/lib/deductionCandidatesDismiss';
import DeductionCandidatesCard from '../DeductionCandidatesCard';

vi.mock('@/contexts/LanguageContext', () => ({
  LanguageProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        'tax.deductionCandidates.title': 'Suggested deductions from your transactions',
        'tax.deductionCandidates.confirm': 'Confirm',
        'tax.deductionCandidates.dismiss': 'Dismiss',
        'tax.deductionCandidates.applied': 'Applied',
        'tax.deductionCandidates.currentValue': 'Current profile value: {value}',
        'tax.deductionCandidates.fromCategories': 'from {count} categories',
        'tax.deductionCandidates.type.lifeInsurance': 'Life insurance premiums',
        'tax.deductionCandidates.type.alimony': 'Alimony paid',
        'tax.deductionCandidates.type.unionDues': 'Union dues',
      };
      let text = translations[key] ?? key;
      for (const [k, v] of Object.entries(vars ?? {})) {
        text = text.replace(`{${k}}`, String(v));
      }
      return text;
    },
    language: 'en',
    setLanguage: () => {},
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const updateProfile = vi.fn();
const profile = {
  taxYear: 2025,
  lifeInsurancePremiums: 250,
  alimonyPaid: 0,
} as unknown as BelgianTaxProfile;

vi.mock('@/contexts/BelgianTaxProfileContext', () => ({
  useBelgianTaxProfile: () => ({ profile, updateProfile }),
}));

const mockUseDeductionCandidates = vi.fn();
vi.mock('@/hooks/useDeductionCandidates', () => ({
  useDeductionCandidates: (year: number) => mockUseDeductionCandidates(year),
}));

function makeResponse(overrides?: Partial<DeductionCandidatesResponse>): DeductionCandidatesResponse {
  return {
    year: 2025,
    from: '2025-01-01',
    to: '2025-12-31',
    currency: 'EUR',
    byDeductionType: [
      {
        deductionType: 'lifeInsurance',
        total: 1200,
        categoryCount: 1,
        categories: [{ category: 'Insurance: Life', total: 1200, count: 12 }],
      },
      {
        deductionType: 'alimony',
        total: 3600,
        categoryCount: 2,
        categories: [
          { category: 'Family: Alimony', total: 3000, count: 10 },
          { category: 'Family: Support', total: 600, count: 2 },
        ],
      },
      // Not in the deduction-type → profile-field map: must be skipped.
      {
        deductionType: 'unknownType',
        total: 500,
        categoryCount: 1,
        categories: [{ category: 'Misc', total: 500, count: 1 }],
      },
      // Mapped but non-positive total: must be skipped.
      {
        deductionType: 'unionDues',
        total: 0,
        categoryCount: 1,
        categories: [{ category: 'Work: Union', total: 0, count: 1 }],
      },
    ],
    ...overrides,
  };
}

function renderCard() {
  return render(
    <AppSettingsProvider>
      <DeductionCandidatesCard />
    </AppSettingsProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mockUseDeductionCandidates.mockReturnValue({ data: makeResponse(), isLoading: false });
});

// Mapped positive groups render with their type label, formatted transaction
// total, contributing categories, and the current profile value; unmapped and
// zero-total groups are skipped.
test('renders mapped groups with labels, totals, categories, and current value', () => {
  renderCard();

  expect(screen.getByText('Suggested deductions from your transactions')).toBeInTheDocument();
  expect(screen.getByText('Life insurance premiums')).toBeInTheDocument();
  expect(screen.getByText('Alimony paid')).toBeInTheDocument();
  // Default app settings: 'eu' number format (de-DE) with 2 decimals.
  expect(screen.getAllByText(/1\.200,00/).length).toBeGreaterThan(0); // lifeInsurance total
  expect(screen.getByText(/3\.600,00/)).toBeInTheDocument(); // alimony total
  expect(screen.getByText('Insurance: Life')).toBeInTheDocument();
  expect(screen.getByText('Family: Alimony')).toBeInTheDocument();
  expect(screen.getByText('from 2 categories')).toBeInTheDocument();
  // Current value of the Confirm target (lifeInsurancePremiums: 250).
  expect(screen.getByText(/Current profile value: 250,00/)).toBeInTheDocument();
  // Skipped groups: unmapped type and total <= 0.
  expect(screen.queryByText('tax.deductionCandidates.type.unknownType')).not.toBeInTheDocument();
  expect(screen.queryByText('Union dues')).not.toBeInTheDocument();
});

// Confirm on a type WITH an eligibility flag writes amount + flag in one update
// and swaps the buttons for an Applied badge.
test('confirm writes amount field and eligibility flag for lifeInsurance', () => {
  renderCard();

  // Groups render in response order: lifeInsurance first.
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0]);

  expect(updateProfile).toHaveBeenCalledTimes(1);
  expect(updateProfile).toHaveBeenCalledWith({
    lifeInsurancePremiums: 1200,
    lifeInsuranceEligible: true,
  });
  expect(screen.getByText('Applied')).toBeInTheDocument();
});

// Confirm on a type WITHOUT an eligibility flag writes only the amount field.
test('confirm writes only the amount field for alimony', () => {
  renderCard();

  // alimony is the second rendered group.
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[1]);

  expect(updateProfile).toHaveBeenCalledTimes(1);
  expect(updateProfile).toHaveBeenCalledWith({ alimonyPaid: 3600 });
});

// Dismiss hides the group and persists {year, deductionType} to localStorage.
test('dismiss removes the group and persists the dismissal', () => {
  renderCard();

  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);

  expect(screen.queryByText('Life insurance premiums')).not.toBeInTheDocument();
  expect(screen.getByText('Alimony paid')).toBeInTheDocument();
  const stored = JSON.parse(
    window.localStorage.getItem(DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY) ?? '[]',
  );
  expect(stored).toEqual([{ year: 2025, deductionType: 'lifeInsurance' }]);
});

// A persisted dismissal for the viewed year hides the group on mount, but the
// same dismissal for a DIFFERENT year does not.
test('persisted dismissals are year-scoped', () => {
  window.localStorage.setItem(
    DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY,
    JSON.stringify([
      { year: 2025, deductionType: 'lifeInsurance' },
      { year: 2024, deductionType: 'alimony' },
    ]),
  );
  renderCard();

  expect(screen.queryByText('Life insurance premiums')).not.toBeInTheDocument(); // dismissed for 2025
  expect(screen.getByText('Alimony paid')).toBeInTheDocument(); // dismissed only for 2024
});

// No applicable groups → no card at all (no empty shell).
test('renders nothing when there are no applicable groups', () => {
  mockUseDeductionCandidates.mockReturnValue({
    data: makeResponse({ byDeductionType: [] }),
    isLoading: false,
  });
  const { container } = renderCard();
  expect(container.firstChild).toBeNull();
});

// Loading state also renders nothing.
test('renders nothing while loading', () => {
  mockUseDeductionCandidates.mockReturnValue({ data: undefined, isLoading: true });
  const { container } = renderCard();
  expect(container.firstChild).toBeNull();
});
