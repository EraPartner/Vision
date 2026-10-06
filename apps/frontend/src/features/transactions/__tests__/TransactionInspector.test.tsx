// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ACCOUNT_LIST_ITEM_STUB, ok } from "@/test/msw/handlers";
import {
    TransactionInspector,
    type TransactionInspectorProps,
} from "@/features/transactions/components/TransactionInspector";
import type { TableTransaction } from "@/features/transactions/types";

const API_BASE = "http://localhost:3002";

const TX: TableTransaction = {
    id: 42,
    date: "2025-01-15",
    memo: "Test purchase",
    category: "FOOD:GROCERIES",
    categoryId: 1,
    recipient: "Alice",
    recipientId: 1,
    bank: "IBAN001",
    amount: -25.5,
    currency: "EUR",
    balance: 100,
    comment: "Test comment",
    is_active: true,
};

function renderInspector(
    overrides: Partial<TransactionInspectorProps> = {},
    presentation: TransactionInspectorProps["presentation"] = "docked",
) {
    const props: TransactionInspectorProps = {
        transaction: TX,
        presentation,
        onClose: vi.fn(),
        onApplyLocal: vi.fn(),
        onSelectCategory: vi.fn(),
        onSelectRecipient: vi.fn(),
        onDuplicate: vi.fn(),
        onFilterByRecipient: vi.fn(),
        onToggleActive: vi.fn(),
        onDelete: vi.fn(),
        updatePending: false,
        deletePending: false,
        ...overrides,
    };
    return renderWithApp(<TransactionInspector {...props} />);
}

describe("TransactionInspector", () => {
    beforeEach(() => {
        server.use(
            http.get(`${API_BASE}/api/attachments/transaction/:id`, () =>
                ok({ items: [] }),
            ),
            http.get(`${API_BASE}/api/recipients/1`, () =>
                ok({ id: 1, name: "Alice", is_active: true, links: [] }),
            ),
        );
    });

    it("renders the panel, named after the payee, when a transaction is selected", async () => {
        renderInspector();

        // txPage.detailsTitle names the landmark; the heading is the payee.
        expect(
            await screen.findByRole("complementary", {
                name: /transaction details/i,
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Alice", level: 2 }),
        ).toBeInTheDocument();
    });

    it("presents the same content as a sheet on narrow screens", async () => {
        renderInspector({}, "sheet");
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: "Alice", level: 2 }),
        ).toBeInTheDocument();
    });

    it("does not render the panel when no transaction is selected", () => {
        renderInspector({ transaction: null });

        expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    });

    it("shows transaction ID value", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("shows memo (description) value", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        expect(screen.getByText("Test purchase")).toBeInTheDocument();
    });

    it("shows the recipient and category pickers with the row's values", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "GROCERIES",
                            parentId: null,
                            pathIds: [1],
                            path: ["FOOD", "GROCERIES"],
                            category_name: "FOOD:GROCERIES",
                            depth: 2,
                            description: null,
                            is_active: true,
                            hierarchyOnly: false,
                            legacyCompatible: false,
                        },
                    ],
                    total: 1,
                    links: [],
                }),
            ),
        );
        renderInspector();

        await screen.findByRole("complementary");
        expect(
            await screen.findByRole("combobox", { name: /^recipient$/i }),
        ).toHaveTextContent("Alice");
        await waitFor(() =>
            expect(
                screen.getByRole("combobox", { name: /^category$/i }),
            ).toHaveTextContent("FOOD / GROCERIES"),
        );
    });

    it("changes the category through the page's handler", async () => {
        const user = userEvent.setup();
        const onSelectCategory = vi.fn();
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({
                    items: [
                        {
                            id: 2,
                            name: "Household",
                            parentId: null,
                            pathIds: [2],
                            path: ["Household"],
                            category_name: "Household",
                            depth: 1,
                            description: null,
                            is_active: true,
                            hierarchyOnly: false,
                            legacyCompatible: false,
                        },
                    ],
                    total: 1,
                    links: [],
                }),
            ),
        );
        renderInspector({ onSelectCategory });
        await user.click(
            await screen.findByRole("combobox", { name: /^category$/i }),
        );
        await user.click(await screen.findByRole("option", { name: "Household" }));
        expect(onSelectCategory).toHaveBeenCalledWith(42, 2, "Household");
    });

    it("offers the payee rule once the row's category differs from the payee's usual one", async () => {
        const user = userEvent.setup();
        let patched: Record<string, unknown> | undefined;
        server.use(
            http.patch(`${API_BASE}/api/recipients/1`, async ({ request }) => {
                patched = (await request.json()) as Record<string, unknown>;
                return ok({ id: 1, name: "Alice", default_category_id: 1, links: [] });
            }),
        );
        renderInspector();
        await user.click(
            await screen.findByRole("button", { name: /^always use$/i }),
        );
        await waitFor(() => expect(patched).toEqual({ default_category_id: 1 }));
    });

    it("shows the row actions in the footer and routes them to the page", async () => {
        const user = userEvent.setup();
        const onDuplicate = vi.fn();
        const onToggleActive = vi.fn();
        const onDelete = vi.fn();
        const onFilterByRecipient = vi.fn();
        renderInspector({ onDuplicate, onToggleActive, onDelete, onFilterByRecipient });
        await screen.findByRole("complementary");

        await user.click(screen.getByRole("button", { name: /^duplicate$/i }));
        expect(onDuplicate).toHaveBeenCalledWith(TX);
        await user.click(screen.getByRole("button", { name: /mark as inactive/i }));
        expect(onToggleActive).toHaveBeenCalledWith(42, true);
        await user.click(screen.getByRole("button", { name: /show all from payee/i }));
        expect(onFilterByRecipient).toHaveBeenCalledWith(TX);
        await user.click(screen.getByRole("button", { name: /^delete…$/i }));
        expect(onDelete).toHaveBeenCalledWith(42, "Test purchase");
        expect(
            screen.getByRole("button", { name: /split transaction/i }),
        ).toBeInTheDocument();
    });

    it("shows comment value", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        expect(screen.getByText("Test comment")).toBeInTheDocument();
    });

    it("marks an inactive transaction in the header and offers to reactivate it", async () => {
        const inactiveTx = { ...TX, is_active: false };

        renderInspector({ transaction: inactiveTx });

        await screen.findByRole("complementary");
        // txPage.statusInactive = "Inactive"
        expect(screen.getByText(/· inactive$/i)).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /mark as active/i }),
        ).toBeInTheDocument();
    });

    it("shows Edit pencil buttons for editable fields", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        // Each control identifies the field it edits.
        const editButtons = await screen.findAllByRole("button", {
            name: /^edit /i,
        });
        expect(editButtons).toHaveLength(6);
        for (const field of [
            "Date",
            "Description",
            "Amount",
            "Currency",
            "Bank Account",
            "Comment",
        ]) {
            expect(
                screen.getByRole("button", { name: `Edit ${field}` }),
            ).toBeInTheDocument();
        }
    });

    it("allows adding a previously blank comment", async () => {
        const user = userEvent.setup();
        const onApplyLocal = vi.fn();
        let receivedBody: unknown;
        server.use(
            http.patch(
                `${API_BASE}/api/transactions/42`,
                async ({ request }) => {
                    receivedBody = await request.json();
                    return ok({ ...TX, comment: "Added note" });
                },
            ),
        );
        renderInspector({ transaction: { ...TX, comment: "" }, onApplyLocal });
        await user.click(
            await screen.findByRole("button", { name: "Edit Comment" }),
        );
        await user.type(
            screen.getByRole("textbox", { name: "Comment" }),
            "Added note",
        );
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(receivedBody).toEqual({ comment: "Added note" }),
        );
        expect(onApplyLocal).toHaveBeenCalledWith(42, "comment", "Added note");
    });

    it("clicking Edit on memo field shows text input", async () => {
        const user = userEvent.setup();

        renderInspector();

        await screen.findByRole("complementary");

        await user.click(
            await screen.findByRole("button", { name: "Edit Description" }),
        );

        expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("updates an existing account by canonical account_id", async () => {
        const user = userEvent.setup();
        const onApplyLocal = vi.fn();
        let receivedBody: Record<string, unknown> | undefined;
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({
                    items: [ACCOUNT_LIST_ITEM_STUB],
                    total: 1,
                    links: [],
                }),
            ),
            http.patch(
                `${API_BASE}/api/transactions/42`,
                async ({ request }) => {
                    receivedBody = (await request.json()) as Record<
                        string,
                        unknown
                    >;
                    return ok({ ...TX, account_id: 1 });
                },
            ),
        );

        renderInspector({ onApplyLocal });

        await user.click(
            await screen.findByRole("button", { name: "Edit Bank Account" }),
        );
        await user.click(screen.getByLabelText("Bank Account"));
        await user.type(
            screen.getByPlaceholderText(/search accounts/i),
            "Main Checking",
        );
        await user.click(
            await screen.findByRole("option", { name: "Main Checking" }),
        );
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        await waitFor(() => expect(receivedBody).toEqual({ account_id: 1 }));
        expect(receivedBody).not.toHaveProperty("bank_account");
        expect(onApplyLocal).toHaveBeenCalledWith(
            42,
            "bank",
            "Main Checking",
            1,
        );
    });

    it("Cancel button in edit mode exits edit mode", async () => {
        const user = userEvent.setup();
        let patchCount = 0;
        server.use(
            http.patch(`${API_BASE}/api/transactions/42`, () => {
                patchCount += 1;
                return ok(TX);
            }),
        );

        renderInspector();

        await screen.findByRole("complementary");

        await user.click(
            await screen.findByRole("button", { name: "Edit Description" }),
        );
        expect(screen.getByRole("textbox")).toBeInTheDocument();

        // common.cancel = "Cancel"
        await user.click(
            await screen.findByRole("button", { name: /^cancel$/i }),
        );

        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(patchCount).toBe(0);
    });

    it.each(["Enter", "save button"] as const)(
        "%s submits an inline text editor",
        async (submitMethod) => {
            const user = userEvent.setup();
            const onApplyLocal = vi.fn();
            let patchCount = 0;

            server.use(
                http.patch(`${API_BASE}/api/transactions/42`, () => {
                    patchCount += 1;
                    return ok({
                        id: 42,
                        memo: "New memo",
                        amount: -25.5,
                        currency: "EUR",
                        is_active: true,
                    });
                }),
            );

            renderInspector({ onApplyLocal });

            await screen.findByRole("complementary");

            await user.click(
                await screen.findByRole("button", { name: "Edit Description" }),
            );

            const input = screen.getByRole("textbox", { name: "Description" });
            await user.clear(input);
            await user.type(input, "New memo");

            if (submitMethod === "Enter") {
                await user.keyboard("{Enter}");
            } else {
                await user.click(screen.getByRole("button", { name: "Save" }));
            }

            await waitFor(() => expect(patchCount).toBe(1));
            await waitFor(() =>
                expect(onApplyLocal).toHaveBeenCalledWith(
                    42,
                    "memo",
                    "New memo",
                ),
            );
            // Edit mode exits after save
            expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        },
    );

    it("Enter on the date trigger opens the calendar without saving", async () => {
        const user = userEvent.setup();
        let patchCount = 0;
        server.use(
            http.patch(`${API_BASE}/api/transactions/42`, () => {
                patchCount += 1;
                return ok(TX);
            }),
        );
        renderInspector();
        await screen.findByRole("complementary");
        await user.click(
            await screen.findByRole("button", { name: "Edit Date" }),
        );

        const dateTrigger = screen.getByRole("button", { name: "Date" });
        dateTrigger.focus();
        await user.keyboard("{Enter}");

        expect(await screen.findByRole("grid")).toBeInTheDocument();
        expect(patchCount).toBe(0);
    });

    it("Escape inside the panel asks the page to close it", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        renderInspector({ onClose });

        const close = await screen.findByRole("button", { name: /^close$/i });
        close.focus();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("the close button asks the page to close it", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderInspector({ onClose });
        await user.click(await screen.findByRole("button", { name: /^close$/i }));
        expect(onClose).toHaveBeenCalled();
    });

    it("shows Attachments section", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        // Wait for the attachments query to settle so we don't race the loading
        // spinner. The mocked GET resolves synchronously but React Query still
        // flushes through a microtask cycle, which under CI load was racing the
        // exact-match assertion below.
        await waitFor(() =>
            expect(
                screen.queryByText(/^loading\.\.\.$/i),
            ).not.toBeInTheDocument(),
        );
        // Match the section header exactly — `/attachments/i` would also catch
        // "No attachments yet" and trip the multiple-match guard.
        expect(
            await screen.findByText(/^attachments$/i, undefined, {
                timeout: 3000,
            }),
        ).toBeInTheDocument();
    });

    it("shows no-attachments message when attachment list is empty", async () => {
        renderInspector();

        await screen.findByRole("complementary");
        // txPage.noAttachments = "No attachments yet"
        expect(
            await screen.findByText(/no attachments yet/i),
        ).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("first focusable element exists for keyboard nav", async () => {
        renderInspector();
        await screen.findByRole("complementary");
        const buttons = await screen.findAllByRole("button");
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── F3: Field validation ──────────────────────────────────────────────

    it("amount edit submits parsed value using the selected EU number format", async () => {
        // Note: EU-comma parsing is unit-tested in src/utils/currency.test.ts.
        // jsdom's type=number input rejects locale-comma values via fireEvent,
        // so we cannot simulate "1,50" keystrokes here without changing the
        // input type. This component test verifies the save path wires
        // parseLocaleNumber into the amount edit flow correctly.
        const user = userEvent.setup();
        const onApplyLocal = vi.fn();
        let receivedAmount: number | undefined;

        server.use(
            http.patch(
                `${API_BASE}/api/transactions/42`,
                async ({ request }) => {
                    const body = (await request.json()) as { amount?: number };
                    receivedAmount = body.amount;
                    return ok({
                        id: 42,
                        memo: "x",
                        amount: body.amount ?? 0,
                        currency: "EUR",
                        is_active: true,
                    });
                },
            ),
        );

        renderInspector({ onApplyLocal });

        await screen.findByRole("complementary");

        await user.click(
            await screen.findByRole("button", { name: "Edit Amount" }),
        );

        const input = screen.getByRole("textbox", {
            name: "Amount",
        }) as HTMLInputElement;
        fireEvent.change(input, { target: { value: "42,5" } });

        await user.click(
            await screen.findByRole("button", { name: /^save$/i }),
        );

        await waitFor(() => expect(receivedAmount).toBe(42.5));
        await waitFor(() =>
            expect(onApplyLocal).toHaveBeenCalledWith(42, "amount", 42.5),
        );
    });

    // ─── Tag removal regression (TODO 2024-06-15) ─────────────────────────
    // Removing the only tag must visibly clear the chip and PATCH `{ tags: [] }`.
    // Previously the dialog bound TagInput straight at the frozen `infoTransaction`
    // snapshot, so the removed chip stayed on screen and the deletion looked stuck.
    it("removing the only tag clears the chip and PATCHes empty tags", async () => {
        const user = userEvent.setup();
        let receivedTags: unknown;

        const txWithTag: TableTransaction = {
            ...TX,
            tags: [
                {
                    id: 1,
                    slug: "travel",
                    color: null,
                    is_active: true,
                    created_at: "",
                    updated_at: "",
                },
            ],
        };

        server.use(
            http.patch(
                `${API_BASE}/api/transactions/42`,
                async ({ request }) => {
                    const body = (await request.json()) as { tags?: unknown };
                    receivedTags = body.tags;
                    return ok({
                        id: 42,
                        memo: "Test purchase",
                        amount: -25.5,
                        currency: "EUR",
                        is_active: true,
                        tags: [],
                    });
                },
            ),
        );

        renderInspector({ transaction: txWithTag });

        await screen.findByRole("complementary");
        // The chip is present before removal.
        const removeButton = await screen.findByRole("button", {
            name: /remove tag travel/i,
        });

        await user.click(removeButton);

        // PATCH carries an empty array (not undefined / not skipped).
        await waitFor(() => expect(receivedTags).toEqual([]));
        // The chip is gone from the dialog — the deletion is visible, not stuck.
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: /remove tag travel/i }),
            ).not.toBeInTheDocument(),
        );
    });

    it("starting edit then Cancel does NOT call PATCH (no submission)", async () => {
        const user = userEvent.setup();
        let patchCalled = false;

        server.use(
            http.patch(`${API_BASE}/api/transactions/42`, () => {
                patchCalled = true;
                return ok({
                    id: 42,
                    memo: "x",
                    amount: -25.5,
                    currency: "EUR",
                    is_active: true,
                });
            }),
        );

        renderInspector();

        await screen.findByRole("complementary");

        await user.click(
            await screen.findByRole("button", { name: "Edit Description" }),
        );

        await user.type(screen.getByRole("textbox"), " (changed)");
        await user.click(
            await screen.findByRole("button", { name: /^cancel$/i }),
        );

        await new Promise((r) => setTimeout(r, 100));
        expect(patchCalled).toBe(false);
    });
});
