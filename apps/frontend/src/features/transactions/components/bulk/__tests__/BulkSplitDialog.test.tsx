// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { BulkSplitDialog } from "@/features/transactions/components/bulk/BulkSplitDialog";

const API_BASE = "http://localhost:3002";

const RECIPIENTS = {
    items: [
        {
            id: 7,
            name: "Partner",
            normalized_name: "partner",
            default_category_id: null,
            primary_recipient_id: null,
            notes: null,
            is_active: true,
            created_at: "2025-01-01T00:00:00.000Z",
            updated_at: null,
            links: [],
        },
    ],
    total: 1,
    limit: 1000,
    offset: 0,
    links: [],
};

async function pickPartner(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("combobox", { name: "Payee" }));
    await user.click(await screen.findByRole("option", { name: /partner/i }));
}

describe("BulkSplitDialog", () => {
    it("is disabled until a payee is chosen and defaults to the equal preset", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS)),
        );
        const user = userEvent.setup();
        const onApply = vi.fn();
        renderWithApp(
            <BulkSplitDialog
                open
                selectedCount={3}
                onOpenChange={vi.fn()}
                onApply={onApply}
            />,
        );

        expect(
            await screen.findByRole("heading", {
                name: "Split 3 transactions",
            }),
        ).toBeVisible();
        const submit = screen.getByRole("button", { name: "Split" });
        expect(submit).toBeDisabled();
        expect(
            screen.getByRole("radio", { name: "Equal split" }),
        ).toBeChecked();
        expect(
            screen.getByText(/owes half of each transaction/i),
        ).toBeVisible();

        await pickPartner(user);
        await waitFor(() => expect(submit).not.toBeDisabled());
        await user.click(submit);
        expect(onApply).toHaveBeenCalledWith(7, "equal");
    });

    it("applies the 0/100 preset as mode 'full'", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS)),
        );
        const user = userEvent.setup();
        const onApply = vi.fn();
        renderWithApp(
            <BulkSplitDialog
                open
                selectedCount={2}
                onOpenChange={vi.fn()}
                onApply={onApply}
            />,
        );

        await user.click(
            await screen.findByRole("radio", { name: "Others pay all" }),
        );
        expect(
            screen.getByText(/owes the full amount of each transaction/i),
        ).toBeVisible();
        await pickPartner(user);
        const submit = screen.getByRole("button", { name: "Split" });
        await waitFor(() => expect(submit).not.toBeDisabled());
        await user.click(submit);
        expect(onApply).toHaveBeenCalledWith(7, "full");
    });

    it("shows the pending label and blocks both buttons while applying", async () => {
        renderWithApp(
            <BulkSplitDialog
                open
                selectedCount={2}
                onOpenChange={vi.fn()}
                onApply={vi.fn()}
                pending
            />,
        );
        expect(
            await screen.findByRole("button", { name: "Splitting…" }),
        ).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
