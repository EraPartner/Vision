// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { TransactionSearchSuggestions } from "../components/TransactionSearchSuggestions";

describe("TransactionSearchSuggestions", () => {
    it("lists the income/expense quick filters and applies them", async () => {
        const onApply = vi.fn();
        const close = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<TransactionSearchSuggestions query="" onApply={onApply} close={close} />);

        expect(await screen.findByRole("button", { name: /All income/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /All expenses/i })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /All income/i }));
        expect(onApply).toHaveBeenCalledWith({ transaction_type: "income" });
        expect(close).toHaveBeenCalled();
    });

    it("applies an exact amount as a zero-width min/max range", async () => {
        const onApply = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<TransactionSearchSuggestions query="" onApply={onApply} close={vi.fn()} />);

        await user.click(await screen.findByRole("button", { name: /Amount equals/i }));
        const input = await screen.findByRole("spinbutton");
        await user.type(input, "50");
        await user.click(screen.getByRole("button", { name: /Apply/i }));

        expect(onApply).toHaveBeenCalledWith({ amount_min: "50", amount_max: "50" });
    });

    it("applies a full calendar year as a date range", async () => {
        const onApply = vi.fn();
        const user = userEvent.setup();
        const year = new Date().getFullYear();
        renderWithApp(<TransactionSearchSuggestions query="" onApply={onApply} close={vi.fn()} />);

        await user.click(await screen.findByRole("button", { name: new RegExp(`Transactions of ${year}`) }));
        expect(onApply).toHaveBeenCalledWith({ start_date: `${year}-01-01`, end_date: `${year}-12-31` });
    });
});
