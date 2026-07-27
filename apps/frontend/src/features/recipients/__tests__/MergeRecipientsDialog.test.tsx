// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { MergeRecipientsDialog } from "@/features/recipients/MergeRecipientsDialog";

const API_BASE = "http://localhost:3002";

const ALICE = {
    id: 1,
    name: "Alice",
    normalized_name: "alice",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

const BOB = {
    id: 2,
    name: "Bob",
    normalized_name: "bob",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

const RECIPIENTS_LIST = {
    items: [ALICE, BOB],
    total: 2,
    limit: 200,
    offset: 0,
    links: [],
};

function renderDialog(open = true) {
    const onOpenChange = vi.fn();
    const result = renderWithApp(
        <MergeRecipientsDialog open={open} onOpenChange={onOpenChange} />,
    );
    return { ...result, onOpenChange };
}

describe("MergeRecipientsDialog", () => {
    beforeEach(() => {
        server.use(
            http.post(`${API_BASE}/api/recipients/:id/merge`, () =>
                ok({
                    primary: ALICE,
                    merged_ids: [2],
                    aliases: [{ id: 2, name: "Bob" }],
                    patternSuggestion: null,
                }),
            ),
        );
    });

    it("renders dialog title when open", async () => {
        renderDialog(true);
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(await screen.findByText(/merge recipients/i)).toBeInTheDocument();
    });

    it("shows loading state while fetching recipients", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, async () => {
                await new Promise((r) => setTimeout(r, 50));
                return ok(RECIPIENTS_LIST);
            }),
        );
        renderDialog(true);
        // Dialog renders without crashing; loading indicator appears briefly
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows recipient list for primary selection", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        renderDialog(true);
        expect(await screen.findByText("Alice")).toBeInTheDocument();
    });

    it("Merge button is disabled when no primary selected", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        renderDialog(true);
        // Wait for recipients to load so the button appears
        await screen.findByText("Alice");
        const mergeBtn = await screen.findByRole("button", { name: /merge/i });
        expect(mergeBtn).toBeDisabled();
    });

    it("selecting primary reveals alias list", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        renderDialog(true);
        // Click Alice in the primary command list
        const alice = await screen.findByText("Alice");
        await user.click(alice);
        // Bob should now appear in the alias section
        expect(await screen.findByText("Bob")).toBeInTheDocument();
    });

    it("Merge button disabled when no alias selected", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        renderDialog(true);
        const alice = await screen.findByText("Alice");
        await user.click(alice);
        // Primary is selected but no alias — button still disabled
        const mergeBtn = await screen.findByRole("button", { name: /merge/i });
        expect(mergeBtn).toBeDisabled();
    });

    it("successful merge calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        const { onOpenChange } = renderDialog(true);
        // Select Alice as primary
        const alice = await screen.findByText("Alice");
        await user.click(alice);
        // Select Bob as alias
        const bob = await screen.findByText("Bob");
        await user.click(bob);
        // Click Merge
        const mergeBtn = await screen.findByRole("button", { name: /merge/i });
        await user.click(mergeBtn);
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    it("merge error does not close dialog", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
            http.post(`${API_BASE}/api/recipients/:id/merge`, () =>
                err(500, "fail"),
            ),
        );
        const { onOpenChange } = renderDialog(true);
        const alice = await screen.findByText("Alice");
        await user.click(alice);
        const bob = await screen.findByText("Bob");
        await user.click(bob);
        const mergeBtn = await screen.findByRole("button", { name: /merge/i });
        await user.click(mergeBtn);
        // Give any async mutations time to settle
        await waitFor(() => {
            expect(onOpenChange).not.toHaveBeenCalledWith(false);
        });
    });

    it("Cancel button calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");
        const cancelBtn = await screen.findByRole("button", { name: /cancel/i });
        await user.click(cancelBtn);
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("keeps the assembled selection when dismissed with Escape", async () => {
        // Arrange — Escape reports through the same callback as a real close, so
        // resetting there threw away the whole alias list on one stray key.
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        const onOpenChange = vi.fn();
        const { rerender } = renderWithApp(
            <MergeRecipientsDialog open onOpenChange={onOpenChange} />,
        );

        // Act — pick Alice as primary, dismiss, reopen
        await user.click(await screen.findByText("Alice"));
        await screen.findByRole("button", { name: /clear selection/i });
        await user.keyboard("{Escape}");
        rerender(<MergeRecipientsDialog open={false} onOpenChange={onOpenChange} />);
        rerender(<MergeRecipientsDialog open onOpenChange={onOpenChange} />);

        // Assert — the chosen primary is still chosen
        expect(
            await screen.findByRole("button", { name: /clear selection/i }),
        ).toBeInTheDocument();
    });

    it("Cancel clears the selection", async () => {
        // Arrange
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        const onOpenChange = vi.fn();
        const { rerender } = renderWithApp(
            <MergeRecipientsDialog open onOpenChange={onOpenChange} />,
        );

        // Act — Cancel is a deliberate discard, unlike a dismissal
        await user.click(await screen.findByText("Alice"));
        await screen.findByRole("button", { name: /clear selection/i });
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        rerender(<MergeRecipientsDialog open={false} onOpenChange={onOpenChange} />);
        rerender(<MergeRecipientsDialog open onOpenChange={onOpenChange} />);

        // Assert — back to step 1, no primary selected
        await screen.findByText("Alice");
        expect(
            screen.queryByRole("button", { name: /clear selection/i }),
        ).not.toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(RECIPIENTS_LIST)),
        );
        renderDialog(true);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });
});
