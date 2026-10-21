// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { CashFlowForecastDiagnostics } from "./CashFlowForecastDiagnostics";

vi.mock("./useDashboardQueries", () => ({
    useCashflowForecastAccuracy: () => ({ data: undefined }),
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
