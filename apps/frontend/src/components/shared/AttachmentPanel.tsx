/**
 * AttachmentPanel — upload, list, and delete file attachments for a transaction.
 *
 * Drop-in panel used inside TransactionInfoDialog.  Manages its own
 * fetch/mutation state so the parent dialog stays focused on field editing.
 */

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Trash2, Upload, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    listAttachments,
    uploadAttachment,
    deleteAttachment,
    getAttachmentDownloadUrl,
    type Attachment,
} from "@/lib/api/attachments";

interface AttachmentPanelProps {
    transactionId: number;
}

const ALLOWED_MIME = "image/*,application/pdf";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentRow({
    attachment,
    onDelete,
    deleting,
}: {
    attachment: Attachment;
    onDelete: (id: number) => void;
    deleting: boolean;
}) {
    const { t } = useLanguage();
    const url = getAttachmentDownloadUrl(attachment.id);
    const isImage = attachment.mime_type.startsWith("image/");

    return (
        <div className="flex items-center gap-2 py-1.5 group">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 flex items-center gap-1 text-sm text-foreground hover:underline"
                title={attachment.filename}
            >
                <span className="truncate">{attachment.filename}</span>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
            <span className="text-xs text-muted-foreground shrink-0">
                {formatBytes(attachment.size_bytes)}
            </span>
            {isImage && (
                <a href={url} target="_blank" rel="noopener noreferrer">
                    <img
                        src={url}
                        alt={attachment.filename}
                        loading="lazy"
                        decoding="async"
                        className="h-6 w-6 rounded object-cover border border-border shrink-0"
                    />
                </a>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity"
                onClick={() => onDelete(attachment.id)}
                disabled={deleting}
                title={t('txPage.deleteAttachment')}
            >
                {deleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                    <Trash2 className="h-3 w-3" />
                )}
            </Button>
        </div>
    );
}

export function AttachmentPanel({ transactionId }: AttachmentPanelProps) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    const queryKey = ["attachments", transactionId];

    const { data, isLoading, isError } = useQuery({
        queryKey,
        queryFn: () => listAttachments(transactionId),
    });

    const attachments: Attachment[] = data?.items ?? [];

    const uploadMutation = useMutation({
        mutationFn: (file: File) => uploadAttachment(transactionId, file),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (id: number) => deleteAttachment(id),
        onSuccess: () => {
            setDeletingId(null);
            void queryClient.invalidateQueries({ queryKey });
        },
        onError: () => {
            setDeletingId(null);
        },
    });

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        uploadMutation.mutate(file);
        // reset so the same file can be re-uploaded if needed
        e.target.value = "";
    }

    async function handleDelete(id: number) {
        const target = attachments.find((a) => a.id === id);
        const ok = await confirm({
            title: t('txPage.deleteAttachment'),
            description: t('txPage.deleteAttachment.desc', { name: target?.filename ?? '' }),
            confirmLabel: t('common.delete'),
            variant: 'destructive',
        });
        if (!ok) return;
        setDeletingId(id);
        deleteMutation.mutate(id);
    }

    return (
        <>
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                    {t("txPage.attachments")}
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadMutation.isPending}
                >
                    {uploadMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                        <Upload className="h-3 w-3" />
                    )}
                    {t("txPage.uploadAttachment")}
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={ALLOWED_MIME}
                    className="hidden"
                    onChange={handleFileChange}
                />
            </div>

            {isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("common.loading")}
                </div>
            )}

            {isError && (
                <div className="flex items-center gap-2 text-xs text-destructive py-1">
                    <AlertCircle className="h-3 w-3" />
                    {t("txPage.attachmentsError")}
                </div>
            )}

            {uploadMutation.isError && (
                <div className="flex items-center gap-2 text-xs text-destructive py-1">
                    <AlertCircle className="h-3 w-3" />
                    {t("txPage.uploadError")}
                </div>
            )}

            {!isLoading && !isError && attachments.length === 0 && (
                <p className="text-xs text-muted-foreground py-1">
                    {t("txPage.noAttachments")}
                </p>
            )}

            {attachments.map((att) => (
                <AttachmentRow
                    key={att.id}
                    attachment={att}
                    onDelete={handleDelete}
                    deleting={deletingId === att.id && deleteMutation.isPending}
                />
            ))}
        </div>
        <ConfirmDialog />
        </>
    );
}
