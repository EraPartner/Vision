// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChartPeriodSelector } from "@/components/charts/ChartPeriodSelector";

const PERIODS = ["1m", "3m", "all"] as const;
const LABELS = { "1m": "1M", "3m": "3M", all: "All" } as const;

describe("ChartPeriodSelector", () => {
    it("uses native toggle-button semantics and reports selection changes", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();

        render(
            <ChartPeriodSelector
                periods={PERIODS}
                value="3m"
                onChange={onChange}
                labels={LABELS}
            />,
        );

        expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
        expect(screen.queryByRole("tab")).not.toBeInTheDocument();

        const oneMonth = screen.getByRole("button", { name: "1M" });
        const threeMonths = screen.getByRole("button", { name: "3M" });
        const all = screen.getByRole("button", { name: "All" });
        expect(oneMonth).toHaveAttribute("aria-pressed", "false");
        expect(threeMonths).toHaveAttribute("aria-pressed", "true");
        expect(all).toHaveAttribute("aria-pressed", "false");
        expect(oneMonth).toHaveClass("min-h-10", "min-w-10");

        await user.click(all);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith("all");
    });
});
