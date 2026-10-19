// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, OWED_TOTALS_STUB, SPLIT_STUB } from "@/test/msw/handlers";
import { RecipientOwesDetail } from "../RecipientOwesDetail";

it.each(["0", "-1", "12,,3"])(
    "rejects repayment %s with a field error and no request",
    async (amount) => {
        const pay = vi.fn();
        server.use(
            http.get("http://localhost:3002/api/splits/owed/1", () =>
                ok({
                    items: [
                        {
                            ...SPLIT_STUB,
                            remaining: 25,
                            transaction_date: "2026-10-11T00:00:00.000Z",
                            transaction_memo: null,
                            bank_account: null,
                            transaction_amount: -25,
                            transaction_currency: "EUR",
                            transaction_recipient_name: "Dinner",
                        },
                    ],
                    total: 1,
                    summary: OWED_TOTALS_STUB,
                }),
            ),
            http.post("http://localhost:3002/api/splits/1/pay", () => {
                pay();
                return ok({});
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <RecipientOwesDetail
                recipient={{ id: 1, name: "Alice" }}
                onBack={vi.fn()}
            />,
        );
        await user.click(
            await screen.findByRole("button", {
                name: /record payment: dinner/i,
            }),
        );
        const dialog = screen.getByRole("dialog");
        const input = within(dialog).getByRole("textbox");
        await user.clear(input);
        await user.type(input, amount);
        await user.click(
            within(dialog).getByRole("button", { name: "Record payment" }),
        );
        expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveValue(amount);
        expect(pay).not.toHaveBeenCalled();
    },
);
