import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage } from '@/types/aiChat';
import { ChatBubble } from './ChatBubble';

interface ChatMessageListProps {
    messages: ChatMessage[];
    streamingUserMessage: ChatMessage | null;
    streamingToolMessages: ChatMessage[];
    assistantDraft: string;
    isStreaming: boolean;
    emptyState?: React.ReactNode;
}

export function ChatMessageList({
    messages,
    streamingUserMessage,
    streamingToolMessages,
    assistantDraft,
    isStreaming,
    emptyState,
}: ChatMessageListProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    const combined = useMemo<ChatMessage[]>(() => {
        const existing = new Set(messages.map((m) => m.id));
        const extras: ChatMessage[] = [];
        if (streamingUserMessage && !existing.has(streamingUserMessage.id)) {
            extras.push(streamingUserMessage);
        }
        for (const tool of streamingToolMessages) {
            if (!existing.has(tool.id)) extras.push(tool);
        }
        return [...messages, ...extras];
    }, [messages, streamingUserMessage, streamingToolMessages]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [combined.length, assistantDraft, isStreaming]);

    const showDraft = isStreaming && assistantDraft.length > 0;
    const showEmpty = combined.length === 0 && !showDraft;

    return (
        <div
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex-1 overflow-y-auto px-4 py-6"
        >
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {showEmpty && emptyState}
                {combined.map((message) => (
                    <ChatBubble key={message.id} message={message} />
                ))}
                {showDraft && (
                    <ChatBubble
                        message={{
                            id: '__draft__',
                            role: 'assistant',
                            content: assistantDraft,
                            createdAt: new Date().toISOString(),
                        }}
                        streaming
                    />
                )}
            </div>
        </div>
    );
}
