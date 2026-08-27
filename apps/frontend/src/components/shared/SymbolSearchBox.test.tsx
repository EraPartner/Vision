// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { MemoryRouter } from "react-router";

const apple = {
    symbol: "AAPL",
    name: "Apple",
    type: "Equity",
    exchange: "NASDAQ",
};
const microsoft = {
    symbol: "MSFT",
    name: "Microsoft",
    type: "Equity",
    exchange: "NASDAQ",
};

describe("SymbolSearchBox", () => {
    it("wires the input and results as an ARIA combobox", () => {
        render(
            <SymbolSearchBox
                value="a"
                onChange={() => undefined}
                placeholder="Search"
                open
                onDismiss={() => undefined}
            >
                <SymbolSearchResultItem
                    item={apple}
                    onSelect={() => undefined}
                />
            </SymbolSearchBox>,
        );

        const input = screen.getByRole("combobox", { name: "Search" });
        const listbox = screen.getByRole("listbox");
        expect(input).toHaveAttribute("aria-expanded", "true");
        expect(input).toHaveAttribute("aria-controls", listbox.id);
        expect(screen.getByRole("option")).toHaveTextContent("AAPL");
    });

    it("keeps input focus while arrows choose an active option and Enter selects it", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(
            <SymbolSearchBox
                value="a"
                onChange={() => undefined}
                placeholder="Search"
                open
                onDismiss={() => undefined}
            >
                <SymbolSearchResultItem item={apple} onSelect={onSelect} />
                <SymbolSearchResultItem item={microsoft} onSelect={onSelect} />
            </SymbolSearchBox>,
        );

        const input = screen.getByRole("combobox", { name: "Search" });
        await user.click(input);
        await user.keyboard("{ArrowDown}{ArrowDown}");

        expect(input).toHaveFocus();
        expect(input).toHaveAttribute(
            "aria-activedescendant",
            screen.getAllByRole("option")[1].id,
        );
        expect(screen.getAllByRole("option")[1]).toHaveAttribute(
            "aria-selected",
            "true",
        );
        expect(screen.getAllByRole("option")[1]).toHaveClass("bg-muted/70");

        await user.keyboard("{Enter}");
        expect(onSelect).toHaveBeenCalledWith(microsoft);
    });

    it("preserves text-editing keys and dismisses the controlled popup with Escape", async () => {
        const user = userEvent.setup();
        const onDismiss = vi.fn();
        render(
            <SymbolSearchBox
                value="apple"
                onChange={() => undefined}
                placeholder="Search"
                open
                onDismiss={onDismiss}
            >
                <SymbolSearchResultItem
                    item={apple}
                    onSelect={() => undefined}
                />
            </SymbolSearchBox>,
        );

        const input = screen.getByRole("combobox", {
            name: "Search",
        }) as HTMLInputElement;
        await user.click(input);
        input.setSelectionRange(5, 5);
        await user.keyboard("{Home}");
        expect(input.selectionStart).toBe(0);

        await user.keyboard("{Escape}");
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it("keeps popup options out of the Tab sequence", async () => {
        const user = userEvent.setup();
        render(
            <>
                <SymbolSearchBox
                    value="a"
                    onChange={() => undefined}
                    placeholder="Search"
                    open
                    onDismiss={() => undefined}
                >
                    <SymbolSearchResultItem
                        item={apple}
                        onSelect={() => undefined}
                    />
                </SymbolSearchBox>
                <button type="button">After search</button>
            </>,
        );

        const input = screen.getByRole("combobox", { name: "Search" });
        await user.click(input);
        expect(screen.getByRole("option")).toHaveAttribute("tabindex", "-1");
        await user.tab();
        expect(
            screen.getByRole("button", { name: "After search" }),
        ).toHaveFocus();
    });

    it("does not turn the shared result row into an orphan option outside a search box", () => {
        render(
            <SymbolSearchResultItem item={apple} onSelect={() => undefined} />,
        );
        const result = screen.getByRole("button", { name: /AAPL/ });
        expect(result).not.toHaveAttribute("role", "option");
        expect(result).not.toHaveAttribute("tabindex", "-1");
    });

    it("renders navigation results as href-backed options", () => {
        render(
            <MemoryRouter>
                <SymbolSearchBox
                    value="a"
                    onChange={() => undefined}
                    placeholder="Search"
                    open
                    onDismiss={() => undefined}
                >
                    <SymbolSearchResultItem
                        item={apple}
                        to="/research/market?symbol=AAPL"
                    />
                </SymbolSearchBox>
            </MemoryRouter>,
        );
        expect(screen.getByRole("option")).toHaveAttribute(
            "href",
            "/research/market?symbol=AAPL",
        );
    });
});
