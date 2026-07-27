// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { BulkTagDialog } from "@/features/transactions/components/bulk/BulkTagDialog";

const API_BASE = "http://localhost:3002";

const TAGS = {
    items: [
        { id: 1, name: "groceries", slug: "groceries", color: null, is_active: true },
        { id: 2, name: "travel", slug: "travel", color: null, is_active: true },
    ],
    total: 2,
    limit: 200,
    offset: 0,
};

/** Pick the first tag in the "add" combobox (the first of the two pickers). */
async function pickFirstAddTag(user: ReturnType<typeof userEvent.setup>) {
    const pickers = await screen.findAllByRole("combobox");
    await user.click(pickers[0]);
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
            <BulkTagDialog open selectedCount={3} onOpenChange={onOpenChange} onApply={vi.fn()} />,
        );

        // Act — choose a tag, dismiss, reopen
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await waitFor(() => expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0));
        rerender(
            <BulkTagDialog open={false} selectedCount={3} onOpenChange={onOpenChange} onApply={vi.fn()} />,
        );
        rerender(
            <BulkTagDialog open selectedCount={5} onOpenChange={onOpenChange} onApply={vi.fn()} />,
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
            <BulkTagDialog open selectedCount={3} onOpenChange={onOpenChange} onApply={vi.fn()} />,
        );

        // Act — Cancel is a deliberate discard, unlike a dismissal
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await waitFor(() => expect(screen.getAllByText(/1 tags/i).length).toBeGreaterThan(0));
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        rerender(
            <BulkTagDialog open={false} selectedCount={3} onOpenChange={onOpenChange} onApply={vi.fn()} />,
        );
        rerender(
            <BulkTagDialog open selectedCount={3} onOpenChange={onOpenChange} onApply={vi.fn()} />,
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
            <BulkTagDialog open selectedCount={3} onOpenChange={onOpenChange} onApply={onApply} />,
        );

        // Act
        await screen.findByRole("dialog");
        await pickFirstAddTag(user);
        await user.click(await screen.findByRole("button", { name: /apply/i }));

        // Assert — applied once, and the picker is back to empty
        expect(onApply).toHaveBeenCalledWith(["groceries"], []);
        await waitFor(() =>
            expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled(),
        );
    });
});
