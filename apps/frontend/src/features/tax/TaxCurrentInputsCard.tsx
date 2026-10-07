import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
} from "@/lib/belgianTax";
import { TaxProfileInputsCard } from "./TaxProfileInputsCard";

interface TaxCurrentInputsCardProps {
    profile: BelgianTaxProfile;
    calculation: BelgianTaxCalculation;
}

/** Profile inputs + derived burden summary of the overview page. */
export function TaxCurrentInputsCard({
    profile,
    calculation,
}: TaxCurrentInputsCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    return (
        <TaxProfileInputsCard
            profile={profile}
            calculation={calculation}
            description={t("tax.profile.currentInputs.desc")}
            variant="overview"
            extraRows={[
                {
                    key: "federalAfter",
                    label: t("tax.pit.row.federalAfter"),
                    value: fmt(calculation.federalPITAfterReductions),
                    tone: "text-loss",
                    emphasis: true,
                },
                {
                    key: "communalSurcharge",
                    label: t("tax.pit.row.communalSurcharge"),
                    value: fmt(calculation.communalSurcharge),
                    tone: "text-loss",
                },
                {
                    key: "employeeSS",
                    label: t("tax.pit.row.employeeSS"),
                    value: fmt(calculation.employeeSocialSecurity),
                    tone: "text-loss",
                },
                {
                    key: "specialSS",
                    label: t("tax.pit.row.specialSS"),
                    value: fmt(calculation.specialSocialSecurityContribution),
                    tone: "text-loss",
                },
                {
                    key: "totalBurden",
                    label: t("tax.pit.row.totalBurden"),
                    value: fmt(calculation.totalTaxBurden),
                    tone: "text-primary",
                    emphasis: true,
                },
            ]}
        />
    );
}
