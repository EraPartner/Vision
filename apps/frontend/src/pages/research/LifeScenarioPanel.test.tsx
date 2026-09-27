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
        await user.type(screen.getByLabelText("Scenario name"), "Income gap");
        await user.type(
            screen.getByLabelText("Baseline monthly surplus"),
            "900",
        );
        await user.type(screen.getByLabelText("Monthly income lost"), "700");
        await user.type(
            screen.getByLabelText("Planned monthly portfolio contribution"),
            "500",
        );
        await user.click(screen.getByRole("button", { name: "Save scenario" }));

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
        expect(screen.getByText("Scenario comparison")).toBeInTheDocument();
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
        await user.type(screen.getByLabelText("Scenario name"), "Dated goal");
        await user.type(
            screen.getByLabelText("Baseline monthly surplus"),
            "1000",
        );
        await user.type(screen.getByLabelText("Monthly income lost"), "500");
        await user.type(
            screen.getByLabelText("Planned monthly portfolio contribution"),
            "600",
        );
        await user.type(screen.getByLabelText("Savings goal amount"), "10000");
        const date = new Date();
        date.setMonth(date.getMonth() + 6);
        const goalDate = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
        ].join("-");
        fireEvent.change(screen.getByLabelText("Savings goal month"), {
            target: { value: goalDate },
        });
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
    it("preserves European decimal values after saving and selecting a saved scenario", async () => {
        const user = userEvent.setup();
        const view = renderWithApp(
            <LifeScenarioPanel
                forecastInput={{ horizonMonths: 12, currency: "EUR" }}
                currency="EUR"
                locale="nl-BE"
                numberFormat="eu"
            />,
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Save scenario" }),
            ).toBeEnabled(),
        );
        for (const [label, value] of [
            ["Scenario name", "Decimal scenario"],
            ["Baseline monthly surplus", "900,75"],
            ["Monthly income lost", "700,25"],
            ["Planned monthly portfolio contribution", "500,5"],
            ["Savings goal amount", "10000,25"],
        ]) {
            await user.type(screen.getByLabelText(label), value);
        }
        const date = new Date();
        date.setMonth(date.getMonth() + 6);
        fireEvent.change(screen.getByLabelText("Savings goal month"), {
            target: {
                value: [
                    date.getFullYear(),
                    String(date.getMonth() + 1).padStart(2, "0"),
                ].join("-"),
            },
        });
        await user.click(screen.getByRole("button", { name: "Save scenario" }));
        await waitFor(() => expect(saveSetting).toHaveBeenCalled());
        expect(screen.getByLabelText("Baseline monthly surplus")).toHaveValue(
            "900,75",
        );
        const saved = saveSetting.mock.calls[0][1][0];
        expect(saved).toMatchObject({
            monthlySurplus: 900.75,
            monthlyIncomeLoss: 700.25,
            monthlyContribution: 500.5,
            goalValue: 10000.25,
        });
        view.unmount();
        getSetting.mockResolvedValue({ key: "life_scenarios", value: [saved] });
        renderWithApp(
            <LifeScenarioPanel
                forecastInput={{ horizonMonths: 12, currency: "EUR" }}
                currency="EUR"
                locale="nl-BE"
                numberFormat="eu"
            />,
        );
        await screen.findByRole("option", { name: "Decimal scenario" });
        await user.selectOptions(screen.getByRole("combobox"), saved.id);
        expect(screen.getByLabelText("Baseline monthly surplus")).toHaveValue(
            "900,75",
        );
        expect(screen.getByLabelText("Monthly income lost")).toHaveValue(
            "700,25",
        );
        expect(
            screen.getByLabelText("Planned monthly portfolio contribution"),
        ).toHaveValue("500,5");
        expect(screen.getByLabelText("Savings goal amount")).toHaveValue(
            "10000,25",
        );
        await user.click(
            screen.getByRole("button", { name: "Compare scenarios" }),
        );
        await waitFor(() =>
            expect(getPortfolioForecast).toHaveBeenCalledTimes(2),
        );
        expect(getPortfolioForecast.mock.calls[0][0]).toMatchObject({
            monthlyContribution: 500.5,
            targetValue: 10000.25,
        });
        expect(
            getPortfolioForecast.mock.calls[1][0].monthlyContributionSchedule,
        ).toEqual([200.5, 200.5, 200.5]);
    });

    it("retries saved scenarios without discarding the draft or enabling save before recovery", async () => {
        const user = userEvent.setup();
        getSetting.mockRejectedValueOnce(new Error("Unavailable"));
        renderWithApp(
            <LifeScenarioPanel
                forecastInput={{ horizonMonths: 12, currency: "EUR" }}
                currency="EUR"
                locale="en-US"
                numberFormat="us"
            />,
        );
        const retry = await screen.findByRole("button", { name: "Retry" });
        await user.type(
            screen.getByLabelText("Scenario name"),
            "Keep my draft",
        );
        await user.type(
            screen.getByLabelText("Baseline monthly surplus"),
            "900",
        );
        expect(
            screen.getByRole("button", { name: "Save scenario" }),
        ).toBeDisabled();
        let recover!: (value: { key: string; value: unknown[] }) => void;
        getSetting.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    recover = resolve;
                }),
        );
        await user.click(retry);
        expect(retry).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Save scenario" }),
        ).toBeDisabled();
        expect(screen.getByLabelText("Scenario name")).toHaveValue(
            "Keep my draft",
        );
        recover({ key: "life_scenarios", value: [] });
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Retry" }),
            ).not.toBeInTheDocument(),
        );
        expect(
            screen.getByRole("button", { name: "Save scenario" }),
        ).toBeEnabled();
        expect(screen.getByLabelText("Scenario name")).toHaveValue(
            "Keep my draft",
        );
        expect(screen.getByLabelText("Baseline monthly surplus")).toHaveValue(
            "900",
        );
        expect(saveSetting).not.toHaveBeenCalled();
    });
});
