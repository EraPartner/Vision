import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
} from "@/lib/belgianTax";
import { Separator } from "@/components/ui/separator";
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
        >
            <Separator />
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {t("tax.pit.row.federalAfter")}
                </span>
                <span className="font-semibold tabular-nums text-loss">
                    {fmt(calculation.federalPITAfterReductions)}
                </span>
            </div>
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {t("tax.pit.row.communalSurcharge")}
                </span>
                <span className="font-semibold tabular-nums text-loss">
                    {fmt(calculation.communalSurcharge)}
                </span>
            </div>
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {t("tax.pit.row.employeeSS")}
                </span>
                <span className="font-semibold tabular-nums text-loss">
                    {fmt(calculation.employeeSocialSecurity)}
                </span>
            </div>
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {t("tax.pit.row.specialSS")}
                </span>
                <span className="font-semibold tabular-nums text-loss">
                    {fmt(calculation.specialSocialSecurityContribution)}
                </span>
            </div>
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {t("tax.pit.row.totalBurden")}
                </span>
                <span className="font-bold tabular-nums text-primary">
                    {fmt(calculation.totalTaxBurden)}
                </span>
            </div>
        </TaxProfileInputsCard>
    );
}
