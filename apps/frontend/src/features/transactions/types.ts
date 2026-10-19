import type { Tag } from "@/types/api";
import type {
    AccountId,
    CategoryId,
    CurrencyCode,
    RecipientId,
    TransactionId,
} from "@vision/types/brands";

export type TableTransaction = {
    id: TransactionId;
    date: string;
    memo: string;
    category: string;
    categoryId?: CategoryId | undefined;
    recipient: string;
    recipientId?: RecipientId | undefined;
    bank: string;
    bankLabel?: string | undefined;
    accountId?: AccountId | undefined;
    amount: number;
    currency: CurrencyCode;
    runningBalance?: number | undefined;
    balance?: number | undefined;
    comment?: string;
    is_active: boolean;
    tags?: Tag[];
};

export interface RawApiTransaction {
    id: TransactionId;
    date?: string | undefined;
    memo?: string | undefined;
    category_id?: CategoryId | null;
    category_name?: string | null;
    recipient_id?: RecipientId | null;
    recipient_name?: string | null;
    bank?: string | undefined;
    account_id?: AccountId | null | undefined;
    is_transfer?: boolean;
    transfer_peer_id?: TransactionId | null;
    transfer_source?: string | null;
    amount?: number | undefined;
    currency?: CurrencyCode | null | undefined;
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
