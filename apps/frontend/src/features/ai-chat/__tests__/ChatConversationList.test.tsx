// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { ChatConversationList } from "@/features/ai-chat/ChatConversationList";
import type { ConversationSummary } from "@/types/aiChat";

const API_BASE = "http://localhost:3002";

const baseConversation: ConversationSummary = {
    id: "conv-1",
    title: "Spending review",
    model: "llama3",
    createdAt: "2025-01-01T10:00:00.000Z",
    updatedAt: "2025-01-02T10:00:00.000Z",
};

const secondConversation: ConversationSummary = {
    id: "conv-2",
    title: "Tax questions",
    model: "llama3",
    createdAt: "2025-01-03T10:00:00.000Z",
    updatedAt: "2025-01-04T10:00:00.000Z",
};

function stubConversations(items: ConversationSummary[], total = items.length) {
    server.use(
        http.get(`${API_BASE}/api/ai/conversations`, () =>
            ok({ items, total, limit: 50, offset: 0 }),
        ),
    );
}

describe("ChatConversationList", () => {
    it("renders empty state when no conversations exist", async () => {
        const onSelect = vi.fn();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        expect(
            await screen.findByText(/no conversations yet/i),
        ).toBeInTheDocument();
    });

    it("renders the conversations list with their titles", async () => {
        stubConversations([baseConversation, secondConversation]);
        const onSelect = vi.fn();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        expect(await screen.findByText("Spending review")).toBeInTheDocument();
        expect(await screen.findByText("Tax questions")).toBeInTheDocument();
    });

    it("loads the next conversation page on demand", async () => {
        server.use(
            http.get(`${API_BASE}/api/ai/conversations`, ({ request }) => {
                const offset = Number(
                    new URL(request.url).searchParams.get("offset"),
                );
                return offset === 0
                    ? ok({
                          items: [baseConversation],
                          total: 2,
                          limit: 50,
                          offset: 0,
                      })
                    : ok({
                          items: [secondConversation],
                          total: 2,
                          limit: 50,
                          offset,
                      });
            }),
        );
        const user = userEvent.setup();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={vi.fn()} />,
        );

        await screen.findByText("Spending review");
        await user.click(screen.getByRole("button", { name: /load more/i }));
        expect(await screen.findByText("Tax questions")).toBeInTheDocument();
    });

    it("falls back to the untitled label when title is empty", async () => {
        const untitled: ConversationSummary = {
            ...baseConversation,
            title: "",
        };
        stubConversations([untitled]);
        const onSelect = vi.fn();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        expect(
            await screen.findByText(/untitled|new conversation/i),
        ).toBeInTheDocument();
    });

    it("calls onSelect with the conversation id when a row is clicked", async () => {
        stubConversations([baseConversation, secondConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        const item = await screen.findByText("Tax questions");
        await user.click(item);

        expect(onSelect).toHaveBeenCalledWith("conv-2");
    });

    it("creates a new conversation and selects it via the new-conversation button", async () => {
        stubConversations([]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        const createdId = "conv-new";
        server.use(
            http.post(`${API_BASE}/api/ai/conversations`, () =>
                ok({
                    conversation: {
                        id: createdId,
                        title: "New chat",
                        model: "llama3",
                        createdAt: "2025-01-10T10:00:00.000Z",
                        updatedAt: "2025-01-10T10:00:00.000Z",
                    },
                    messages: [],
                }),
            ),
        );

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        const newBtn = await screen.findByRole("button", {
            name: /new conversation/i,
        });
        await user.click(newBtn);

        await waitFor(() => {
            expect(onSelect).toHaveBeenCalledWith(createdId);
        });
    });

    it("opens the rename dialog and submits a PATCH request", async () => {
        stubConversations([baseConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        let patchedTitle: string | null = null;
        server.use(
            http.patch(
                `${API_BASE}/api/ai/conversations/:id`,
                async ({ request }) => {
                    const body = (await request.json()) as { title: string };
                    patchedTitle = body.title;
                    return ok({
                        id: baseConversation.id,
                        title: body.title,
                        model: baseConversation.model,
                        updatedAt: "2025-01-05T10:00:00.000Z",
                    });
                },
            ),
        );

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        await screen.findByText("Spending review");

        const actionBtns = screen.getAllByRole("button", {
            name: /conversation actions/i,
        });
        await user.click(actionBtns[0]);

        const renameItem = await screen.findByRole("menuitem", {
            name: /rename/i,
        });
        await user.click(renameItem);

        const dialog = await screen.findByRole("alertdialog");
        const input = within(dialog).getByRole("textbox");
        await user.clear(input);
        await user.type(input, "Renamed chat");

        const saveBtn = within(dialog).getByRole("button", { name: /save/i });
        await user.click(saveBtn);

        await waitFor(() => {
            expect(patchedTitle).toBe("Renamed chat");
        });
    });

    it("disables the rename Save button when title is empty", async () => {
        stubConversations([baseConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        await screen.findByText("Spending review");

        const actionBtn = screen.getAllByRole("button", {
            name: /conversation actions/i,
        })[0];
        await user.click(actionBtn);
        const renameItem = await screen.findByRole("menuitem", {
            name: /rename/i,
        });
        await user.click(renameItem);

        const dialog = await screen.findByRole("alertdialog");
        const input = within(dialog).getByRole("textbox");
        await user.clear(input);

        const saveBtn = within(dialog).getByRole("button", { name: /save/i });
        expect(saveBtn).toBeDisabled();
    });

    it("opens the delete confirmation dialog and calls DELETE on confirm", async () => {
        stubConversations([baseConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        let deletedId: string | null = null;
        server.use(
            http.delete(
                `${API_BASE}/api/ai/conversations/:id`,
                ({ params }) => {
                    deletedId = String(params.id);
                    return ok({ ok: true });
                },
            ),
        );

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        await screen.findByText("Spending review");

        const actionBtn = screen.getAllByRole("button", {
            name: /conversation actions/i,
        })[0];
        await user.click(actionBtn);

        const deleteItem = await screen.findByRole("menuitem", {
            name: /delete/i,
        });
        await user.click(deleteItem);

        const dialog = await screen.findByRole("alertdialog");
        expect(
            within(dialog).getByText(/delete conversation\?/i),
        ).toBeInTheDocument();

        const confirmBtn = within(dialog).getByRole("button", {
            name: /^delete$/i,
        });
        await user.click(confirmBtn);

        await waitFor(() => {
            expect(deletedId).toBe(baseConversation.id);
        });
    });

    it("clears selection when deleting the currently selected conversation", async () => {
        stubConversations([baseConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        server.use(
            http.delete(`${API_BASE}/api/ai/conversations/:id`, () =>
                ok({ ok: true }),
            ),
        );

        renderWithApp(
            <ChatConversationList
                selectedId={baseConversation.id}
                onSelect={onSelect}
            />,
        );

        await screen.findByText("Spending review");

        const actionBtn = screen.getAllByRole("button", {
            name: /conversation actions/i,
        })[0];
        await user.click(actionBtn);
        const deleteItem = await screen.findByRole("menuitem", {
            name: /delete/i,
        });
        await user.click(deleteItem);

        const dialog = await screen.findByRole("alertdialog");
        const confirmBtn = within(dialog).getByRole("button", {
            name: /^delete$/i,
        });
        await user.click(confirmBtn);

        await waitFor(() => {
            expect(onSelect).toHaveBeenCalledWith(null);
        });
    });

    it("dismisses the delete dialog without calling DELETE when Cancel is clicked", async () => {
        stubConversations([baseConversation]);
        const onSelect = vi.fn();
        const user = userEvent.setup();

        let deleteCalled = false;
        server.use(
            http.delete(`${API_BASE}/api/ai/conversations/:id`, () => {
                deleteCalled = true;
                return ok({ ok: true });
            }),
        );

        renderWithApp(
            <ChatConversationList selectedId={null} onSelect={onSelect} />,
        );

        await screen.findByText("Spending review");

        const actionBtn = screen.getAllByRole("button", {
            name: /conversation actions/i,
        })[0];
        await user.click(actionBtn);
        const deleteItem = await screen.findByRole("menuitem", {
            name: /delete/i,
        });
        await user.click(deleteItem);

        const dialog = await screen.findByRole("alertdialog");
        const cancelBtn = within(dialog).getByRole("button", {
            name: /cancel/i,
        });
        await user.click(cancelBtn);

        await waitFor(() => {
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        });
        expect(deleteCalled).toBe(false);
    });
});
