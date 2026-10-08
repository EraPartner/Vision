// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";

describe("Disclosure", () => {
    it("is a native details element with a focusable, typed summary", () => {
        render(
            <Disclosure variant="card" data-testid="details">
                <DisclosureSummary padded>Chart options</DisclosureSummary>
                <DisclosureContent>Body</DisclosureContent>
            </Disclosure>,
        );
        const details = screen.getByTestId("details");
        expect(details.tagName).toBe("DETAILS");
        expect(details).toHaveClass("rounded-card");
        const summary = screen.getByText("Chart options");
        expect(summary.tagName).toBe("SUMMARY");
        expect(summary).toHaveClass("focus-ring", "type-body", "px-4");
    });
});
