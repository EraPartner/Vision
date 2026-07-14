// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { StatCard } from "./StatCard";

describe("StatCard odometer opt-out", () => {
    test("renders a non-numeric value as plain text (spaces preserved, no digit reels)", () => {
        const { container, getByText } = render(
            <StatCard title="Top Recipient" value="Albert Heijn" odometer={false} />,
        );
        // The full text (including the space) is a single text node, not split
        // into per-character inline-block spans by RollingNumber.
        expect(getByText("Albert Heijn")).toBeTruthy();
        expect(container.querySelector('[role="img"]')).toBeNull();
    });

    test("defaults to the odometer treatment for values", () => {
        const { container } = render(<StatCard title="Total" value="1.234" />);
        // RollingNumber renders an aria-label'd role=img wrapper for the reels.
        expect(container.querySelector('[role="img"]')).not.toBeNull();
    });
});
