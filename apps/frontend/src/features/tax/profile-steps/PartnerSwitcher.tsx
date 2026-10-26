import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type {
    BelgianTaxHouseholdV2,
    PartnerId,
} from "@/lib/belgianTax/householdTypes";
import { partnerLabel } from "./householdEditing";

interface PartnerSwitcherProps {
    household: BelgianTaxHouseholdV2;
    value: PartnerId;
    onValueChange: (id: PartnerId) => void;
}

/** Picks the partner a step edits; renders nothing for a one-partner household. */
export function PartnerSwitcher({
    household,
    value,
    onValueChange,
}: PartnerSwitcherProps) {
    const { t } = useLanguage();
    if (household.partners.length < 2) return null;
    return (
        <SegmentedControl
            value={value}
            onValueChange={(next) => {
                const partner = household.partners.find(
                    (candidate) => candidate.id === next,
                );
                if (partner) onValueChange(partner.id);
            }}
            aria-label={t("tax.household.partnerPicker")}
            className="w-full"
        >
            {household.partners.map((partner) => (
                <SegmentedControlItem
                    key={partner.id}
                    value={partner.id}
                    className="flex-1"
                >
                    {partnerLabel(t, partner)}
                </SegmentedControlItem>
            ))}
        </SegmentedControl>
    );
}
