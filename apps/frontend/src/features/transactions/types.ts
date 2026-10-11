import type { Tag } from "@/types/api";

export type TableTransaction = {
    id: number;
    date: string;
    memo: string;
    category: string;
    categoryId?: number | undefined;
    recipient: string;
    recipientId?: number;
    bank: string;
    bankLabel?: string | undefined;
    accountId?: number | undefined;
    amount: number;
    currency: string;
    runningBalance?: number | undefined;
    balance?: number | undefined;
    comment?: string;
    is_active: boolean;
    tags?: Tag[];
};

export interface RawApiTransaction {
    id: number;
    date?: string | undefined;
    memo?: string | undefined;
    category_id?: number | null;
    category_name?: string | null;
    recipient_id?: number | null;
    recipient_name?: string | null;
    bank?: string | undefined;
    account_id?: number | null | undefined;
    is_transfer?: boolean;
    transfer_peer_id?: number | null;
    transfer_source?: string | null;
    amount?: number | undefined;
    currency?: string | null | undefined;
    running_balance?: number | null;
    balance?: number | null;
    comment?: string | null | undefined;
    is_active?: boolean;
    tags?: Tag[];
    [key: string]: unknown;
}

// `balance` is intentionally NOT editable: the running balance is bank-stamped
// import data and the account total anchors on it (ADR-094). It is shown
// read-only in the info dialog but never user-editable.
export type InfoEditableField =
    "date" | "memo" | "amount" | "currency" | "bank" | "comment";
