// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { PortfolioNewsFeed } from "@/features/portfolio/PortfolioNewsFeed";

describe("PortfolioNewsFeed", () => {
    it("explains when holdings news will appear", async () => {
        renderWithApp(<PortfolioNewsFeed symbols={["AAPL"]} />);

        expect(
            await screen.findByText(/no recent news for your holdings.*provider has recent coverage/i),
        ).toBeInTheDocument();
    });
});
