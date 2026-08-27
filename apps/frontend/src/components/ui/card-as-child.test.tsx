// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Link, MemoryRouter } from "react-router";
import { Card } from "@/components/ui/card";

describe("Card asChild", () => {
    it("renders one anchor carrying the interactive card treatment", () => {
        render(
            <MemoryRouter>
                <Card asChild variant="interactive">
                    <Link to="/research/market">Market</Link>
                </Card>
            </MemoryRouter>,
        );
        const link = screen.getByRole("link", { name: "Market" });
        expect(link).toHaveAttribute("href", "/research/market");
        expect(link).toHaveClass("premium-frame-interactive");
        expect(link.parentElement?.querySelectorAll("a")).toHaveLength(1);
    });
});
