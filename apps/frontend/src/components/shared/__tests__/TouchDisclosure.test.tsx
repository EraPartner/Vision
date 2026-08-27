// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
    CompactValueDisclosure,
    TouchDisclosure,
} from "@/components/shared/TouchDisclosure";

describe("TouchDisclosure", () => {
    it("reveals information on tap without relying on title", async () => {
        const user = userEvent.setup();
        render(
            <TouchDisclosure label="Exact value" content="€1,234,567.89">
                €1.2M
            </TouchDisclosure>,
        );

        const trigger = screen.getByRole("button", { name: "Exact value" });
        expect(trigger).not.toHaveAttribute("title");
        await user.click(trigger);
        expect(screen.getByText("€1,234,567.89")).toBeVisible();
    });

    it("uses a real button and the coarse-pointer target contract", () => {
        render(
            <CompactValueDisclosure
                display="€1.2M"
                fullValue="€1,234,567.89"
            />,
        );
        expect(
            screen.getByRole("button", { name: "€1,234,567.89" }),
        ).toHaveClass(
            "[@media(pointer:coarse)]:min-h-10",
            "[@media(pointer:coarse)]:min-w-10",
        );
    });

    it("renders a passive value when no disclosure is needed", () => {
        render(<CompactValueDisclosure display="€123" />);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.getByText("€123")).toBeVisible();
    });
});
