import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Menu, Sparkles } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useOllamaStatus } from "@/hooks/useOllamaStatus";
import {
    useConversation,
    useCreateConversation,
    useSendChatMessage,
    useStreamingConversationIds,
} from "@/hooks/useAIChat";
import { aiChatStreamStore } from "@/lib/aiChatStreamStore";
import { ChatConversationList } from "@/features/ai-chat/ChatConversationList";
import { ChatMessageList } from "@/features/ai-chat/ChatMessageList";
import { ChatComposer } from "@/features/ai-chat/ChatComposer";
import { OllamaStatusBanner } from "@/features/ai-chat/OllamaStatusBanner";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import type { ChatMessage } from "@/types/aiChat";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import { PAGE_ICONS } from "@/lib/pageIcons";

const SELECTED_PARAM = "c";

export default function AIChatPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const [searchParams, setSearchParams] = useSearchParams();
    const selectedId = searchParams.get(SELECTED_PARAM);
    const [modelOverride, setModelOverride] = useState<string | null>(null);
    const [useTools, setUseTools] = useState<boolean>(true);
    // Mobile: the conversation rail is hidden and opened as a drawer instead.
    const [railOpen, setRailOpen] = useState(false);

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
        status: streamStatus,
        lastRequest,
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

    const messages: ChatMessage[] = useMemo(
        () => detail?.messages ?? [],
        [detail],
    );

    // Defensive sweep: if the conversation cache picks up an assistant message
    // (via refetch or done-merge) while the streaming entry still claims to be
    // streaming, the `done` SSE event was lost or never arrived. Clear the
    // stale entry so the UI flips out of "Thinking..." instead of getting
    // stuck rendering both the persisted response and the spinner.
    useEffect(() => {
        if (!selectedId || !isStreaming) return;
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
            aiChatStreamStore.clear(selectedId);
        }
    }, [selectedId, isStreaming, messages]);

    const activeModel =
        modelOverride ??
        detail?.conversation.model ??
        appSettings.aiDefaultModel ??
        status?.defaultModel ??
        null;

    const ensureConversation = async (): Promise<string | null> => {
        if (selectedId) return selectedId;
        try {
            const created = await createMut.mutateAsync(
                activeModel ? { model: activeModel } : {},
            );
            setSelectedId(created.conversation.id);
            return created.conversation.id;
        } catch {
            return null;
        }
    };

    const handleSend = async (message: string) => {
        const conversationId = await ensureConversation();
        if (!conversationId) return;
        await send({
            conversationId,
            message,
            model: activeModel ?? undefined,
            useTools,
        });
    };

    const handleRetry = () => {
        if (lastRequest) {
            void send({ ...lastRequest, retryLastTurn: true });
        }
    };

    // Canned insights-digest turn. Forces tools on regardless of the composer
    // toggle (the digest is meaningless without the insights tool) and sets
    // `insightsPreCall` so the backend pre-runs the insights tool.
    const handleInsightsDigest = async () => {
        const conversationId = await ensureConversation();
        if (!conversationId) return;
        await send({
            conversationId,
            message: t("aiChat.insightsDigestPrompt"),
            model: activeModel ?? undefined,
            useTools: true,
            insightsPreCall: true,
        });
    };

    const statusLabel = statusLoading
        ? t("aiChat.checkingOllama")
        : status?.ok
          ? t("aiChat.ollamaReady")
          : t("aiChat.ollamaUnreachable");

    const statusDotClass = statusLoading
        ? "bg-muted-foreground/50"
        : status?.ok
          ? "bg-success"
          : "bg-destructive";

    const composerDisabled = !status?.ok;

    const emptyState = (
        <div className="glass-regular mx-auto max-w-2xl rounded-2xl border !border-dashed border-border/50">
            <EmptyState
                size="compact"
                icon={PAGE_ICONS["/ai-chat"]}
                title={t("aiChat.emptyTitle")}
                description={t("aiChat.emptyState")}
                action={
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleInsightsDigest}
                        disabled={composerDisabled}
                    >
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t("aiChat.insightsDigestButton")}
                    </Button>
                }
            />
        </div>
    );

    return (
        <div className="flex h-[calc(100vh-8rem)] gap-4 p-4">
            {/* Desktop: persistent rail. Mobile (<md): hidden — opened via the
                header menu button as a left drawer below. */}
            <aside className="hidden w-72 shrink-0 rounded-2xl glass-regular md:block">
                <ChatConversationList
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />
            </aside>

            <main className="flex flex-1 flex-col overflow-hidden rounded-2xl glass-regular">
                <header className="flex items-center justify-between border-b border-border/50 px-5 py-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <Sheet open={railOpen} onOpenChange={setRailOpen}>
                            <SheetTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="md:hidden"
                                    aria-label={t("aiChat.conversations")}
                                >
                                    <Menu className="h-5 w-5" />
                                </Button>
                            </SheetTrigger>
                            <SheetContent side="left" className="w-72 p-0">
                                <SheetHeader className="sr-only">
                                    <SheetTitle>
                                        {t("aiChat.conversations")}
                                    </SheetTitle>
                                </SheetHeader>
                                <ChatConversationList
                                    selectedId={selectedId}
                                    onSelect={(id) => {
                                        setSelectedId(id);
                                        setRailOpen(false);
                                    }}
                                />
                            </SheetContent>
                        </Sheet>
                        <div className="min-w-0">
                            <h1 className="truncate text-lg font-semibold tracking-tight">
                                {detail?.conversation.title ||
                                    t("aiChat.title")}
                            </h1>
                            {(statusLoading || status?.ok) && (
                                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <span
                                        className={cn(
                                            "inline-block h-1.5 w-1.5 rounded-full",
                                            statusDotClass,
                                        )}
                                    />
                                    {statusLabel}
                                </p>
                            )}
                        </div>
                    </div>
                </header>

                <OllamaStatusBanner status={status} isLoading={statusLoading} />

                <ChatMessageList
                    conversationId={selectedId}
                    messages={messages}
                    streamingUserMessage={streamingUserMessage}
                    streamingToolMessages={streamingToolMessages}
                    assistantDraft={assistantDraft}
                    isStreaming={isStreaming}
                    streamStatus={streamStatus}
                    onRetry={lastRequest ? handleRetry : undefined}
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
