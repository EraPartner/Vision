// ==================== Split Types ====================

export interface TransactionSplit {
    id: number;
    transaction_id: number;
    recipient_id: number;
    recipient_name?: string;
    amount: number;
    amount_paid: number;
    note?: string;
    is_settled: boolean;
    created_at: string;
    updated_at: string;
}

export interface TransactionSplitDetail extends TransactionSplit {
    transaction_date: string;
    transaction_memo: string;
    transaction_amount: number;
    transaction_currency: string;
    bank_account: string;
    remaining: number;
}

export interface OwedSummary {
    recipient_id: number;
    recipient_name: string;
    total_owed: number;
    total_paid: number;
    remaining: number;
    split_count: number;
}

export interface SplitPayment {
    id: number;
    split_id: number;
    amount: number;
    paid_at: string;
    note?: string;
    created_at: string;
}

export interface SplitCreateInput {
    recipient_id: number;
    amount: number;
    note?: string;
}
