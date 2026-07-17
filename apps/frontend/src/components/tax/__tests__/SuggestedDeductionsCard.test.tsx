// @vitest-environment jsdom
import React from 'react';
import { expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BelgianTaxProfileProvider } from '@/contexts/BelgianTaxProfileContext';
import { AppSettingsProvider } from '@/contexts/AppSettingsContext';
import SuggestedDeductionsCard from '../SuggestedDeductionsCard';

vi.mock('@/contexts/LanguageContext', () => ({
  LanguageProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLanguage: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'tax.suggestions.title': 'Possible deductions / credits you may qualify for',
      };
      return translations[key] ?? key;
    },
    language: 'en',
    setLanguage: () => {},
  }),
}));

test('renders suggestions card with content', () => {
  render(
    <AppSettingsProvider>
      <BelgianTaxProfileProvider>
        <SuggestedDeductionsCard />
      </BelgianTaxProfileProvider>
    </AppSettingsProvider>
  );
  expect(screen.getByText(/Possible deductions/i)).toBeInTheDocument();
});
