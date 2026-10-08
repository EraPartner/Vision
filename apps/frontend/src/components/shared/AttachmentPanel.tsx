/**
 * AttachmentPanel — upload, list, and delete file attachments for a transaction.
 *
 * Drop-in panel used inside TransactionInspector.  Manages its own
 * fetch/mutation state so the parent dialog stays focused on field editing.
 */

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Paperclip,
    Trash2,
    Upload,
    ExternalLink,
    Loader2,
    AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    uploadAttachment,
    deleteAttachment,
    getAttachmentDownloadUrl,
    type Attachment,
} from "@/lib/api/attachments";
import { attachmentKeys, useAttachments } from "@/hooks/useAttachments";

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
        <div className="group flex items-center gap-2 py-1.5">
            <Paperclip
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-label-tertiary"
            />
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-1 rounded-chip type-body text-foreground underline-offset-4 hover:underline focus-ring"
                title={attachment.filename}
            >
                <span className="truncate">{attachment.filename}</span>
                <ExternalLink
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 text-label-tertiary"
                />
            </a>
            <span className="shrink-0 type-footnote tabular-nums text-label-secondary">
                {formatBytes(attachment.size_bytes)}
            </span>
            {isImage && (
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-chip focus-ring"
                >
                    <img
                        src={url}
                        alt={attachment.filename}
                        loading="lazy"
                        decoding="async"
                        className="h-6 w-6 shrink-0 rounded-chip border border-border/60 object-cover"
                    />
                </a>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="icon-touch-target text-label-secondary opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
                onClick={() => onDelete(attachment.id)}
                disabled={deleting}
                title={t("txPage.deleteAttachment")}
                aria-label={t("aria.deleteAttachment", {
                    name: attachment.filename,
                })}
            >
                {deleting ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                    <Trash2 aria-hidden="true" />
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

    const queryKey = attachmentKeys.byTransaction(transactionId);

    const { data, isLoading, isError } = useAttachments(transactionId);

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
        onError: (err: Error) => {
            setDeletingId(null);
            // Resetting the spinner alone left a failed delete looking like a
            // no-op (the row just stays). This handler also suppresses the
            // global MutationCache backstop, so it has to speak for itself.
            toast.error(t("txPage.deleteAttachmentError"), {
                description: apiErrorToMessage(err, t),
            });
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
            title: t("txPage.deleteAttachment"),
            description: t("txPage.deleteAttachment.desc", {
                name: target?.filename ?? "",
            }),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (!ok) return;
        setDeletingId(id);
        deleteMutation.mutate(id);
    }

    return (
        <>
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className="eyebrow">{t("txPage.attachments")}</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-2 h-7 px-2 type-footnote"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadMutation.isPending}
                    >
                        {uploadMutation.isPending ? (
                            <Loader2
                                aria-hidden="true"
                                className="animate-spin"
                            />
                        ) : (
                            <Upload aria-hidden="true" />
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
                    <div
                        role="status"
                        aria-label={t("common.loading")}
                        className="space-y-2 py-1"
                    >
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-1/2" />
                    </div>
                )}

                {isError && (
                    <p
                        role="alert"
                        className="flex items-center gap-2 py-1 type-footnote text-destructive"
                    >
                        <AlertCircle aria-hidden="true" className="h-3 w-3" />
                        {t("txPage.attachmentsError")}
                    </p>
                )}

                {uploadMutation.isError && (
                    <p
                        role="alert"
                        className="flex items-center gap-2 py-1 type-footnote text-destructive"
                    >
                        <AlertCircle aria-hidden="true" className="h-3 w-3" />
                        {t("txPage.uploadError")}
                    </p>
                )}

                {!isLoading && !isError && attachments.length === 0 && (
                    <p className="py-1 type-footnote text-label-secondary">
                        {t("txPage.noAttachments")}
                    </p>
                )}

                {attachments.map((att) => (
                    <AttachmentRow
                        key={att.id}
                        attachment={att}
                        onDelete={handleDelete}
                        deleting={
                            deletingId === att.id && deleteMutation.isPending
                        }
                    />
                ))}
            </div>
            <ConfirmDialog />
        </>
    );
}
