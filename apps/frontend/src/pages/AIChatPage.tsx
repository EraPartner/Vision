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
import { Card } from "@/components/ui/card";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
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
import { PageHeader } from "@/components/shared/PageHeader";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useTabParam } from "@/hooks/useTabParam";
import { AIInvestigationPanel } from "@/features/ai-chat/AIInvestigationPanel";

const SELECTED_PARAM = "c";
const AI_MODES = ["chat", "investigation"] as const;

/**
 * AI page: a conversation rail beside the transcript, with Chat and
 * Investigation as one segmented view-mode control (URL `mode`). Both regions
 * stay mounted while hidden so a running investigation keeps polling and the
 * transcript keeps its scroll position and unsent draft.
 */
export default function AIChatPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const [searchParams, setSearchParams] = useSearchParams();
    const selectedId = searchParams.get(SELECTED_PARAM);
    const [mode, setMode] = useTabParam(AI_MODES, "chat", "mode");
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
    // (via refetch or completion merge) while the streaming entry still claims
    // to be streaming, the `complete` SSE event was lost or never arrived. Clear the
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
        ? "bg-label-tertiary"
        : status?.ok
          ? "bg-success"
          : "bg-label-tertiary";

    const composerDisabled = !status?.ok;

    const emptyState = (
        <Card className="mx-auto max-w-2xl">
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
                        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                        {t("aiChat.insightsDigestButton")}
                    </Button>
                }
            />
        </Card>
    );

    return (
        <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
            <PageHeader
                title={t("aiChat.title")}
                subtitle={t(
                    mode === "chat"
                        ? "aiChat.mode.chatHint"
                        : "aiChat.mode.investigationHint",
                )}
                icon={PAGE_ICONS["/ai-chat"]}
                actions={
                    <SegmentedControl
                        value={mode}
                        onValueChange={setMode}
                        aria-label={t("aiChat.mode.label")}
                    >
                        <SegmentedControlItem value="chat">
                            {t("aiChat.mode.chat")}
                        </SegmentedControlItem>
                        <SegmentedControlItem value="investigation">
                            {t("aiChat.mode.investigation")}
                        </SegmentedControlItem>
                    </SegmentedControl>
                }
            />
            <div className="flex min-h-0 flex-1 gap-4">
                {/* Desktop: persistent rail. Mobile (<md): hidden — opened via the
                    header menu button as a left drawer below. */}
                <Card
                    asChild
                    className={cn(
                        "hidden w-72 shrink-0 overflow-hidden",
                        mode === "chat" && "md:block",
                    )}
                >
                    <aside>
                        <ChatConversationList
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                        />
                    </aside>
                </Card>

                <Card asChild className="flex min-w-0 flex-1 flex-col overflow-hidden">
                    <main>
                        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <Sheet open={railOpen} onOpenChange={setRailOpen}>
                                    <SheetTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className={cn(
                                                "md:hidden",
                                                mode !== "chat" && "hidden",
                                            )}
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
                                    <h2 className="truncate type-title-3">
                                        {(mode === "chat" &&
                                            detail?.conversation.title) ||
                                            t(
                                                mode === "chat"
                                                    ? "aiChat.mode.chat"
                                                    : "aiChat.mode.investigation",
                                            )}
                                    </h2>
                                    {(statusLoading || status?.ok) && (
                                        <p className="mt-0.5 flex items-center gap-1.5 type-footnote text-label-secondary">
                                            <span
                                                aria-hidden="true"
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

                        <OllamaStatusBanner
                            status={status}
                            isLoading={statusLoading}
                        />

                        <div
                            role="region"
                            aria-label={t("aiChat.mode.investigation")}
                            hidden={mode !== "investigation"}
                            className="min-h-0 flex-1 overflow-y-auto"
                        >
                            <AIInvestigationPanel />
                        </div>
                        <div
                            role="region"
                            aria-label={t("aiChat.mode.chat")}
                            hidden={mode !== "chat"}
                            className="flex min-h-0 flex-1 flex-col"
                        >
                            <ChatMessageList
                                isVisible={mode === "chat"}
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
                        </div>
                    </main>
                </Card>
            </div>
        </div>
    );
}
