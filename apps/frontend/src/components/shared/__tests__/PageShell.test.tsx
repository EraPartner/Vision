// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageShell } from "@/components/shared/PageShell";

describe("PageShell", () => {
    it("uses standard page rhythm and forwards div props", () => {
        render(
            <PageShell
                data-testid="shell"
                aria-label="Page content"
                className="max-w-4xl"
            />,
        );
        expect(screen.getByTestId("shell")).toHaveClass(
            "max-w-4xl",
            "space-y-6",
        );
        expect(screen.getByLabelText("Page content")).toBeInTheDocument();
    });

    it("supports the explicit airy dashboard rhythm", () => {
        render(
            <PageShell
                data-testid="shell"
                rhythm="airy"
                className="space-y-2"
            />,
        );
        expect(screen.getByTestId("shell")).toHaveClass("space-y-8");
        expect(screen.getByTestId("shell")).not.toHaveClass("space-y-2");
    });
});
