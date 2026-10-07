import { useId, useMemo, useState } from "react";
import {
    MoreHorizontal,
    Plus,
    Pencil,
    Trash2,
    MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useConversations,
    useCreateConversation,
    useDeleteConversation,
    useRenameConversation,
    useStreamingConversationIds,
} from "@/hooks/useAIChat";
import { aiChatStreamStore } from "@/lib/aiChatStreamStore";
import type { ConversationSummary } from "@/types/aiChat";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

interface ChatConversationListProps {
    selectedId: string | null;
    onSelect: (id: string | null) => void;
}

/**
 * The conversation rail: one row per conversation with a ••• menu (Rename,
 * Delete). Delete keeps its confirmation because the backend cascade-deletes
 * every message and there is no restore endpoint.
 */
export function ChatConversationList({
    selectedId,
    onSelect,
}: ChatConversationListProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
        useConversations();
    const createMut = useCreateConversation();
    const deleteMut = useDeleteConversation();
    const streamingIds = useStreamingConversationIds();
    const streamingSet = useMemo(() => new Set(streamingIds), [streamingIds]);
    const [renameTarget, setRenameTarget] =
        useState<ConversationSummary | null>(null);
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const conversations = data?.pages.flatMap((page) => page.items) ?? [];

    const handleNew = async () => {
        const result = await createMut.mutateAsync({});
        onSelect(result.conversation.id);
    };

    const handleDelete = async (conversation: ConversationSummary) => {
        const accepted = await confirm({
            title: t("aiChat.deleteTitle"),
            description: t("aiChat.deleteConfirm"),
            confirmLabel: t("aiChat.delete"),
            cancelLabel: t("common.cancel"),
            variant: "destructive",
        });
        if (!accepted) return;

        // Abort any in-flight stream before deletion. Otherwise the backend
        // tool/assistant inserts race against the cascade-delete and trip the
        // ai_messages → ai_conversations foreign key.
        aiChatStreamStore.cancel(conversation.id);
        aiChatStreamStore.clear(conversation.id);
        if (conversation.id === selectedId) onSelect(null);
        await deleteMut.mutateAsync(conversation.id);
    };

    return (
        <>
            <div className="flex h-full flex-col">
                <div className="flex items-center justify-between px-4 py-3">
                    <h2 className="type-headline text-label-secondary">
                        {t("aiChat.conversations")}
                    </h2>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={handleNew}
                        disabled={createMut.isPending}
                        aria-label={t("aiChat.newConversation")}
                        className="h-8 w-8"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2">
                    {isLoading && (
                        <div
                            {...loadingSurfaceProps}
                            className="space-y-1 px-1 py-1"
                        >
                            {[0, 1, 2].map((index) => (
                                <Skeleton
                                    key={index}
                                    className="h-9 w-full rounded-control"
                                />
                            ))}
                        </div>
                    )}
                    {!isLoading && conversations.length === 0 && (
                        <EmptyState
                            size="compact"
                            headingLevel={3}
                            icon={MessageSquare}
                            title={t("aiChat.noConversations")}
                        />
                    )}
                    <ul className="flex flex-col gap-0.5">
                        {conversations.map((conv) => {
                            const active = conv.id === selectedId;
                            const streaming = streamingSet.has(conv.id);
                            return (
                                <li
                                    key={conv.id}
                                    className="cv-auto-row group flex items-center gap-0.5"
                                    aria-current={active ? "true" : undefined}
                                >
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() => onSelect(conv.id)}
                                        className={cn(
                                            "h-9 min-w-0 flex-1 justify-start gap-2 px-2 font-normal",
                                            active
                                                ? "bg-primary/12 text-foreground hover:bg-primary/15"
                                                : "text-label-secondary",
                                        )}
                                    >
                                        <MessageSquare
                                            aria-hidden="true"
                                            className={cn(
                                                "h-3.5 w-3.5 shrink-0",
                                                active && "text-primary",
                                            )}
                                        />
                                        <span className="truncate">
                                            {conv.title || t("aiChat.untitled")}
                                        </span>
                                        {streaming && (
                                            <span
                                                className="ml-auto inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
                                                role="img"
                                                aria-label={t(
                                                    "aiChat.streamingIndicator",
                                                )}
                                                title={t(
                                                    "aiChat.streamingIndicator",
                                                )}
                                            />
                                        )}
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t(
                                                    "aiChat.conversationActions",
                                                )}
                                                className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                            >
                                                <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    setRenameTarget(conv)
                                                }
                                            >
                                                <Pencil
                                                    className="mr-2 h-4 w-4 text-label-secondary"
                                                    aria-hidden="true"
                                                />
                                                {t("aiChat.rename")}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    void handleDelete(conv)
                                                }
                                                className="text-destructive focus:text-destructive"
                                            >
                                                <Trash2
                                                    className="mr-2 h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                                {t("aiChat.delete")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </li>
                            );
                        })}
                    </ul>
                    {hasNextPage && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="mt-2 w-full"
                            disabled={isFetchingNextPage}
                            onClick={() => void fetchNextPage()}
                        >
                            {isFetchingNextPage
                                ? t("aiChat.loading")
                                : t("aiChat.loadMore")}
                        </Button>
                    )}
                </div>
            </div>

            {renameTarget && (
                <RenameDialog
                    key={renameTarget.id}
                    target={renameTarget}
                    onClose={() => setRenameTarget(null)}
                />
            )}
            <ConfirmDialog />
        </>
    );
}

function RenameDialog({
    target,
    onClose,
}: {
    target: ConversationSummary;
    onClose: () => void;
}) {
    const { t } = useLanguage();
    const renameMut = useRenameConversation();
    const [title, setTitle] = useState(target.title);
    const inputId = useId();

    const handleSubmit = async () => {
        const trimmed = title.trim();
        if (!trimmed) return;
        await renameMut.mutateAsync({ id: target.id, title: trimmed });
        onClose();
    };

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("aiChat.renameTitle")}</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void handleSubmit();
                    }}
                >
                    <Label htmlFor={inputId}>{t("aiChat.renameLabel")}</Label>
                    <Input
                        id={inputId}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        maxLength={120}
                        autoFocus
                    />
                </form>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => void handleSubmit()}
                        disabled={!title.trim() || renameMut.isPending}
                    >
                        {t("common.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
