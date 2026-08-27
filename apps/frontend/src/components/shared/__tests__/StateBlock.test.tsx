// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { AlertTriangle, Inbox } from "lucide-react";
import { describe, expect, it } from "vitest";
import { StateBlock } from "@/components/shared/StateBlock";

describe("StateBlock", () => {
    it("renders the shared neutral anatomy and action slot", () => {
        render(<StateBlock icon={Inbox} title="Nothing here" description="Add the first item." action={<button>Start</button>} />);
        expect(screen.getByRole("heading", { name: "Nothing here" })).toHaveClass("font-display", "text-lg");
        expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    });

    it("supports compact destructive states", () => {
        const { container } = render(<StateBlock icon={AlertTriangle} tone="destructive" size="compact" headingLevel={2} title="Failed" />);
        expect(screen.getByRole("heading", { level: 2, name: "Failed" })).toHaveClass("text-base");
        expect(container.querySelector(".bg-destructive\\/10")).toBeInTheDocument();
    });

    it("supports nested in-card heading levels", () => {
        render(<StateBlock icon={Inbox} headingLevel={4} title="No income sources" />);
        expect(screen.getByRole("heading", { level: 4, name: "No income sources" })).toBeInTheDocument();
    });
});
