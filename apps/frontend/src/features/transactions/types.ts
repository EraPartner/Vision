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
    balance?: number;
    comment?: string;
    is_active: boolean;
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
    currency?: string;
    balance?: number | null;
    comment?: string | null;
    is_active?: boolean;
    [key: string]: unknown;
}

export type InfoEditableField =
    | 'date'
    | 'memo'
    | 'amount'
    | 'currency'
    | 'bank'
    | 'balance'
    | 'comment';
