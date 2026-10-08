// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { List, ListRow } from "@/components/ui/list";

describe("inset List", () => {
    it("renders static rows as list items with title, subtitle and trailing value", () => {
        render(
            <List aria-label="Accounts">
                <ListRow
                    title="Checking"
                    subtitle="Updated today"
                    trailing="1.234,00 €"
                />
                <ListRow title="Savings" />
            </List>,
        );
        const list = screen.getByRole("list", { name: "Accounts" });
        expect(list).toHaveClass("rounded-card", "corner-continuous");
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
        expect(screen.getByText("Updated today")).toBeInTheDocument();
        expect(screen.getByText("1.234,00 €")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders an activatable row as a button with a chevron", () => {
        const onActivate = vi.fn();
        render(
            <List>
                <ListRow
                    title="Open settings"
                    chevron
                    onActivate={onActivate}
                />
            </List>,
        );
        const row = screen.getByRole("button", { name: "Open settings" });
        expect(row).toHaveClass("focus-ring");
        fireEvent.click(row);
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it("lets a link be the row's interactive element", () => {
        render(
            <List>
                <ListRow
                    title="Transactions"
                    subtitle="11 need a category"
                    chevron
                    asChild
                >
                    <a href="/transactions" />
                </ListRow>
            </List>,
        );
        const link = screen.getByRole("link", { name: /Transactions/ });
        expect(link).toHaveAttribute("href", "/transactions");
        expect(link).toHaveTextContent("11 need a category");
    });
});

describe("ListRow actions and selection", () => {
    it("renders actions beside the row, outside its button, and marks the selection", () => {
        const onActivate = vi.fn();
        const onAction = vi.fn();
        render(
            <List>
                <ListRow
                    title="Rent"
                    selected
                    onActivate={onActivate}
                    actions={
                        <button type="button" onClick={onAction}>
                            Actions for Rent
                        </button>
                    }
                />
            </List>,
        );
        const item = screen.getByRole("listitem");
        expect(item).toHaveAttribute("aria-current", "true");
        expect(item).toHaveAttribute("data-selected");
        const row = screen.getByRole("button", { name: "Rent" });
        const action = screen.getByRole("button", { name: "Actions for Rent" });
        expect(row.contains(action)).toBe(false);
        fireEvent.click(action);
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(onActivate).not.toHaveBeenCalled();
    });
});
