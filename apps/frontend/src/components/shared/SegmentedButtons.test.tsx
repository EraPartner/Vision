// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedButtons } from "./SegmentedButtons";

describe("SegmentedButtons", () => {
    it("renders the options as a segmented control and reports a new choice", () => {
        const onSelect = vi.fn();
        render(
            <SegmentedButtons
                aria-label="Range"
                options={["1M", "1Y"]}
                getKey={(option) => option}
                getLabel={(option) => option}
                isSelected={(option) => option === "1M"}
                onSelect={onSelect}
                buttonClassName="tabular-nums"
            />,
        );

        expect(screen.getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "1M" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute(
            "aria-checked",
            "false",
        );
        expect(screen.getByRole("radio", { name: "1Y" })).toHaveClass("tabular-nums");
        fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
        expect(onSelect).toHaveBeenCalledWith("1Y");
    });

    it("maps numeric keys back to their option", () => {
        const onSelect = vi.fn();
        const options = [{ months: 12 }, { months: 60 }];
        render(
            <SegmentedButtons
                aria-label="Horizon"
                options={options}
                getKey={(option) => option.months}
                getLabel={(option) => `${option.months}m`}
                isSelected={(option) => option.months === 12}
                onSelect={onSelect}
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: "60m" }));
        expect(onSelect).toHaveBeenCalledWith(options[1]);
    });
});
