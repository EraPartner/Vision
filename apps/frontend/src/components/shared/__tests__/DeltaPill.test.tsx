// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeltaPill } from "@/components/shared/DeltaPill";

describe("DeltaPill", () => {
    it("maps positive, negative, and zero deltas to direction and tone", () => {
        const { container, rerender } = render(
            <DeltaPill value={3.2} label="+3.2%" />,
        );
        expect(screen.getByText("+3.2%")).toHaveClass("text-gain");
        expect(
            container.querySelector(".lucide-arrow-up-right"),
        ).toBeInTheDocument();

        rerender(<DeltaPill value={-3.2} label="-3.2%" />);
        expect(screen.getByText("-3.2%")).toHaveClass("text-loss");
        expect(
            container.querySelector(".lucide-arrow-down-right"),
        ).toBeInTheDocument();

        rerender(<DeltaPill value={0} label="0.0%" />);
        expect(screen.getByText("0.0%")).toHaveClass("text-muted-foreground");
        expect(
            container.querySelector(".lucide-arrow-right"),
        ).toBeInTheDocument();
    });

    it("inverts the semantic tone without changing the numeric direction", () => {
        const { container, rerender } = render(
            <DeltaPill value={4} label="4% above target" invert />,
        );
        expect(screen.getByText("4% above target")).toHaveClass("text-loss");
        expect(
            container.querySelector(".lucide-arrow-up-right"),
        ).toBeInTheDocument();

        rerender(<DeltaPill value={-4} label="-4%" invert />);
        expect(screen.getByText("-4%")).toHaveClass("text-gain");
        expect(
            container.querySelector(".lucide-arrow-down-right"),
        ).toBeInTheDocument();
    });
});
