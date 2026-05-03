import { useEffect, useMemo, useRef } from 'react';
import { Bot } from 'lucide-react';
import type { ChatMessage } from '@/types/aiChat';
import { ChatBubble } from './ChatBubble';
import { useLanguage } from '@/contexts/LanguageContext';

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

    const { t } = useLanguage();
    const showDraft = isStreaming && assistantDraft.length > 0;
    const showThinking =
        isStreaming
        && assistantDraft.length === 0
        && streamingToolMessages.length === 0;
    const showEmpty = combined.length === 0 && !showDraft && !showThinking;

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
                {showThinking && (
                    <div className="flex items-center gap-3 px-1">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-accent/30 text-primary ring-1 ring-border/50">
                            <Bot className="h-4 w-4" />
                        </div>
                        <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground ring-1 ring-border/50">
                            <span className="inline-flex items-center gap-1">
                                <span className="motion-safe:animate-pulse">{t('aiChat.thinking')}</span>
                                <span className="inline-flex gap-0.5">
                                    <span className="motion-safe:animate-bounce [animation-delay:0ms]">.</span>
                                    <span className="motion-safe:animate-bounce [animation-delay:150ms]">.</span>
                                    <span className="motion-safe:animate-bounce [animation-delay:300ms]">.</span>
                                </span>
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
