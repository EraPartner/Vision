// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import NotFound from "@/pages/NotFound";

describe("NotFound (integration)", () => {
    it("renders 404 heading", async () => {
        renderWithApp(<NotFound />);
        const heading = await screen.findByRole("heading", { name: "404" });
        expect(heading).toBeInTheDocument();
        expect(heading).toHaveClass("font-display");
    });

    it("renders page-not-found message", async () => {
        renderWithApp(<NotFound />);
        expect(
            await screen.findByText(/page not found/i),
        ).toBeInTheDocument();
    });

    it("renders Back to Dashboard link", async () => {
        renderWithApp(<NotFound />);
        // Button renders as <a> via asChild + Link — role="link"
        expect(
            await screen.findByRole("link", { name: /back to dashboard/i }),
        ).toBeInTheDocument();
    });

    it("navigation links point to the dashboard, transactions, and import", async () => {
        renderWithApp(<NotFound />);
        const link = await screen.findByRole("link", { name: /back to dashboard/i });
        expect(link).toHaveAttribute("href", "/");
        expect(await screen.findByRole("link", { name: "Transactions" })).toHaveAttribute(
            "href",
            "/transactions",
        );
        expect(await screen.findByRole("link", { name: "Import / Export" })).toHaveAttribute(
            "href",
            "/import",
        );
    });

    it("renders description text", async () => {
        renderWithApp(<NotFound />);
        // notFound.description = "The page you are looking for does not exist."
        expect(
            await screen.findByText(/the page you are looking for does not exist/i),
        ).toBeInTheDocument();
    });
});
