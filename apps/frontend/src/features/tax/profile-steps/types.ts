import type { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';

export type TaxProfile = ReturnType<typeof useBelgianTaxProfile>['profile'];

export interface StepProps {
    profile: TaxProfile;
    updateProfile: (updates: Partial<TaxProfile>) => void;
}
