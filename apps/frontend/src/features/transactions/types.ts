import type { Tag } from "@/types/api";

export type TableTransaction = {
    id: number;
    date: string;
    memo: string;
    category: string;
    categoryId?: number;
    recipient: string;
    recipientId?: number;
    bank: string;
    amount: number;
    currency: string;
    runningBalance?: number;
    balance?: number;
    comment?: string;
    is_active: boolean;
    tags?: Tag[];
};

export interface RawApiTransaction {
    id: number;
    date?: string;
    memo?: string;
    category_id?: number | null;
    category_name?: string | null;
    recipient_id?: number | null;
    recipient_name?: string | null;
    bank?: string;
    amount?: number;
    currency?: string | null;
    running_balance?: number | null;
    balance?: number | null;
    comment?: string | null;
    is_active?: boolean;
    tags?: Tag[];
    [key: string]: unknown;
}

// `balance` is intentionally NOT editable: the running balance is bank-stamped
// import data and the account total anchors on it (ADR-094). It is shown
// read-only in the info dialog but never user-editable.
export type InfoEditableField =
    "date" | "memo" | "amount" | "currency" | "bank" | "comment";
