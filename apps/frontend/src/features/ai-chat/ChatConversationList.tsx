import { useMemo, useState } from "react";
import {
    MoreVertical,
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
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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

export function ChatConversationList({
    selectedId,
    onSelect,
}: ChatConversationListProps) {
    const { t } = useLanguage();
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
                <div className="flex items-center justify-between px-3 py-2">
                    <h2 className="eyebrow">{t("aiChat.conversations")}</h2>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={handleNew}
                        disabled={createMut.isPending}
                        aria-label={t("aiChat.newConversation")}
                        className="h-7 w-7"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2">
                    {isLoading && (
                        <p className="px-2 py-4 text-xs text-muted-foreground">
                            {t("aiChat.loading")}
                        </p>
                    )}
                    {!isLoading && conversations.length === 0 && (
                        <p className="px-2 py-4 text-xs text-muted-foreground">
                            {t("aiChat.noConversations")}
                        </p>
                    )}
                    <ul className="flex flex-col gap-0.5">
                        {conversations.map((conv) => {
                            const active = conv.id === selectedId;
                            const streaming = streamingSet.has(conv.id);
                            return (
                                <li key={conv.id} className="cv-auto-row">
                                    <div
                                        className={cn(
                                            "group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors",
                                            active
                                                ? "bg-primary/10 text-foreground ring-1 ring-primary/20"
                                                : "hover:bg-muted/50 text-muted-foreground",
                                        )}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => onSelect(conv.id)}
                                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                        >
                                            <MessageSquare
                                                className={cn(
                                                    "h-3.5 w-3.5 shrink-0",
                                                    active
                                                        ? "text-primary"
                                                        : "",
                                                )}
                                            />
                                            <span className="truncate text-sm tracking-tight">
                                                {conv.title ||
                                                    t("aiChat.untitled")}
                                            </span>
                                            {streaming && (
                                                <span
                                                    className="ml-auto inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
                                                    aria-label={t(
                                                        "aiChat.streamingIndicator",
                                                    )}
                                                    title={t(
                                                        "aiChat.streamingIndicator",
                                                    )}
                                                />
                                            )}
                                        </button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    type="button"
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={t(
                                                        "aiChat.conversationActions",
                                                    )}
                                                    className="icon-touch-target opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 data-[state=open]:opacity-100"
                                                >
                                                    <MoreVertical className="h-3.5 w-3.5" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    onClick={() =>
                                                        setRenameTarget(conv)
                                                    }
                                                >
                                                    <Pencil className="mr-2 h-3.5 w-3.5" />
                                                    {t("aiChat.rename")}
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={() =>
                                                        void handleDelete(conv)
                                                    }
                                                    className="text-destructive focus:text-destructive"
                                                >
                                                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                                                    {t("aiChat.delete")}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
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

            <RenameDialog
                target={renameTarget}
                onClose={() => setRenameTarget(null)}
            />
            <ConfirmDialog />
        </>
    );
}

function RenameDialog({
    target,
    onClose,
}: {
    target: ConversationSummary | null;
    onClose: () => void;
}) {
    const { t } = useLanguage();
    const renameMut = useRenameConversation();
    const [title, setTitle] = useState("");

    if (!target) return null;

    const open = Boolean(target);

    const handleSubmit = async () => {
        const trimmed = title.trim();
        if (!trimmed) return;
        await renameMut.mutateAsync({ id: target.id, title: trimmed });
        onClose();
    };

    return (
        <AlertDialog
            open={open}
            onOpenChange={(o) => {
                if (!o) onClose();
                else setTitle(target.title);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{t("aiChat.rename")}</AlertDialogTitle>
                </AlertDialogHeader>
                <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={120}
                    autoFocus
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            handleSubmit();
                        }
                    }}
                />
                <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleSubmit}
                        disabled={!title.trim()}
                    >
                        {t("common.save")}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
