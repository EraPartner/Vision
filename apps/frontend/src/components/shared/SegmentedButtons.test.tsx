// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedButtons } from "./SegmentedButtons";

describe("SegmentedButtons variants", () => {
  it("supports an outline unselected state and still selects options", () => {
    const onSelect = vi.fn();
    render(
      <SegmentedButtons
        options={["1M", "1Y"]}
        getKey={(option) => option}
        getLabel={(option) => option}
        isSelected={(option) => option === "1M"}
        onSelect={onSelect}
        unselectedVariant="outline"
      />,
    );

    expect(screen.getByRole("button", { name: "1M" })).toHaveClass("bg-primary");
    expect(screen.getByRole("button", { name: "1Y" })).toHaveClass("border-input/70");

    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    expect(onSelect).toHaveBeenCalledWith("1Y");
  });
});
