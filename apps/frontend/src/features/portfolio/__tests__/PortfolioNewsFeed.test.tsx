// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { PortfolioNewsFeed } from "@/features/portfolio/PortfolioNewsFeed";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

describe("PortfolioNewsFeed", () => {
    it("explains when holdings news will appear", async () => {
        let requestedCount: string | null = null;
        server.use(http.get(`${API_BASE}/api/market/news`, ({ request }) => {
            requestedCount = new URL(request.url).searchParams.get("count");
            return ok({ items: [], total: 0 });
        }));
        renderWithApp(<PortfolioNewsFeed symbols={["AAPL"]} />);

        expect(
            await screen.findByText(/no recent news for your holdings.*provider has recent coverage/i),
        ).toBeInTheDocument();
        expect(requestedCount).toBe("6");
    });

    it("renders no more than six articles even if the backend over-delivers", async () => {
        const items = Array.from({ length: 7 }, (_, index) => ({
            title: `Article ${index + 1}`,
            link: `https://example.com/${index + 1}`,
            publisher: "Example",
            publishedAt: null,
            thumbnail: null,
            relatedSymbols: [],
        }));
        server.use(http.get(`${API_BASE}/api/market/news`, () => ok({ items, total: items.length })));

        renderWithApp(<PortfolioNewsFeed symbols={["AAPL"]} />);

        expect(await screen.findByText("Article 1")).toBeInTheDocument();
        expect(screen.getByText("Article 6")).toBeInTheDocument();
        expect(screen.queryByText("Article 7")).not.toBeInTheDocument();
    });
});
