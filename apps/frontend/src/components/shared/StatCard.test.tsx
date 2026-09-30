// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "./StatCard";
import { MemoryRouter, useLocation } from "react-router";
import userEvent from "@testing-library/user-event";

describe("shared StatCard odometer opt-out", () => {
    test.each(["secondary", "primary"] as const)(
        "keeps %s metrics informational unless linked",
        (emphasis) => {
            render(
                <StatCard
                    title="Portfolio value"
                    value="€120"
                    emphasis={emphasis}
                />,
            );
            expect(
                screen.getByRole("heading", { name: "Portfolio value" }),
            ).toBeVisible();
            expect(screen.queryByRole("link")).not.toBeInTheDocument();
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
        },
    );

    test("allows keyboard drill-down while exact values remain independently accessible", async () => {
        const user = userEvent.setup();
        function Location() {
            return (
                <output aria-label="Current route">
                    {useLocation().pathname}
                </output>
            );
        }
        render(
            <MemoryRouter>
                <StatCard
                    title="Income"
                    value="€1.2M"
                    titleValue="€1,234,567.89"
                    to="/transactions"
                    emphasis="primary"
                />
                <Location />
            </MemoryRouter>,
        );
        await user.click(screen.getByRole("button", { name: "€1,234,567.89" }));
        expect(screen.getByText("€1,234,567.89")).toBeVisible();
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/");
        await user.keyboard("{Escape}");
        screen.getByRole("link", { name: "Income" }).focus();
        await user.keyboard("{Enter}");
        expect(screen.getByLabelText("Current route")).toHaveTextContent(
            "/transactions",
        );
    });

    test("renders a non-numeric value as plain text (spaces preserved, no digit reels)", () => {
        const { container, getByText } = render(
            <StatCard
                title="Top Recipient"
                value="Albert Heijn"
                odometer={false}
            />,
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

    test("exposes a full-card drill-down href without hiding exact compact values", () => {
        render(
            <MemoryRouter>
                <StatCard
                    title="Income"
                    value="€1.2M"
                    titleValue="€1,234,567.89"
                    to="/transactions?transaction_type=income"
                />
            </MemoryRouter>,
        );
        expect(screen.getByRole("link", { name: "Income" })).toHaveAttribute(
            "href",
            "/transactions?transaction_type=income",
        );
        expect(
            screen.getByRole("button", { name: "€1,234,567.89" }),
        ).toBeVisible();
    });
});
