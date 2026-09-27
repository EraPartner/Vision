// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { CashFlowForecastChart } from "./CashFlowForecastChart";

const state = vi.hoisted(() => ({ ensembleError: false }));
vi.mock("./useDashboardQueries", () => ({
    useCashflowForecastQueries: () => {
        const data = {
            month: "2026-09",
            currency: "EUR",
            methods: [
                {
                    id: "simple_avg",
                    label: "Simple average",
                    daily: [{ date: "2026-09-26", value: 10 }],
                    error: null,
                },
                {
                    id: "ensemble_imse",
                    label: "Combined forecast",
                    daily: [{ date: "2026-09-26", value: 12 }],
                    error: state.ensembleError ? "unavailable" : null,
                },
            ],
        };
        return {
            monthQuery: { data },
            rollingQuery: { data },
            rollingDiagnosticsQuery: {},
        };
    },
}));
vi.mock("./ForecastInner", () => ({
    ForecastInner: ({
        visibleMethodIds,
    }: {
        visibleMethodIds: Set<string>;
    }) => (
        <output data-testid="visible-methods">
            {[...visibleMethodIds].join(",")}
        </output>
    ),
}));
vi.mock("./ForecastInnerRolling", () => ({ ForecastInnerRolling: () => null }));
vi.mock("./CashFlowForecastDiagnostics", () => ({
    CashFlowForecastDiagnostics: () => null,
}));

describe("forecast comparison controls", () => {
    it("labels rolling windows and updates their selected state", async () => {
        state.ensembleError = false;
        renderWithApp(<CashFlowForecastChart />, {
            initialEntries: ["/?forecastMode=rolling"],
        });
        const ninetyDays = await screen.findByRole("button", {
            name: "90 days",
        });
        expect(ninetyDays).toHaveAttribute("aria-pressed", "true");
        for (const days of [30, 60, 180]) {
            expect(
                screen.getByRole("button", { name: `${days} days` }),
            ).toHaveAttribute("aria-pressed", "false");
        }
        fireEvent.click(screen.getByRole("button", { name: "30 days" }));
        expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(ninetyDays).toHaveAttribute("aria-pressed", "false");
        expect(
            screen.getByText("Past 30 days actual + next 30 days forecast"),
        ).toBeInTheDocument();
    });

    it("starts with the combined forecast and lets users compare or hide methods", async () => {
        state.ensembleError = false;
        renderWithApp(<CashFlowForecastChart />);
        expect(screen.getByTestId("visible-methods")).toHaveTextContent(
            /^ensemble_imse$/,
        );
        const summary = await screen.findByText("Compare forecast methods");
        expect(summary.closest("details")).not.toHaveAttribute("open");
        fireEvent.click(summary);
        const simple = screen.getByRole("button", { name: "Simple average" });
        expect(simple).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(simple);
        expect(simple).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByTestId("visible-methods")).toHaveTextContent(
            "simple_avg",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Combined forecast" }),
        );
        expect(screen.getByTestId("visible-methods")).toHaveTextContent(
            /^simple_avg$/,
        );
    });

    it("falls back to an available forecast when the combined method fails", async () => {
        state.ensembleError = true;
        renderWithApp(<CashFlowForecastChart />);
        await screen.findByText("Compare forecast methods");
        expect(screen.getByTestId("visible-methods")).toHaveTextContent(
            /^simple_avg$/,
        );
    });
});
