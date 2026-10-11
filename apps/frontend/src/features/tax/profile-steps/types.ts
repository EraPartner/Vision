import type { BelgianTaxProfile } from "@/lib/belgianTax";
import type { BelgianTaxHouseholdV2, PartnerId } from "@/lib/belgianTax/householdTypes";
import type { HouseholdUpdate } from "@/stores/belgianTaxStore";

export type TaxProfile = BelgianTaxProfile;

export interface StepProps {
    profile: TaxProfile;
    updateProfile: (updates: Partial<TaxProfile>) => void;
}

/** Props of the steps that edit the household (ADR-200) rather than the v1 projection. */
export interface HouseholdStepProps {
    household: BelgianTaxHouseholdV2;
    updateHousehold: (update: HouseholdUpdate) => void;
    /** Popover container inside the sheet, for date pickers. */
    portalContainer?: HTMLElement | null;
}

/** Household steps that edit one partner at a time. */
export interface PartnerStepProps extends HouseholdStepProps {
    partnerId: PartnerId;
    onPartnerChange: (id: PartnerId) => void;
}
