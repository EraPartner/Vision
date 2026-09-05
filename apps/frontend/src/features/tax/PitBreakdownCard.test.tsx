// @vitest-environment jsdom

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PitBreakdownCard } from "@/features/tax/PitBreakdownCard";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";
import { renderWithApp } from "@/test/renderWithApp";

const calculation = {
    taxableIncome: 1,
    federalPITBracket1: 2,
    federalPITBracket2: 3,
    federalPITBracket3: 4,
    federalPITBracket4: 5,
    federalPITBeforeExemption: 111,
    federalPITTotal: 222,
    personalExemptionBenefit: 6,
    federalTaxCredits: 7,
    federalPITAfterReductions: 8,
    communalSurcharge: 9,
    specialSocialSecurityContribution: 10,
    totalPIT: 11,
    propertyTaxEstimate: 12,
} as BelgianTaxCalculation;

describe("PitBreakdownCard", () => {
    it("renders the canonical federal PIT before-exemption field, not its deprecated alias", async () => {
        renderWithApp(
            <PitBreakdownCard
                calculation={calculation}
                portfolioTaxesForYear={13}
                totalTaxIncludingPortfolio={14}
                totalTaxIncludingPropertyEstimate={15}
                viewedYear={2026}
            />,
        );

        const label = await screen.findByText(
            /federal pit \(before reductions\)/i,
        );
        const row = label.closest("tr") as HTMLTableRowElement;
        expect(within(row).getByText(/111,00/)).toBeInTheDocument();
        expect(within(row).queryByText(/222,00/)).not.toBeInTheDocument();
    });

    it("uses signed money for reductions and leaves a zero reduction unsigned", async () => {
        renderWithApp(
            <PitBreakdownCard
                calculation={{ ...calculation, federalTaxCredits: 0 }}
                portfolioTaxesForYear={13}
                totalTaxIncludingPortfolio={14}
                totalTaxIncludingPropertyEstimate={15}
                viewedYear={2026}
            />,
        );

        const exemptionRow = (
            await screen.findByText(/belastingsvrije som benefit/i)
        ).closest("tr") as HTMLTableRowElement;
        const creditsRow = (
            await screen.findByText(/federal tax credits/i)
        ).closest("tr") as HTMLTableRowElement;
        expect(within(exemptionRow).getByText(/\+6,00/)).toBeInTheDocument();
        expect(within(creditsRow).getByText(/^0,00/)).toBeInTheDocument();
        expect(
            within(creditsRow).queryByText(/\+0,00/),
        ).not.toBeInTheDocument();
    });
});
