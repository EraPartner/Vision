// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";

describe("SegmentedControl", () => {
    it("is a radio group whose chosen segment is checked", () => {
        render(
            <SegmentedControl aria-label="Period" defaultValue="1y">
                <SegmentedControlItem value="1m">1M</SegmentedControlItem>
                <SegmentedControlItem value="1y">1Y</SegmentedControlItem>
            </SegmentedControl>,
        );
        expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "1Y" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(screen.getByRole("radio", { name: "1M" })).toHaveAttribute(
            "aria-checked",
            "false",
        );
    });

    it("reports a new choice and never clears the current one", () => {
        const onValueChange = vi.fn();
        render(
            <SegmentedControl aria-label="Period" value="1y" onValueChange={onValueChange}>
                <SegmentedControlItem value="1m">1M</SegmentedControlItem>
                <SegmentedControlItem value="1y">1Y</SegmentedControlItem>
            </SegmentedControl>,
        );
        fireEvent.click(screen.getByRole("radio", { name: "1Y" }));
        expect(onValueChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("radio", { name: "1M" }));
        expect(onValueChange).toHaveBeenCalledWith("1m");
    });

    it("uses the control radius and the 32px small size", () => {
        render(
            <SegmentedControl aria-label="Size" size="sm" defaultValue="a">
                <SegmentedControlItem value="a">A</SegmentedControlItem>
            </SegmentedControl>,
        );
        expect(screen.getByRole("radiogroup")).toHaveClass("h-8", "rounded-control");
    });
});
