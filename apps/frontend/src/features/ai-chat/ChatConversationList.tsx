import { useMemo, useState } from 'react';
import { MoreVertical, Plus, Pencil, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import {
    useConversations,
    useCreateConversation,
    useDeleteConversation,
    useRenameConversation,
    useStreamingConversationIds,
} from '@/hooks/useAIChat';
import { aiChatStreamStore } from '@/lib/aiChatStreamStore';
import type { ConversationSummary } from '@/types/aiChat';

interface ChatConversationListProps {
    selectedId: string | null;
    onSelect: (id: string | null) => void;
}

export function ChatConversationList({ selectedId, onSelect }: ChatConversationListProps) {
    const { t } = useLanguage();
    const { data, isLoading } = useConversations();
    const createMut = useCreateConversation();
    const deleteMut = useDeleteConversation();
    const streamingIds = useStreamingConversationIds();
    const streamingSet = useMemo(() => new Set(streamingIds), [streamingIds]);
    const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);

    const conversations = data ?? [];

    const handleNew = async () => {
        const result = await createMut.mutateAsync({});
        onSelect(result.conversation.id);
    };

    const handleDeleteConfirm = async () => {
        if (!deleteTarget) return;
        // Abort any in-flight stream before deletion. Otherwise the backend
        // tool/assistant inserts race against the cascade-delete and trip the
        // ai_messages → ai_conversations foreign key.
        aiChatStreamStore.cancel(deleteTarget.id);
        aiChatStreamStore.clear(deleteTarget.id);
        if (deleteTarget.id === selectedId) onSelect(null);
        await deleteMut.mutateAsync(deleteTarget.id);
        setDeleteTarget(null);
    };

    return (
        <>
            <div className="flex h-full flex-col">
                <div className="flex items-center justify-between px-3 py-2">
                    <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {t('aiChat.conversations')}
                    </h2>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={handleNew}
                        disabled={createMut.isPending}
                        aria-label={t('aiChat.newConversation')}
                        className="h-7 w-7"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2">
                    {isLoading && (
                        <p className="px-2 py-4 text-xs text-muted-foreground">
                            {t('aiChat.loading')}
                        </p>
                    )}
                    {!isLoading && conversations.length === 0 && (
                        <p className="px-2 py-4 text-xs text-muted-foreground">
                            {t('aiChat.noConversations')}
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
                                            'group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors',
                                            active
                                                ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                                                : 'hover:bg-muted/50 text-muted-foreground',
                                        )}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => onSelect(conv.id)}
                                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                        >
                                            <MessageSquare
                                                className={cn(
                                                    'h-3.5 w-3.5 shrink-0',
                                                    active ? 'text-primary' : '',
                                                )}
                                            />
                                            <span className="truncate text-sm tracking-tight">
                                                {conv.title || t('aiChat.untitled')}
                                            </span>
                                            {streaming && (
                                                <span
                                                    className="ml-auto inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
                                                    aria-label={t('aiChat.streamingIndicator')}
                                                    title={t('aiChat.streamingIndicator')}
                                                />
                                            )}
                                        </button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    type="button"
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={t('aiChat.conversationActions')}
                                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                                                >
                                                    <MoreVertical className="h-3.5 w-3.5" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem onClick={() => setRenameTarget(conv)}>
                                                    <Pencil className="mr-2 h-3.5 w-3.5" />
                                                    {t('aiChat.rename')}
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={() => setDeleteTarget(conv)}
                                                    className="text-destructive focus:text-destructive"
                                                >
                                                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                                                    {t('aiChat.delete')}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>

            <RenameDialog
                target={renameTarget}
                onClose={() => setRenameTarget(null)}
            />

            <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('aiChat.deleteTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('aiChat.deleteConfirm')}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDeleteConfirm}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {t('aiChat.delete')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
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
    const [title, setTitle] = useState('');

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
                    <AlertDialogTitle>{t('aiChat.rename')}</AlertDialogTitle>
                </AlertDialogHeader>
                <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={120}
                    autoFocus
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSubmit();
                        }
                    }}
                />
                <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleSubmit} disabled={!title.trim()}>
                        {t('common.save')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
