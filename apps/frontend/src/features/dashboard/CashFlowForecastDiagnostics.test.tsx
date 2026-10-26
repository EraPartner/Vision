// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { CashFlowForecastDiagnostics } from "./CashFlowForecastDiagnostics";

const mocks = vi.hoisted(
    (): { accuracy: { data: unknown }; sparklineData: number[][] } => ({
        accuracy: { data: undefined },
        sparklineData: [],
    }),
);

vi.mock("./useDashboardQueries", () => ({
    useCashflowForecastAccuracy: () => mocks.accuracy,
}));

vi.mock("@/components/charts/Sparkline", () => ({
    Sparkline: ({ data }: { data: number[] }) => {
        mocks.sparklineData.push([...data]);
        return null;
    },
}));

function Harness() {
    const [open, setOpen] = useState(true);
    return (
        <CashFlowForecastDiagnostics
            open={open}
            onOpenChange={setOpen}
            diagnostics={{ history_months: 36, backtest: [] }}
            currency="EUR"
        />
    );
}

describe("forecast diagnostics sheet", () => {
    it("leaves persisted months without a measured MAE out of the MAE trend", async () => {
        mocks.sparklineData.length = 0;
        mocks.accuracy = {
            data: {
                limit_months: 12,
                methods: [
                    {
                        method_id: "ewma",
                        as_of_month: "2026-03",
                        mae: 10,
                        rmse: 12,
                        mape: null,
                        sample_days: 30,
                        history: [
                            { month: "2026-01", mae: 10, rmse: 12, mape: null, sample_days: 30 },
                            { month: "2026-02", mae: null, rmse: null, mape: null, sample_days: null },
                            { month: "2026-03", mae: 14, rmse: 15, mape: null, sample_days: 30 },
                        ],
                    },
                ],
            },
        };
        renderWithApp(
            <CashFlowForecastDiagnostics
                open
                onOpenChange={() => undefined}
                diagnostics={{
                    history_months: 36,
                    backtest: [
                        {
                            method_id: "ewma",
                            label: "EWMA",
                            mae: 10,
                            rmse: 12,
                            mape: null,
                            months: 3,
                            per_month: [],
                        },
                    ],
                }}
                currency="EUR"
            />,
        );
        await screen.findByRole("dialog", { name: "Forecast diagnostics" });
        expect(mocks.sparklineData.at(-1)).toEqual([10, 14]);
        mocks.accuracy = { data: undefined };
    });

    it("closes from the close button", async () => {
        renderWithApp(<Harness />);
        expect(
            await screen.findByRole("dialog", { name: "Forecast diagnostics" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });
});
