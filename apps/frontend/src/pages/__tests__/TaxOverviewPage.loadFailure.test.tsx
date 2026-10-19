// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import logger from "@/lib/logger";
import TaxOverviewPage from "@/pages/TaxOverviewPage";

vi.mock("@/lib/belgianTax/loadHouseholdRuntime", () => ({
    loadHouseholdRuntime: vi.fn(() =>
        Promise.reject(new Error("Failed to fetch dynamically imported module")),
    ),
}));

describe("TaxOverviewPage when the household helpers fail to load", () => {
    it("shows an error instead of loading forever", async () => {
        const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
        renderWithApp(<TaxOverviewPage />);
        expect(
            await screen.findByText(/tax calculator could not be loaded/i),
        ).toBeInTheDocument();
        expect(screen.queryByText(/no tax profile yet/i)).not.toBeInTheDocument();
        errorSpy.mockRestore();
    });
});
