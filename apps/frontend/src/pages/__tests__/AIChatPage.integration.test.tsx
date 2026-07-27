// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import AIChatPage from "@/pages/AIChatPage";

const API_BASE = "http://localhost:3002";

describe("AIChatPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByRole("heading", { name: /ai chat/i }),
        ).toBeInTheDocument();
    });

    it("shows AI unreachable status when local model is disabled", async () => {
        renderWithApp(<AIChatPage />);
        // Default MSW handler returns { ok: false } — banner has role="alert"
        expect(await screen.findByRole("alert")).toBeInTheDocument();
    });

    it("renders empty state heading when no messages exist", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByRole("heading", { name: /ask anything about your finances/i }),
        ).toBeInTheDocument();
    });

    it("disables composer textarea when local AI is unreachable", async () => {
        renderWithApp(<AIChatPage />);
        // Default MSW returns { ok: false } → composerDisabled = true
        const textarea = await screen.findByPlaceholderText(/ask about your spending/i);
        expect(textarea).toBeDisabled();
    });

    it("shows Retry button in status banner when AI is unreachable", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByRole("button", { name: /retry/i }),
        ).toBeInTheDocument();
    });

    it("shows New Conversation button in sidebar", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByRole("button", { name: /new conversation/i }),
        ).toBeInTheDocument();
    });

    it("shows Conversations sidebar label", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByText(/conversations/i),
        ).toBeInTheDocument();
    });

    it("shows unreachable status label in header", async () => {
        renderWithApp(<AIChatPage />);
        // Status label reflects { ok: false } from MSW — appears in both the header
        // and the OllamaStatusBanner alert; verify at least one is present
        const matches = await screen.findAllByText(/local ai model unreachable/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("shows no conversations yet text in sidebar", async () => {
        renderWithApp(<AIChatPage />);
        // Default MSW returns empty conversation list → aiChat.noConversations
        expect(
            await screen.findByText(/no conversations yet/i),
        ).toBeInTheDocument();
    });

    it("shows empty state body text", async () => {
        renderWithApp(<AIChatPage />);
        // aiChat.emptyState = "Start a conversation -- ask about spending, portfolio returns..."
        expect(
            await screen.findByText(/start a conversation/i),
        ).toBeInTheDocument();
    });

    it("shows banner install hint text", async () => {
        renderWithApp(<AIChatPage />);
        // aiChat.banner.hint = "Install Ollama and start it locally to enable chat."
        expect(
            await screen.findByText(/install ollama/i),
        ).toBeInTheDocument();
    });

    it("enables composer textarea when AI is reachable", async () => {
        server.use(
            http.get(`${API_BASE}/api/ai/status`, () =>
                ok({ ok: true, baseUrl: "http://localhost:11434", defaultModel: "llama3", enabled: true }),
            ),
        );

        renderWithApp(<AIChatPage />);

        const textarea = await screen.findByPlaceholderText(/ask about your spending/i);
        expect(textarea).not.toBeDisabled();
    });

    it("shows 'Local AI model ready' status label when AI is reachable", async () => {
        server.use(
            http.get(`${API_BASE}/api/ai/status`, () =>
                ok({ ok: true, baseUrl: "http://localhost:11434", defaultModel: "llama3", enabled: true }),
            ),
        );

        renderWithApp(<AIChatPage />);

        // aiChat.ollamaReady = "Local AI model ready"
        const matches = await screen.findAllByText(/local ai model ready/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("does not show OllamaStatusBanner when AI is reachable", async () => {
        server.use(
            http.get(`${API_BASE}/api/ai/status`, () =>
                ok({ ok: true, baseUrl: "http://localhost:11434", defaultModel: "llama3", enabled: true }),
            ),
        );

        renderWithApp(<AIChatPage />);

        // Banner alert only shown when unreachable; wait for status to resolve
        await screen.findByPlaceholderText(/ask about your spending/i);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows unreachable banner when AI status API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/ai/status`, () => err(500, "service unavailable")),
        );
        renderWithApp(<AIChatPage />);
        // apiRequest retries on 500 (MAX_RETRIES=2, ~1.5 s backoff) — needs extended timeout
        expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("shows unreachable banner when AI status API returns 403", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/ai/status`, () => err(403, "Forbidden")),
        );
        renderWithApp(<AIChatPage />);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("clicking New Conversation button updates header title", async () => {
        const user = userEvent.setup();

        server.use(
            http.post(`${API_BASE}/api/ai/conversations`, () =>
                ok({
                    conversation: { id: "conv-1", title: "New Conversation", model: "llama3", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
                    messages: [],
                }),
            ),
            http.get(`${API_BASE}/api/ai/conversations/conv-1`, () =>
                ok({
                    conversation: { id: "conv-1", title: "New Conversation", model: "llama3", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
                    messages: [],
                }),
            ),
        );

        renderWithApp(<AIChatPage />);

        const newConvBtn = await screen.findByRole("button", { name: /new conversation/i });
        await user.click(newConvBtn);

        // After click, header title updates to the new conversation title
        expect(await screen.findByRole("heading", { name: /new conversation/i })).toBeInTheDocument();
    });

    it("clicking insights digest quick action sends the fixed prompt with tools forced on and insightsPreCall", async () => {
        const user = userEvent.setup();
        const conversation = {
            id: "conv-digest",
            title: "New Conversation",
            model: "llama3",
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
        };
        let capturedBody: Record<string, unknown> | null = null;

        server.use(
            http.get(`${API_BASE}/api/ai/status`, () =>
                ok({ ok: true, baseUrl: "http://localhost:11434", defaultModel: "llama3", enabled: true }),
            ),
            http.post(`${API_BASE}/api/ai/conversations`, () =>
                ok({ conversation, messages: [] }),
            ),
            http.get(`${API_BASE}/api/ai/conversations/conv-digest`, () =>
                ok({ conversation, messages: [] }),
            ),
            http.post(`${API_BASE}/api/ai/chat/stream`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                const donePayload = {
                    conversation,
                    assistantMessage: {
                        id: "msg-assistant-1",
                        role: "assistant",
                        content: "Here is your digest",
                        createdAt: "2025-01-01T00:00:01.000Z",
                    },
                    usage: { evalCount: 1, promptEvalCount: 1, totalDurationMs: 2 },
                    iterations: 1,
                };
                return new HttpResponse(
                    `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }),
        );

        renderWithApp(<AIChatPage />);

        // Fresh conversation → empty state with the quick-action button
        const digestBtn = await screen.findByRole("button", { name: /show my insights digest/i });
        await waitFor(() => expect(digestBtn).not.toBeDisabled());
        await user.click(digestBtn);

        await waitFor(() => expect(capturedBody).not.toBeNull());
        expect(capturedBody).toMatchObject({
            conversationId: "conv-digest",
            message: "Give me my insights digest for today — anything new or unusual in my spending?",
            useTools: true,
            insightsPreCall: true,
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when conversations list returns 4xx", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/ai/conversations`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<AIChatPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
