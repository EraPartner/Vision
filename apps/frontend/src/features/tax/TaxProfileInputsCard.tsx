import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
} from "@/lib/belgianTax";

type ProfileRow =
    | "employmentType"
    | "grossAnnualIncome"
    | "otherTaxableIncome"
    | "professionalExpenses"
    | "dependents"
    | "personalExemption"
    | "disabilityExemptions";

interface TaxProfileInputsCardProps {
    profile: BelgianTaxProfile;
    calculation: BelgianTaxCalculation;
    description: string;
    variant: "overview" | "portfolio";
    children?: ReactNode;
}

const OVERVIEW_PROFILE_ROWS = [
    "employmentType",
    "grossAnnualIncome",
    "otherTaxableIncome",
    "professionalExpenses",
    "dependents",
    "personalExemption",
    "disabilityExemptions",
] as const satisfies readonly ProfileRow[];

const PORTFOLIO_PROFILE_ROWS = [
    "employmentType",
    "grossAnnualIncome",
    "otherTaxableIncome",
    "personalExemption",
    "dependents",
    "disabilityExemptions",
] as const satisfies readonly ProfileRow[];

export function TaxProfileInputsCard({
    profile,
    calculation,
    description,
    variant,
    children,
}: TaxProfileInputsCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    const rows =
        variant === "overview" ? OVERVIEW_PROFILE_ROWS : PORTFOLIO_PROFILE_ROWS;

    const values: Record<ProfileRow, ReactNode> = {
        employmentType: (
            <Badge variant="secondary">
                {profile.employmentType.replaceAll("_", " ")}
            </Badge>
        ),
        grossAnnualIncome: (
            <span className="font-semibold tabular-nums">
                {fmt(profile.grossAnnualIncome)}
            </span>
        ),
        otherTaxableIncome: (
            <span className="font-semibold tabular-nums">
                {fmt(profile.otherTaxableIncome)}
            </span>
        ),
        professionalExpenses: (
            <span className="font-semibold tabular-nums">
                {profile.professionalExpenseMethod === "lump_sum"
                    ? t("tax.profile.field.professionalExpenses.lump")
                    : fmt(profile.actualProfessionalExpenses)}
            </span>
        ),
        dependents: (
            <span className="font-semibold">
                {profile.dependentChildren} {t("tax.profile.field.children")} /{" "}
                {profile.dependentOtherPersons} {t("tax.profile.field.others")}
            </span>
        ),
        personalExemption: (
            <span className="font-semibold tabular-nums">
                {fmt(calculation.personalExemptionAmount)}
            </span>
        ),
        disabilityExemptions: (
            <span className="font-semibold">
                {profile.isDisabled || profile.isSpouseDisabled
                    ? t("common.applied")
                    : t("common.none")}
            </span>
        ),
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.profile.currentInputs")}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {rows.map((row) => (
                    <div
                        key={row}
                        className="flex items-center justify-between text-sm"
                    >
                        <span className="text-muted-foreground">
                            {t(`tax.profile.field.${row}`)}
                        </span>
                        {values[row]}
                    </div>
                ))}
                {children}
            </CardContent>
        </Card>
    );
}
