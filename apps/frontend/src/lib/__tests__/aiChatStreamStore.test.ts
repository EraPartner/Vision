// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api";
import { aiChatStreamStore } from "@/lib/aiChatStreamStore";
import { aiKeys } from "@/lib/queryKeys";
import type { ChatStreamEvent } from "@/types/aiChat";

const CONVERSATION_ID = "stream-test-conversation";

function deferredStream() {
    let emit!: (event: ChatStreamEvent) => void;
    let reject!: (reason: unknown) => void;
    const abort = vi.fn();

    const spy = vi
        .spyOn(apiClient, "streamChat")
        .mockImplementation((_body, onEvent) => {
            emit = onEvent;
            return {
                abort,
                result: new Promise((_resolve, rejectPromise) => {
                    reject = rejectPromise;
                }),
            };
        });

    return {
        abort,
        emit: (event: ChatStreamEvent) => emit(event),
        reject: (reason: unknown) => reject(reason),
        spy,
    };
}

function request() {
    return {
        conversationId: CONVERSATION_ID,
        message: "Explain this",
        model: "test-model",
        useTools: true,
    };
}

afterEach(() => {
    aiChatStreamStore.clear(CONVERSATION_ID);
    vi.restoreAllMocks();
});

describe("aiChatStreamStore interrupted drafts", () => {
    it("ignores late events and rejection from an older generation", async () => {
        const first = deferredStream();
        const firstSend = aiChatStreamStore.send(
            request(),
            new QueryClient(),
            vi.fn(),
        );
        first.emit({ type: "token", delta: "old" });

        const second = deferredStream();
        const secondSend = aiChatStreamStore.send(
            { ...request(), message: "new request" },
            new QueryClient(),
            vi.fn(),
        );
        first.emit({ type: "token", delta: " stale" });
        first.reject(new Error("old connection dropped"));
        second.emit({ type: "token", delta: "new" });

        await expect(firstSend).resolves.toBeNull();
        expect(first.abort).toHaveBeenCalledOnce();
        expect(aiChatStreamStore.getState(CONVERSATION_ID)).toMatchObject({
            isStreaming: true,
            status: "streaming",
            assistantDraft: "new",
        });

        aiChatStreamStore.cancel(CONVERSATION_ID);
        second.reject(new Error("Chat cancelled"));
        await expect(secondSend).resolves.toBeNull();
    });

    it("retains a partial response and marks a manual cancellation as stopped", async () => {
        const stream = deferredStream();
        const onError = vi.fn();
        const send = aiChatStreamStore.send(
            request(),
            new QueryClient(),
            onError,
        );

        stream.emit({ type: "token", delta: "Partial" });
        aiChatStreamStore.cancel(CONVERSATION_ID);
        stream.reject(new Error("Chat cancelled"));

        await expect(send).resolves.toBeNull();
        expect(stream.abort).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        expect(aiChatStreamStore.getState(CONVERSATION_ID)).toMatchObject({
            isStreaming: false,
            status: "stopped",
            assistantDraft: "Partial",
            error: null,
            lastRequest: request(),
        });
    });

    it.each([
        ["connection dropped", "interrupted"],
        ["Chat stream timed out", "timed_out"],
    ] as const)(
        "retains partial output after %s and records %s",
        async (message, status) => {
            const stream = deferredStream();
            const onError = vi.fn();
            const send = aiChatStreamStore.send(
                request(),
                new QueryClient(),
                onError,
            );

            stream.emit({ type: "token", delta: "Still useful" });
            stream.reject(new Error(message));

            await expect(send).resolves.toBeNull();
            expect(onError).toHaveBeenCalledOnce();
            expect(aiChatStreamStore.getState(CONVERSATION_ID)).toMatchObject({
                isStreaming: false,
                status,
                assistantDraft: "Still useful",
                error: message,
                lastRequest: request(),
            });
        },
    );

    it("replaces a retry draft with the persisted completed turn", async () => {
        const stream = deferredStream();
        const queryClient = new QueryClient();
        const onError = vi.fn();
        const completed = {
            conversation: { id: CONVERSATION_ID },
            messages: [
                { id: "user-1", role: "user", content: "Explain this" },
                { id: "assistant-1", role: "assistant", content: "Finished" },
            ],
        };
        vi.spyOn(apiClient, "getConversation").mockResolvedValue(
            completed as never,
        );
        const send = aiChatStreamStore.send(
            { ...request(), retryLastTurn: true },
            queryClient,
            onError,
        );
        stream.emit({ type: "token", delta: "Frozen partial" });
        stream.reject(
            Object.assign(new Error("The latest turn is already complete"), {
                code: "TURN_ALREADY_COMPLETE",
            }),
        );

        await expect(send).resolves.toBeNull();
        expect(onError).not.toHaveBeenCalled();
        expect(aiChatStreamStore.getState(CONVERSATION_ID)).toEqual(
            expect.objectContaining({ status: "idle", assistantDraft: "" }),
        );
        expect(
            queryClient.getQueryData(aiKeys.conversation(CONVERSATION_ID)),
        ).toEqual(completed);
    });

    it("does not let a delayed completed-turn refresh overwrite a newer send", async () => {
        const first = deferredStream();
        const queryClient = new QueryClient();
        let resolveRefresh!: (
            value: Awaited<ReturnType<typeof apiClient.getConversation>>,
        ) => void;
        vi.spyOn(apiClient, "getConversation").mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveRefresh = resolve;
                }),
        );
        const firstSend = aiChatStreamStore.send(
            { ...request(), retryLastTurn: true },
            queryClient,
            vi.fn(),
        );
        first.reject(
            Object.assign(new Error("already complete"), {
                code: "TURN_ALREADY_COMPLETE",
            }),
        );
        await vi.waitFor(() => {
            expect(apiClient.getConversation).toHaveBeenCalledOnce();
        });

        const second = deferredStream();
        const secondSend = aiChatStreamStore.send(
            { ...request(), message: "newer turn" },
            queryClient,
            vi.fn(),
        );
        const newer = {
            conversation: { id: CONVERSATION_ID },
            messages: [
                { id: "assistant-new", role: "assistant", content: "Newer" },
            ],
        };
        queryClient.setQueryData(aiKeys.conversation(CONVERSATION_ID), newer);
        resolveRefresh({
            conversation: { id: CONVERSATION_ID },
            messages: [
                {
                    id: "assistant-old",
                    role: "assistant",
                    content: "Old",
                },
            ],
        } as never);

        await expect(firstSend).resolves.toBeNull();
        expect(
            queryClient.getQueryData(aiKeys.conversation(CONVERSATION_ID)),
        ).toEqual(newer);

        aiChatStreamStore.cancel(CONVERSATION_ID);
        second.reject(new Error("Chat cancelled"));
        await secondSend;
    });
});

describe("aiChatStreamStore token coalescing", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("emits once per frame for tokens and flushes terminal events synchronously", async () => {
        // Node has no requestAnimationFrame, so the store uses its timer
        // fallback; fake timers stand in for the frame boundary.
        vi.useFakeTimers();
        const stream = deferredStream();
        const drafts: string[] = [];
        const unsubscribe = aiChatStreamStore.subscribe(() => {
            drafts.push(
                aiChatStreamStore.getState(CONVERSATION_ID).assistantDraft,
            );
        });
        const send = aiChatStreamStore.send(
            request(),
            new QueryClient(),
            vi.fn(),
        );
        drafts.length = 0; // drop the synchronous stream-start emit

        stream.emit({ type: "token", delta: "Hel" });
        stream.emit({ type: "token", delta: "lo" });
        stream.emit({ type: "token", delta: " there" });
        // State is current immediately; only the notification waits.
        expect(drafts).toEqual([]);
        expect(aiChatStreamStore.getState(CONVERSATION_ID).assistantDraft).toBe(
            "Hello there",
        );
        vi.runOnlyPendingTimers();
        expect(drafts).toEqual(["Hello there"]);

        stream.emit({ type: "token", delta: "," });
        stream.emit({ type: "token", delta: " friend" });
        stream.emit({ type: "error", detail: "model crashed" });
        // The terminal event emits synchronously with the full draft, and
        // takes the pending frame with it: nothing fires afterwards.
        expect(drafts).toEqual(["Hello there", "Hello there, friend"]);
        expect(vi.getTimerCount()).toBe(0);
        vi.runOnlyPendingTimers();
        expect(drafts).toHaveLength(2);
        expect(aiChatStreamStore.getState(CONVERSATION_ID)).toMatchObject({
            isStreaming: false,
            status: "interrupted",
            assistantDraft: "Hello there, friend",
        });

        unsubscribe();
        aiChatStreamStore.cancel(CONVERSATION_ID);
        stream.reject(new Error("Chat cancelled"));
        await send;
    });

    it("flushes a pending token frame synchronously on complete", async () => {
        vi.useFakeTimers();
        const stream = deferredStream();
        const queryClient = new QueryClient();
        queryClient.setQueryData(aiKeys.conversation(CONVERSATION_ID), {
            conversation: { id: CONVERSATION_ID },
            messages: [],
        });
        const seen: string[] = [];
        const unsubscribe = aiChatStreamStore.subscribe(() => {
            const state = aiChatStreamStore.getState(CONVERSATION_ID);
            seen.push(state.isStreaming ? state.assistantDraft : "done");
        });
        const send = aiChatStreamStore.send(request(), queryClient, vi.fn());
        seen.length = 0;

        stream.emit({ type: "token", delta: "Full" });
        stream.emit({ type: "token", delta: " answer" });
        stream.emit({
            type: "complete",
            payload: {
                conversation: { id: CONVERSATION_ID },
                assistantMessage: {
                    id: "assistant-1",
                    role: "assistant",
                    content: "Full answer",
                },
            },
        } as never);

        expect(seen).toEqual(["done"]);
        expect(vi.getTimerCount()).toBe(0);
        expect(
            queryClient.getQueryData(aiKeys.conversation(CONVERSATION_ID)),
        ).toMatchObject({
            messages: [{ id: "assistant-1", content: "Full answer" }],
        });

        unsubscribe();
        stream.reject(new Error("Chat cancelled"));
        await send;
    });

    it("drops a pending token frame when the stream is cancelled", async () => {
        vi.useFakeTimers();
        const stream = deferredStream();
        const listener = vi.fn();
        const unsubscribe = aiChatStreamStore.subscribe(listener);
        const send = aiChatStreamStore.send(
            request(),
            new QueryClient(),
            vi.fn(),
        );
        listener.mockClear();

        stream.emit({ type: "token", delta: "Partial" });
        aiChatStreamStore.cancel(CONVERSATION_ID);
        expect(listener).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);

        unsubscribe();
        stream.reject(new Error("Chat cancelled"));
        await send;
    });
});
