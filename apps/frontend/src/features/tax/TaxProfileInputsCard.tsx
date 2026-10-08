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
import { KeyValueRows, type KeyValueRow } from "./KeyValueRows";

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
    /** Extra rows appended below the profile inputs (derived figures). */
    extraRows?: KeyValueRow[];
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
    extraRows = [],
    children,
}: TaxProfileInputsCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    const rowKeys =
        variant === "overview" ? OVERVIEW_PROFILE_ROWS : PORTFOLIO_PROFILE_ROWS;

    const values: Record<ProfileRow, ReactNode> = {
        employmentType: (
            <Badge variant="secondary">
                {t(`tax.profile.employment.${profile.employmentType}.label`)}
            </Badge>
        ),
        grossAnnualIncome: fmt(profile.grossAnnualIncome),
        otherTaxableIncome: fmt(profile.otherTaxableIncome),
        professionalExpenses:
            profile.professionalExpenseMethod === "lump_sum"
                ? t("tax.profile.field.professionalExpenses.lump")
                : fmt(profile.actualProfessionalExpenses),
        dependents: `${profile.dependentChildren} ${t("tax.profile.field.children")} / ${profile.dependentOtherPersons} ${t("tax.profile.field.others")}`,
        personalExemption: fmt(calculation.personalExemptionAmount),
        disabilityExemptions:
            profile.isDisabled || profile.isSpouseDisabled
                ? t("common.applied")
                : t("common.none"),
    };

    const rows: KeyValueRow[] = [
        ...rowKeys.map((row) => ({
            key: row,
            label: t(`tax.profile.field.${row}`),
            value: values[row],
        })),
        ...extraRows,
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.profile.currentInputs")}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
                <KeyValueRows rows={rows} />
                {children}
            </CardContent>
        </Card>
    );
}
