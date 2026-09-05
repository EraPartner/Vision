import { useQuery } from "@tanstack/react-query";

import { listAttachments } from "@/lib/api/attachments";

export const attachmentKeys = {
    byTransaction: (transactionId: number) =>
        ["attachments", transactionId] as const,
};

export function useAttachments(transactionId: number) {
    return useQuery({
        queryKey: attachmentKeys.byTransaction(transactionId),
        queryFn: () => listAttachments(transactionId),
    });
}
