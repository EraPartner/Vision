// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import PortfolioForecastPage from "./PortfolioForecastPage";

const { inputs } = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("@/features/research/useResearchQueries", () => ({
    usePortfolioForecastQuery: (input: unknown) => {
        inputs.push(input);
        return { data: undefined, isFetching: false, isError: false };
    },
}));

describe("PortfolioForecastPage locale inputs", () => {
    it("exposes selected options and supports adjusting the named blend slider with the keyboard", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioForecastPage />);
        const fiveYears = await screen.findByRole("radio", { name: "5Y" });
        expect(fiveYears).toHaveAttribute("aria-checked", "true");
        const oneYear = screen.getByRole("radio", { name: "1Y" });
        await user.click(oneYear);
        expect(oneYear).toHaveAttribute("aria-checked", "true");
        expect(fiveYears).toHaveAttribute("aria-checked", "false");
        await user.click(screen.getByText("Forecast assumptions"));
        expect(screen.getByRole("radio", { name: "1000" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await user.click(screen.getByRole("radio", { name: "500" }));
        expect(screen.getByRole("radio", { name: "500" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await user.click(screen.getByRole("radio", { name: /blended/i }));
        const slider = screen.getByRole("slider", { name: "Return blend" });
        expect(slider).toHaveAttribute(
            "aria-valuetext",
            "50% historical, 50% forward-looking",
        );
        await user.tab();
        expect(slider).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(slider).toHaveAttribute("aria-valuenow", "55");
        expect(slider).toHaveAttribute(
            "aria-valuetext",
            "45% historical, 55% forward-looking",
        );
        await waitFor(
            () =>
                expect(inputs.at(-1)).toMatchObject({
                    horizonMonths: 12,
                    paths: 500,
                    forwardBlend: 0.55,
                }),
            { timeout: 2000 },
        );
    });

    it("keeps assumptions collapsed initially and preserves changes in their visible summary", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioForecastPage />);
        const heading = await screen.findByText("Forecast assumptions");
        const disclosure = heading.closest("details")!;
        const summary = heading.closest("summary")!;
        expect(disclosure).not.toHaveAttribute("open");
        expect(screen.getByLabelText(/monthly contribution/i)).toBeVisible();
        expect(screen.getByLabelText(/target value/i)).toBeVisible();
        expect(summary).toHaveTextContent("Historical");
        await user.click(heading);
        await user.click(screen.getByRole("radio", { name: /blended/i }));
        const slider = screen.getByRole("slider", { name: "Return blend" });
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await user.click(screen.getByRole("radio", { name: /bootstrap/i }));
        await user.click(screen.getByRole("radio", { name: "2000" }));
        await user.click(heading);
        expect(disclosure).not.toHaveAttribute("open");
        expect(summary).toHaveTextContent(
            "45% historical, 55% forward-looking",
        );
        expect(summary).toHaveTextContent(/bootstrap/i);
        expect(summary).toHaveTextContent("2.000");
        expect(slider).not.toBeVisible();
        await waitFor(
            () =>
                expect(inputs.at(-1)).toMatchObject({
                    forwardBlend: 0.55,
                    method: "block_bootstrap",
                    paths: 2000,
                }),
            { timeout: 2000 },
        );
        await user.click(heading);
        expect(
            screen.getByRole("slider", { name: "Return blend" }),
        ).toHaveAttribute("aria-valuenow", "55");
        expect(screen.getByRole("radio", { name: "2000" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
    });

    it("parses EU grouped contribution and target values", async () => {
        inputs.length = 0;
        const user = userEvent.setup();
        renderWithApp(<PortfolioForecastPage />);

        const contribution =
            await screen.findByLabelText(/monthly contribution/i);
        const target = screen.getByLabelText(/target value/i);
        await user.type(contribution, "1.234");
        await user.type(target, "2.500");

        await waitFor(
            () =>
                expect(inputs.at(-1)).toMatchObject({
                    monthlyContribution: 1234,
                    targetValue: 2500,
                }),
            { timeout: 2000 },
        );
        expect(contribution).toHaveAttribute("type", "text");
        expect(contribution).toHaveAttribute("inputmode", "decimal");
        expect(target).toHaveAttribute("type", "text");
        expect(target).toHaveAttribute("inputmode", "decimal");
    });
});
