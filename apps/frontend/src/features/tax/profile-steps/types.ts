import type { BelgianTaxProfile } from "@/lib/belgianTax";

export type TaxProfile = BelgianTaxProfile;

export interface StepProps {
    profile: TaxProfile;
    updateProfile: (updates: Partial<TaxProfile>) => void;
}
