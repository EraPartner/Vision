// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import NotFound from "@/pages/NotFound";

describe("NotFound (integration)", () => {
    it("renders 404 heading", async () => {
        renderWithApp(<NotFound />);
        expect(
            await screen.findByRole("heading", { name: "404" }),
        ).toBeInTheDocument();
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

    it("Back to Dashboard link points to root path", async () => {
        renderWithApp(<NotFound />);
        const link = await screen.findByRole("link", { name: /back to dashboard/i });
        expect(link).toHaveAttribute("href", "/");
    });

    it("renders description text", async () => {
        renderWithApp(<NotFound />);
        // notFound.description = "The page you are looking for does not exist."
        expect(
            await screen.findByText(/the page you are looking for does not exist/i),
        ).toBeInTheDocument();
    });
});
