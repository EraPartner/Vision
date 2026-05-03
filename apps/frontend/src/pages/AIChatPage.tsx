import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useOllamaStatus } from '@/hooks/useOllamaStatus';
import {
    useConversation,
    useCreateConversation,
    useSendChatMessage,
    useStreamingConversationIds,
} from '@/hooks/useAIChat';
import { ChatConversationList } from '@/features/ai-chat/ChatConversationList';
import { ChatMessageList } from '@/features/ai-chat/ChatMessageList';
import { ChatComposer } from '@/features/ai-chat/ChatComposer';
import { OllamaStatusBanner } from '@/features/ai-chat/OllamaStatusBanner';
import type { ChatMessage } from '@/types/aiChat';

const SELECTED_PARAM = 'c';

export default function AIChatPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const [searchParams, setSearchParams] = useSearchParams();
    const selectedId = searchParams.get(SELECTED_PARAM);
    const [modelOverride, setModelOverride] = useState<string | null>(null);
    const [useTools, setUseTools] = useState<boolean>(true);

    const setSelectedId = useCallback(
        (next: string | null) => {
            setSearchParams(
                (prev) => {
                    const params = new URLSearchParams(prev);
                    if (next) params.set(SELECTED_PARAM, next);
                    else params.delete(SELECTED_PARAM);
                    return params;
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    const { data: detail } = useConversation(selectedId);
    const createMut = useCreateConversation();
    const {
        send,
        cancel,
        isStreaming,
        assistantDraft,
        userMessage: streamingUserMessage,
        toolMessages: streamingToolMessages,
    } = useSendChatMessage(selectedId);
    const streamingIds = useStreamingConversationIds();

    // If the user returns to the page with no selection but a stream is in
    // flight in the background, jump to that conversation so they can see it.
    useEffect(() => {
        if (!selectedId && streamingIds.length > 0) {
            setSelectedId(streamingIds[0]);
        }
    }, [selectedId, streamingIds, setSelectedId]);

    const messages: ChatMessage[] = useMemo(() => detail?.messages ?? [], [detail]);

    const activeModel =
        modelOverride
        ?? detail?.conversation.model
        ?? appSettings.aiDefaultModel
        ?? status?.defaultModel
        ?? null;

    const handleSend = async (message: string) => {
        let conversationId = selectedId;
        if (!conversationId) {
            try {
                const created = await createMut.mutateAsync(
                    activeModel ? { model: activeModel } : {},
                );
                conversationId = created.conversation.id;
                setSelectedId(conversationId);
            } catch {
                return;
            }
        }
        await send({
            conversationId,
            message,
            model: activeModel ?? undefined,
            useTools,
        });
    };

    const statusLabel = statusLoading
        ? t('aiChat.checkingOllama')
        : status?.ok
            ? t('aiChat.ollamaReady')
            : t('aiChat.ollamaUnreachable');

    const statusDotClass = statusLoading
        ? 'bg-muted-foreground/50'
        : status?.ok
            ? 'bg-emerald-500'
            : 'bg-destructive';

    const emptyState = (
        <div className="mx-auto max-w-2xl rounded-2xl border border-dashed border-border/50 bg-background/30 px-6 py-10 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-primary" />
            <h3 className="mt-3 text-sm font-semibold tracking-tight">
                {t('aiChat.emptyTitle')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
                {t('aiChat.emptyState')}
            </p>
        </div>
    );

    const composerDisabled = !status?.ok;

    return (
        <div className="flex h-[calc(100vh-8rem)] gap-4 p-4">
            <aside className="w-72 shrink-0 rounded-2xl border border-border/50 bg-card/60 backdrop-blur-sm">
                <ChatConversationList
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />
            </aside>

            <main className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/60 backdrop-blur-sm">
                <header className="flex items-center justify-between border-b border-border/50 px-5 py-4">
                    <div className="min-w-0">
                        <h1 className="truncate text-base font-semibold tracking-tight">
                            {detail?.conversation.title || t('aiChat.title')}
                        </h1>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                            {statusLabel}
                        </p>
                    </div>
                </header>

                <OllamaStatusBanner status={status} isLoading={statusLoading} />

                <ChatMessageList
                    messages={messages}
                    streamingUserMessage={streamingUserMessage}
                    streamingToolMessages={streamingToolMessages}
                    assistantDraft={assistantDraft}
                    isStreaming={isStreaming}
                    emptyState={emptyState}
                />

                <ChatComposer
                    onSend={handleSend}
                    onCancel={cancel}
                    isStreaming={isStreaming}
                    disabled={composerDisabled}
                    model={activeModel}
                    onModelChange={setModelOverride}
                    useTools={useTools}
                    onUseToolsChange={setUseTools}
                />
            </main>
        </div>
    );
}
