// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IndicatorPeriodInput } from "../IndicatorPeriodInput";

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      key === "research.builder.indicatorPeriod"
        ? `Period for ${vars?.indicator} indicator`
        : key,
  }),
}));

describe("IndicatorPeriodInput", () => {
  it("has an indicator-specific accessible name without suppressing the global focus ring", () => {
    render(<IndicatorPeriodInput indicator="SMA" period={50} onChange={vi.fn()} />);

    const input = screen.getByRole("spinbutton", { name: "Period for SMA indicator" });
    expect(input).toHaveValue(50);
    expect(input.className.split(/\s+/)).not.toContain("outline-none");
  });
});
