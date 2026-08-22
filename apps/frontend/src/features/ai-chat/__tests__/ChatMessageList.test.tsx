// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ChatMessageList } from '@/features/ai-chat/ChatMessageList';
import type { ChatMessage } from '@/types/aiChat';

const firstConversation: ChatMessage[] = [
    {
        id: 'first-user',
        role: 'user',
        content: 'First question',
        createdAt: '2026-08-22T08:00:00.000Z',
    },
    {
        id: 'first-assistant',
        role: 'assistant',
        content: 'First answer',
        createdAt: '2026-08-22T08:00:01.000Z',
    },
];

const secondConversation: ChatMessage[] = [
    {
        id: 'second-user',
        role: 'user',
        content: 'Second question',
        createdAt: '2026-08-22T09:00:00.000Z',
    },
    {
        id: 'second-assistant',
        role: 'assistant',
        content: 'Second answer',
        createdAt: '2026-08-22T09:00:01.000Z',
    },
];

function renderMessageList(messages: ChatMessage[], conversationId: string, assistantDraft = '') {
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
    vi.restoreAllMocks();
});

describe('ChatMessageList auto-scroll', () => {
    it('scrolls an equal-length replacement conversation to the bottom', () => {
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0);
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');

        const view = renderMessageList(firstConversation, 'conversation-one');
        const log = screen.getByRole('log');
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

    it('does not yank a scrolled-up reader on a same-conversation stream update', () => {
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0);
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');

        const view = renderMessageList(firstConversation, 'conversation-one', 'A');
        const log = screen.getByRole('log');
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
