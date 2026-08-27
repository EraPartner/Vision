// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResearchRangeSelector } from "@/components/charts/ResearchRangeSelector";
import { renderWithApp } from "@/test/renderWithApp";

const OPTIONS = [
    { label: "1M", range: "1mo" as const, interval: "1d" },
    { label: "1Y", range: "1y" as const, interval: "1wk" },
];

describe("ResearchRangeSelector", () => {
    it("uses the shared period control with localized labels", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithApp(
            <ResearchRangeSelector
                options={OPTIONS}
                value="1mo"
                onChange={onChange}
            />,
        );

        const month = await screen.findByRole("button", { name: "1m" });
        const year = screen.getByRole("button", { name: "1y" });
        expect(month).toHaveAttribute("aria-pressed", "true");

        await user.click(year);
        expect(onChange).toHaveBeenCalledWith(OPTIONS[1]);
    });
});
