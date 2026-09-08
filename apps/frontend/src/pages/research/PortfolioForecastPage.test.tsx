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
    it("parses EU grouped contribution and target values", async () => {
        inputs.length = 0;
        const user = userEvent.setup();
        renderWithApp(<PortfolioForecastPage />);

        const contribution = screen.getByLabelText(
            "research.forecast.monthlyContribution",
        );
        const target = screen.getByLabelText("research.forecast.targetValue");
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
