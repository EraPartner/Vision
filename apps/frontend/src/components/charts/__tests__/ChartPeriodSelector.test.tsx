// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChartPeriodSelector } from "@/components/charts/ChartPeriodSelector";

const PERIODS = ["1m", "3m", "all"] as const;
const LABELS = { "1m": "1M", "3m": "3M", all: "All" } as const;

describe("ChartPeriodSelector", () => {
    it("is a segmented control (radio group) and reports selection changes", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();

        render(
            <ChartPeriodSelector
                periods={PERIODS}
                value="3m"
                onChange={onChange}
                labels={LABELS}
                aria-label="Period"
            />,
        );

        expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
        expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();

        const oneMonth = screen.getByRole("radio", { name: "1M" });
        const threeMonths = screen.getByRole("radio", { name: "3M" });
        const all = screen.getByRole("radio", { name: "All" });
        expect(oneMonth).toHaveAttribute("aria-checked", "false");
        expect(threeMonths).toHaveAttribute("aria-checked", "true");
        expect(all).toHaveAttribute("aria-checked", "false");

        await user.click(all);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith("all");

        // Clicking the chosen segment never clears the selection.
        await user.click(threeMonths);
        expect(onChange).toHaveBeenCalledOnce();
    });
});
