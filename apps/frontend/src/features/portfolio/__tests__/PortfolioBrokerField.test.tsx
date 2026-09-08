// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { PortfolioBrokerField } from "@/features/portfolio/PortfolioBrokerField";
import type { Account } from "@/types/api";

const BROKER: Account = {
    id: 7,
    name: "Degiro",
    currency: "EUR",
    type: "brokerage",
    liquidity_class: "liquid",
    spendable: false,
    in_net_worth: true,
    tax_wrapper: "none",
    owner: "me",
    multi_currency_cash: false,
    has_cash_sleeve: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
};

const labels: Record<string, string> = {
    "addPortTxn.broker": "Broker",
    "addPortTxn.broker.change": "Change",
    "addPortTxn.broker.unassigned": "Unassigned",
};

describe("PortfolioBrokerField", () => {
    it("shows a muted default and lets the user explicitly choose Unassigned", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioBrokerField
                id="broker"
                accounts={[BROKER]}
                value="7"
                onChange={onChange}
                compactDefault
                t={(key) => labels[key] ?? key}
            />,
        );

        expect(screen.getByText("Degiro")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Change" }));
        await user.click(screen.getByLabelText("Broker"));
        await user.click(screen.getByRole("option", { name: "Unassigned" }));

        expect(onChange).toHaveBeenCalledWith("");
    });
});
