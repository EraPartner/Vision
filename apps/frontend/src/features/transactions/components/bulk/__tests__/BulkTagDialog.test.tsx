// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { BulkTagDialog } from "@/features/transactions/components/bulk/BulkTagDialog";

const API_BASE = "http://localhost:3002";

const TAGS = {
    items: [
        {
            id: 1,
            name: "groceries",
            slug: "groceries",
            color: null,
            is_active: true,
        },
        { id: 2, name: "travel", slug: "travel", color: null, is_active: true },
    ],
    total: 2,
    limit: 200,
    offset: 0,
};

/** Pick the first tag in the "add" combobox (the first of the two pickers). */
async function pickFirstAddTag(user: ReturnType<typeof userEvent.setup>) {
    const picker = await screen.findByRole("combobox", { name: "Add tags" });
    await user.click(picker);
    await user.click(await screen.findByText("groceries"));
    await user.keyboard("{Escape}"); // close the popover, not the dialog
}

describe("BulkTagDialog", () => {
    it("keeps the chosen tags when the dialog is dismissed", async () => {
        // Arrange — the tags are a property of the edit, not of the selection,
        // so a stray dismissal must not throw them away.
        server.use(http.get(`${API_BASE}/api/tags`, () => ok(TAGS)));
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        const { rerender } = renderWithApp(
            <BulkTagDialog
                open
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );

        // Act — choose a tag, dismiss, reopen
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await waitFor(() =>
            expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0),
        );
        rerender(
            <BulkTagDialog
                open={false}
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );
        rerender(
            <BulkTagDialog
                open
                selectedCount={5}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );

        // Assert — still selected, and Apply is still enabled
        await screen.findByRole("dialog");
        expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0);
        expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled();
    });

    it("clears the chosen tags on explicit Cancel", async () => {
        // Arrange
        server.use(http.get(`${API_BASE}/api/tags`, () => ok(TAGS)));
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        const { rerender } = renderWithApp(
            <BulkTagDialog
                open
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );

        // Act — Cancel is a deliberate discard, unlike a dismissal
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await waitFor(() =>
            expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0),
        );
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        rerender(
            <BulkTagDialog
                open={false}
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );
        rerender(
            <BulkTagDialog
                open
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={vi.fn()}
            />,
        );

        // Assert — nothing chosen, so Apply is disabled again
        await screen.findByRole("dialog");
        expect(screen.queryByText(/1 tags/i)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
    });

    it("clears the chosen tags after Apply", async () => {
        // Arrange
        server.use(http.get(`${API_BASE}/api/tags`, () => ok(TAGS)));
        const user = userEvent.setup();
        const onApply = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <BulkTagDialog
                open
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={onApply}
            />,
        );

        // Act
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await user.click(await screen.findByRole("button", { name: /apply/i }));

        // Assert — applied once, and the picker is back to empty
        expect(onApply).toHaveBeenCalledWith(["groceries"], []);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /apply/i }),
            ).toBeDisabled(),
        );
    });
});

// Enter-to-submit regression tests (TODO.md: "Enter never submits in the
// button-only dialogs"). BulkTagDialog is the bulk representative: its inputs
// are cmdk comboboxes, so the two things to prove are (1) the dialog body is a
// real <form> that submits exactly once, and (2) Enter *inside* a combobox
// selects an item and never falls through to the form.
describe("BulkTagDialog — form submit and combobox interference", () => {
    async function renderDialog() {
        server.use(http.get(`${API_BASE}/api/tags`, () => ok(TAGS)));
        const onApply = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <BulkTagDialog
                open
                selectedCount={3}
                onOpenChange={onOpenChange}
                onApply={onApply}
            />,
        );
        await screen.findByText("Tag 3 transactions");
        return { onApply, onOpenChange };
    }

    /** Pick "groceries" in the Add-tags combobox using only the keyboard's Enter. */
    async function pickTagWithEnter(user: ReturnType<typeof userEvent.setup>) {
        const addTrigger = await screen.findByRole("combobox", {
            name: "Add tags",
        });
        await user.click(addTrigger);
        await user.type(
            await screen.findByPlaceholderText("Search tags…"),
            "groc",
        );
        await user.keyboard("{Enter}");
    }

    it("names the add and remove tag controls from their visible labels", async () => {
        await renderDialog();

        expect(
            screen.getByRole("combobox", { name: "Add tags" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("combobox", { name: "Remove tags" }),
        ).toBeInTheDocument();
    });

    it("Enter inside the tag combobox selects the tag without applying", async () => {
        const user = userEvent.setup();
        const { onApply } = await renderDialog();

        await pickTagWithEnter(user);

        // The item got selected (trigger label flips to the count)…
        await waitFor(() =>
            expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0),
        );
        // …but cmdk's Enter never reached the form.
        expect(onApply).not.toHaveBeenCalled();
    });

    it("submitting the form applies the chosen tags exactly once", async () => {
        const user = userEvent.setup();
        const { onApply } = await renderDialog();

        await pickTagWithEnter(user);
        await user.keyboard("{Escape}"); // close the popover, not the dialog

        // The Enter path: submit the dialog's form (what the browser does when
        // Enter fires with the form's submit button as default).
        const applyButton = screen.getByRole("button", { name: /apply/i });
        expect(applyButton).toHaveAttribute("type", "submit");
        fireEvent.submit(applyButton.closest("form")!);

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(["groceries"], []);
    });

    it("cancel closes without applying", async () => {
        const user = userEvent.setup();
        const { onApply, onOpenChange } = await renderDialog();

        await pickTagWithEnter(user);
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: /cancel/i }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onApply).not.toHaveBeenCalled();
    });
});
