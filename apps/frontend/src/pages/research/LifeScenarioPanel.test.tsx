// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import LifeScenarioPanel from "./LifeScenarioPanel";

const { getSetting, saveSetting, getPortfolioForecast } = vi.hoisted(() => ({
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
    getPortfolioForecast: vi.fn(),
}));

vi.mock("@/lib/api/settings", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api/settings")>()),
    getSetting,
    saveSetting,
}));
vi.mock("@/lib/api/research", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api/research")>()),
    getPortfolioForecast,
}));

describe("LifeScenarioPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSetting.mockResolvedValue({ key: "life_scenarios", value: [] });
        saveSetting.mockImplementation(async (_key, value) => ({
            key: "life_scenarios",
            value,
        }));
        getPortfolioForecast.mockResolvedValue({
            data: {
                available: true,
                projected: { p10: 600, p50: 1000, p90: 1400 },
                probTarget: 0.4,
            },
        });
    });

    it("saves a three-month interruption and compares matched forecast paths", async () => {
        const user = userEvent.setup();
        const view = renderWithApp(
            <LifeScenarioPanel
                forecastInput={{
                    horizonMonths: 12,
                    method: "parametric",
                    paths: 500,
                    currency: "EUR",
                }}
                currency="EUR"
                locale="en-US"
                numberFormat="us"
            />,
        );

        await waitFor(() =>
            expect(getSetting).toHaveBeenCalledWith("life_scenarios"),
        );
        await user.type(
            screen.getByLabelText("Scenario name"),
            "Income gap",
        );
        await user.type(
            screen.getByLabelText("Baseline monthly surplus"),
            "900",
        );
        await user.type(
            screen.getByLabelText("Monthly income lost"),
            "700",
        );
        await user.type(
            screen.getByLabelText("Planned monthly portfolio contribution"),
            "500",
        );
        await user.click(
            screen.getByRole("button", { name: "Save scenario" }),
        );

        await waitFor(() =>
            expect(saveSetting).toHaveBeenCalledWith("life_scenarios", [
                expect.objectContaining({
                    name: "Income gap",
                    kind: "income_interruption",
                    interruptionMonths: 3,
                    monthlySurplus: 900,
                    monthlyIncomeLoss: 700,
                    monthlyContribution: 500,
                }),
            ]),
        );
        await user.click(
            screen.getByRole("button", { name: "Compare scenarios" }),
        );

        await waitFor(() =>
            expect(getPortfolioForecast).toHaveBeenCalledTimes(2),
        );
        const baseline = getPortfolioForecast.mock.calls[0][0];
        const interruption = getPortfolioForecast.mock.calls[1][0];
        expect(baseline).toMatchObject({
            monthlyContribution: 500,
            horizonMonths: 12,
        });
        expect(baseline.monthlyContributionSchedule).toBeUndefined();
        expect(interruption.monthlyContributionSchedule).toEqual([
            200, 200, 200,
        ]);
        expect(interruption.seed).toBe(baseline.seed);
        expect(
            screen.getByText("Scenario comparison"),
        ).toBeInTheDocument();
        view.rerender(
            <LifeScenarioPanel
                forecastInput={{
                    horizonMonths: 24,
                    method: "parametric",
                    paths: 500,
                    currency: "EUR",
                }}
                currency="EUR"
                locale="en-US"
                numberFormat="us"
            />,
        );
        expect(
            screen.queryByText("Scenario comparison"),
        ).not.toBeInTheDocument();
    });

    it("passes a dated goal month to both forecasts", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <LifeScenarioPanel
                forecastInput={{ horizonMonths: 12, currency: "EUR" }}
                currency="EUR"
                locale="en-US"
                numberFormat="us"
            />,
        );
        await user.type(
            screen.getByLabelText("Scenario name"),
            "Dated goal",
        );
        await user.type(
            screen.getByLabelText("Baseline monthly surplus"),
            "1000",
        );
        await user.type(
            screen.getByLabelText("Monthly income lost"),
            "500",
        );
        await user.type(
            screen.getByLabelText("Planned monthly portfolio contribution"),
            "600",
        );
        await user.type(
            screen.getByLabelText("Savings goal amount"),
            "10000",
        );
        const date = new Date();
        date.setMonth(date.getMonth() + 6);
        const goalDate = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
        ].join("-");
        fireEvent.change(
            screen.getByLabelText("Savings goal month"),
            { target: { value: goalDate } },
        );
        await user.click(
            screen.getByRole("button", { name: "Compare scenarios" }),
        );

        await waitFor(() =>
            expect(getPortfolioForecast).toHaveBeenCalledTimes(2),
        );
        expect(getPortfolioForecast.mock.calls[0][0]).toMatchObject({
            targetValue: 10000,
            goalMonth: 6,
        });
        expect(getPortfolioForecast.mock.calls[1][0]).toMatchObject({
            targetValue: 10000,
            goalMonth: 6,
        });
    });
});
