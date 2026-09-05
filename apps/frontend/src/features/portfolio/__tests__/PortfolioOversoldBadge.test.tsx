// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { PortfolioOversoldBadge } from "@/features/portfolio/PortfolioOversoldBadge";

describe("PortfolioOversoldBadge", () => {
    it("stays hidden for a valid position", () => {
        renderWithApp(<PortfolioOversoldBadge oversold={false} />);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("names the repair action for an oversold broker partition", () => {
        renderWithApp(<PortfolioOversoldBadge oversold />);
        expect(screen.getByRole("status")).toHaveAccessibleName(
            /oversold broker.*reassign the affected transactions/i,
        );
    });
});
