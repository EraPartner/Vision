// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { RecipientPatternsDialog } from "@/features/recipients/RecipientPatternsDialog";
import type { RecipientPattern } from "@/lib/api";

const API_BASE = "http://localhost:3002";

const PATTERN_STUB: RecipientPattern = {
    id: 1,
    pattern: "RENT*",
    pattern_kind: "glob",
    case_sensitive: false,
    priority: 1,
    is_active: true,
    source: "user",
    notes: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
};

const RECIPIENT_ID = 1;
const RECIPIENT_NAME = "Landlord";

function renderDialog(open = true, onOpenChange = vi.fn()) {
    return renderWithApp(
        <RecipientPatternsDialog
            open={open}
            onOpenChange={onOpenChange}
            recipientId={RECIPIENT_ID}
            recipientName={RECIPIENT_NAME}
        />,
    );
}

describe("RecipientPatternsDialog", () => {
    it("renders the dialog when open=true", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        // Act
        renderDialog();

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("fetches and displays the patterns list on open", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [PATTERN_STUB], total: 1 }),
            ),
        );

        // Act
        renderDialog();

        // Assert — pattern text is rendered inside the dialog
        expect(await screen.findByText("RENT*")).toBeInTheDocument();
    });

    it("shows empty state when no patterns exist", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        // Act
        renderDialog();

        // Assert — empty-state paragraph rendered (recipientPatterns.empty key)
        expect(await screen.findByText(/no patterns/i)).toBeInTheDocument();
    });

    it("'Add Pattern' button is visible when no form is open", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        // Act
        renderDialog();
        await screen.findByRole("dialog");

        // Assert — add button present (recipientPatterns.addBtn key)
        expect(await screen.findByRole("button", { name: /add pattern/i })).toBeInTheDocument();
    });

    it("clicking 'Add Pattern' shows the inline form", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );
        const user = userEvent.setup();
        renderDialog();

        // Act
        await user.click(await screen.findByRole("button", { name: /add pattern/i }));

        // Assert — pattern input from the inline form is now visible
        expect(await screen.findByRole("textbox", { name: /pattern/i })).toBeInTheDocument();
    });

    it("submitting new pattern calls POST and closes inline form on success", async () => {
        // Arrange
        let posted = false;
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
            http.post(`${API_BASE}/api/recipients/:id/patterns`, () => {
                posted = true;
                return ok({ id: 2 });
            }),
        );
        const user = userEvent.setup();
        renderDialog();

        // Act — open form, type a pattern, save
        await user.click(await screen.findByRole("button", { name: /add pattern/i }));
        const patternInput = await screen.findByRole("textbox", { name: /pattern/i });
        await user.type(patternInput, "SALARY*");
        await user.click(await screen.findByRole("button", { name: /save/i }));

        // Assert — POST was called and the form is hidden (add button reappears)
        await waitFor(() => expect(posted).toBe(true));
        expect(await screen.findByRole("button", { name: /add pattern/i })).toBeInTheDocument();
    });

    it("clicking the edit button on a pattern shows the inline form pre-populated", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [PATTERN_STUB], total: 1 }),
            ),
        );
        const user = userEvent.setup();
        renderDialog();

        // Wait for pattern row to appear
        await screen.findByText("RENT*");

        // Act — click the edit (pencil) button; the button has sr-only text "Edit"
        const editButton = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editButton);

        // Assert — inline form appears pre-populated with the existing pattern value
        const patternInput = await screen.findByRole("textbox", { name: /pattern/i });
        expect(patternInput).toHaveValue("RENT*");
    });

    it("submitting the edited pattern calls PATCH", async () => {
        // Arrange
        let patched = false;
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [PATTERN_STUB], total: 1 }),
            ),
            http.patch(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () => {
                patched = true;
                return ok({ patternId: 1 });
            }),
        );
        const user = userEvent.setup();
        renderDialog();

        // Act — open edit form, clear input, type new value, save
        await screen.findByText("RENT*");
        const editButton = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editButton);
        const patternInput = await screen.findByRole("textbox", { name: /pattern/i });
        await user.clear(patternInput);
        await user.type(patternInput, "RENT_UPDATED*");
        await user.click(await screen.findByRole("button", { name: /save/i }));

        // Assert
        await waitFor(() => expect(patched).toBe(true));
    });

    it("clicking delete shows confirmation dialog, confirm calls DELETE", async () => {
        // Arrange
        let deleted = false;
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [PATTERN_STUB], total: 1 }),
            ),
            http.delete(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () => {
                deleted = true;
                return ok({ patternId: 1 });
            }),
        );
        const user = userEvent.setup();
        renderDialog();

        // Act — wait for pattern row, click trash button (icon-only, no accessible name)
        await screen.findByText("RENT*");
        const patternRow = screen.getByText("RENT*").closest(".rounded-lg") as HTMLElement;
        // Pattern row buttons (role=button, Switch is role=switch): [Edit, Trash]
        const [, trashBtn] = within(patternRow).getAllByRole("button");
        await user.click(trashBtn);

        // Confirm dialog should appear (AlertDialog)
        const confirmButton = await screen.findByRole("button", { name: /delete/i });
        await user.click(confirmButton);

        // Assert — DELETE was called
        await waitFor(() => expect(deleted).toBe(true));
    });

    it("close button calls onOpenChange(false)", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );
        const onOpenChange = vi.fn();
        const user = userEvent.setup();
        renderDialog(true, onOpenChange);
        await screen.findByRole("dialog");

        // Act — press Escape to close (triggers onOpenChange via Radix Dialog)
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );
        renderDialog();
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });
});
