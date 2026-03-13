import React from 'react';
import { render, screen } from '@testing-library/react';
import { BelgianTaxProfileProvider } from '@/contexts/BelgianTaxProfileContext';
import SuggestedDeductionsCard from '../SuggestedDeductionsCard';

test('renders suggestions card with content', () => {
  render(
    <BelgianTaxProfileProvider>
      <SuggestedDeductionsCard />
    </BelgianTaxProfileProvider>
  );
  expect(screen.getByText(/Possible deductions/i)).toBeInTheDocument();
});
