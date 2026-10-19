import { useQuery } from "@tanstack/react-query";

import { listAttachments } from "@/lib/api/attachments";
import type { TransactionId } from "@vision/types/brands";

export const attachmentKeys = {
    byTransaction: (transactionId: TransactionId) =>
        ["attachments", transactionId] as const,
};

export function useAttachments(transactionId: TransactionId) {
    return useQuery({
        queryKey: attachmentKeys.byTransaction(transactionId),
        queryFn: () => listAttachments(transactionId),
    });
}
