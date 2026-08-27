// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ChatMessageList } from "@/features/ai-chat/ChatMessageList";
import type { ChatMessage } from "@/types/aiChat";

const chatBubbleRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("@/features/ai-chat/ChatBubble", async () => {
    const { memo } = await import("react");
    return {
        ChatBubble: memo(
            ({
                message,
                streaming,
            }: {
                message: ChatMessage;
                streaming?: boolean;
            }) => {
                chatBubbleRenderSpy({ message, streaming });
                return (
                    <div data-testid={`chat-bubble-${message.id}`}>
                        {message.content}
                    </div>
                );
            },
        ),
    };
});

const firstConversation: ChatMessage[] = [
    {
        id: "first-user",
        role: "user",
        content: "First question",
        createdAt: "2026-08-22T08:00:00.000Z",
    },
    {
        id: "first-assistant",
        role: "assistant",
        content: "First answer",
        createdAt: "2026-08-22T08:00:01.000Z",
    },
];

const secondConversation: ChatMessage[] = [
    {
        id: "second-user",
        role: "user",
        content: "Second question",
        createdAt: "2026-08-22T09:00:00.000Z",
    },
    {
        id: "second-assistant",
        role: "assistant",
        content: "Second answer",
        createdAt: "2026-08-22T09:00:01.000Z",
    },
];

function renderMessageList(
    messages: ChatMessage[],
    conversationId: string,
    assistantDraft = "",
) {
    return render(
        <LanguageProvider language="en" setLanguage={vi.fn()}>
            <ChatMessageList
                messages={messages}
                streamingUserMessage={null}
                streamingToolMessages={[]}
                assistantDraft={assistantDraft}
                isStreaming={assistantDraft.length > 0}
                conversationId={conversationId}
            />
        </LanguageProvider>,
    );
}

function setScrollableGeometry(el: HTMLElement) {
    Object.defineProperties(el, {
        scrollHeight: { configurable: true, value: 1_200 },
        clientHeight: { configurable: true, value: 200 },
    });
}

function scrollUpFromBottom(el: HTMLElement) {
    el.scrollTop = 1_000;
    fireEvent.scroll(el);
    el.scrollTop = 300;
    fireEvent.scroll(el);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("ChatMessageList draft rendering", () => {
    it("marks a retained interrupted draft and offers retry", async () => {
        const onRetry = vi.fn();
        render(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="A partial answer"
                    isStreaming={false}
                    streamStatus="interrupted"
                    onRetry={onRetry}
                    conversationId="conversation-one"
                />
            </LanguageProvider>,
        );

        expect(screen.getByText("A partial answer")).toBeInTheDocument();
        expect(
            await screen.findByText("Response interrupted. You can retry."),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("keeps one draft timestamp for a draft lifecycle and skips unchanged bubble renders", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-25T10:00:00.000Z"));
        chatBubbleRenderSpy.mockClear();

        const view = renderMessageList([], "conversation-one", "Draft");
        expect(chatBubbleRenderSpy).toHaveBeenCalledTimes(1);
        expect(chatBubbleRenderSpy.mock.lastCall?.[0].message.createdAt).toBe(
            "2026-08-25T10:00:00.000Z",
        );

        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="Draft"
                    isStreaming
                    conversationId="conversation-one"
                />
            </LanguageProvider>,
        );
        expect(chatBubbleRenderSpy).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-08-25T10:01:00.000Z"));
        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="Draft continues"
                    isStreaming
                    conversationId="conversation-one"
                />
            </LanguageProvider>,
        );
        expect(chatBubbleRenderSpy).toHaveBeenCalledTimes(2);
        expect(chatBubbleRenderSpy.mock.lastCall?.[0].message.createdAt).toBe(
            "2026-08-25T10:00:00.000Z",
        );

        vi.setSystemTime(new Date("2026-08-25T10:01:30.000Z"));
        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="Another active stream"
                    isStreaming
                    conversationId="conversation-two"
                />
            </LanguageProvider>,
        );
        expect(chatBubbleRenderSpy.mock.lastCall?.[0].message.createdAt).toBe(
            "2026-08-25T10:01:30.000Z",
        );

        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft=""
                    isStreaming={false}
                    conversationId="conversation-two"
                />
            </LanguageProvider>,
        );
        vi.setSystemTime(new Date("2026-08-25T10:02:00.000Z"));
        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={[]}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="New draft"
                    isStreaming
                    conversationId="conversation-two"
                />
            </LanguageProvider>,
        );
        expect(chatBubbleRenderSpy.mock.lastCall?.[0].message.createdAt).toBe(
            "2026-08-25T10:02:00.000Z",
        );
    });
});

describe("ChatMessageList auto-scroll", () => {
    it("scrolls an equal-length replacement conversation to the bottom", () => {
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(
            (callback) => {
                callback(0);
                return 1;
            },
        );
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        const scrollTo = vi.spyOn(Element.prototype, "scrollTo");

        const view = renderMessageList(firstConversation, "conversation-one");
        const log = screen.getByRole("log");
        setScrollableGeometry(log);
        scrollUpFromBottom(log);
        scrollTo.mockClear();

        // React Query keeps the previous conversation as placeholder data on
        // an uncached switch. The id therefore changes one commit before the
        // equal-length replacement transcript arrives.
        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={firstConversation}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft=""
                    isStreaming={false}
                    conversationId="conversation-two"
                />
            </LanguageProvider>,
        );
        scrollTo.mockClear();

        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={secondConversation}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft=""
                    isStreaming={false}
                    conversationId="conversation-two"
                />
            </LanguageProvider>,
        );

        expect(scrollTo).toHaveBeenCalledWith({ top: 1_200 });
    });

    it("does not yank a scrolled-up reader on a same-conversation stream update", () => {
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(
            (callback) => {
                callback(0);
                return 1;
            },
        );
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        const scrollTo = vi.spyOn(Element.prototype, "scrollTo");

        const view = renderMessageList(
            firstConversation,
            "conversation-one",
            "A",
        );
        const log = screen.getByRole("log");
        setScrollableGeometry(log);
        scrollUpFromBottom(log);
        scrollTo.mockClear();

        view.rerender(
            <LanguageProvider language="en" setLanguage={vi.fn()}>
                <ChatMessageList
                    messages={firstConversation}
                    streamingUserMessage={null}
                    streamingToolMessages={[]}
                    assistantDraft="Answer continues"
                    isStreaming
                    conversationId="conversation-one"
                />
            </LanguageProvider>,
        );

        expect(scrollTo).not.toHaveBeenCalled();
    });
});
