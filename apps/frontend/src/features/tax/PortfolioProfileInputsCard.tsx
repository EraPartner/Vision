import { useLanguage } from "@/contexts/LanguageContext";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
} from "@/lib/belgianTax";
import { TaxProfileInputsCard } from "./TaxProfileInputsCard";

interface PortfolioProfileInputsCardProps {
    profile: BelgianTaxProfile;
    calculation: BelgianTaxCalculation;
}

/** Profile inputs summary of the portfolio-tax page ("profileInputs" widget). */
export function PortfolioProfileInputsCard({
    profile,
    calculation,
}: PortfolioProfileInputsCardProps) {
    const { t } = useLanguage();
    return (
        <TaxProfileInputsCard
            profile={profile}
            calculation={calculation}
            description={t("tax.portfolioProfileInputsDesc")}
            variant="portfolio"
        />
    );
}
