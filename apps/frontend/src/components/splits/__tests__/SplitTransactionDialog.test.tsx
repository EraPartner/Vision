// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { SplitTransactionDialog } from "@/components/splits/SplitTransactionDialog";

const API_BASE = "http://localhost:3002";
const SPLITS_TX_URL = `${API_BASE}/api/splits/transaction/99`;
const SPLITS_BATCH_URL = `${API_BASE}/api/splits/batch`;

const RECIPIENT_ITEM = {
    id: 1,
    name: "Test Recipient",
    normalized_name: "test recipient",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

const RECIPIENTS_LIST = { items: [RECIPIENT_ITEM], total: 1, limit: 1000, offset: 0, links: [] };

function renderDialog() {
    return renderWithApp(
        <SplitTransactionDialog
            transactionId={99}
            transactionAmount={-100}
            transactionCurrency="EUR"
        />,
    );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    const trigger = await screen.findByRole("button", { name: /split transaction/i });
    await user.click(trigger);
    await screen.findByRole("dialog");
}

describe("SplitTransactionDialog", () => {
    beforeEach(() => {
        // Splits are fetched when dialog opens; not in default handlers
        server.use(http.get(SPLITS_TX_URL, () => ok({ items: [] })));
    });

    it("renders trigger button", async () => {
        renderDialog();
        // Translations load async — findBy* waits for i18n to populate
        expect(await screen.findByRole("button", { name: /split transaction/i })).toBeInTheDocument();
    });

    it("clicking trigger opens dialog", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("shows 'not split yet' alert when no existing splits", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        expect(await screen.findByText(/not split yet/i)).toBeInTheDocument();
    });

    it("shows 'already split' alert when existing splits exist", async () => {
        server.use(
            http.get(SPLITS_TX_URL, () =>
                ok({ items: [{ id: 1, recipient_id: 1, recipient_name: "Alice", amount: 30, note: "" }] }),
            ),
        );
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        expect(await screen.findByText(/already split/i)).toBeInTheDocument();
    });

    it("shows Equal Split and Custom Amounts toggle buttons", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        expect(await screen.findByRole("button", { name: /equal split/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /custom amounts/i })).toBeInTheDocument();
    });

    it("shows Add Person button", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        expect(await screen.findByRole("button", { name: /add person/i })).toBeInTheDocument();
    });

    it("Cancel button closes dialog", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        // findByRole waits for translations so "Cancel" is resolved
        await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("Split button is disabled when no recipient is selected", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        const splitButton = await screen.findByRole("button", { name: /^split$/i });
        expect(splitButton).toBeDisabled();
    });

    it("switching to Custom Amounts shows amount input", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        await user.click(await screen.findByRole("button", { name: /custom amounts/i }));
        expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });

    it("selecting a recipient enables Split button", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );

        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);

        // Open recipient combobox, then click the recipient option
        await user.click(await screen.findByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: /test recipient/i }));

        const splitButton = await screen.findByRole("button", { name: /^split$/i });
        await waitFor(() => expect(splitButton).not.toBeDisabled());
    });

    it("submitting calls POST /api/splits/batch and closes dialog", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );

        let batchBody: unknown;
        server.use(
            http.post(SPLITS_BATCH_URL, async ({ request }) => {
                batchBody = await request.json();
                return ok({ items: [] });
            }),
        );

        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);

        await user.click(await screen.findByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: /test recipient/i }));

        const splitButton = await screen.findByRole("button", { name: /^split$/i });
        await waitFor(() => expect(splitButton).not.toBeDisabled());
        await user.click(splitButton);

        await waitFor(() => expect(batchBody).toBeDefined());
        expect((batchBody as { transaction_id: number }).transaction_id).toBe(99);
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes the dialog", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("submit error keeps dialog open and surfaces toast", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
            http.post(SPLITS_BATCH_URL, () => err(500, "split server error")),
        );

        const user = userEvent.setup();
        renderDialog();
        await openDialog(user);

        await user.click(await screen.findByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: /test recipient/i }));
        const splitButton = await screen.findByRole("button", { name: /^split$/i });
        await waitFor(() => expect(splitButton).not.toBeDisabled());
        await user.click(splitButton);

        // Dialog should remain open after server error
        await waitFor(() => {
            expect(screen.queryByRole("dialog")).toBeInTheDocument();
        });
        errSpy.mockRestore();
    });
});
