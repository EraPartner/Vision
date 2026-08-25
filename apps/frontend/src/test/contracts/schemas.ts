import { z } from "zod";

export const LinkSchema = z.strictObject({ rel: z.string(), href: z.string() });

export const paginatedOf = <T extends z.ZodTypeAny>(item: T) =>
    z.strictObject({
        items: z.array(item),
        total: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        links: z.array(LinkSchema),
    });

/** `{ items, total }` — the canonical body for unpaginated collection GETs. */
export const collectionSchema = (item: z.ZodTypeAny = z.unknown()) =>
    z.strictObject({ items: z.array(item), total: z.number().int().nonnegative() });

export const CategoryItemSchema = z.strictObject({
    id: z.number().int().positive(),
    general: z.string(),
    detail: z.string().nullable(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    category_name: z.string(),
    links: z.array(z.unknown()),
});

export const RecipientItemSchema = z.strictObject({
    id: z.number().int().positive(),
    name: z.string(),
    normalized_name: z.string(),
    default_category_id: z.number().int().positive().nullable(),
    primary_recipient_id: z.number().int().positive().nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    links: z.array(z.unknown()),
});

export const TransactionItemSchema = z.strictObject({
    id: z.number().int().positive(),
    transaction_date: z.string(),
    date: z.string(),
    bank_account: z.string(),
    recipient_id: z.number().int().positive().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: z.number(),
    currency: z.string(),
    balance: z.number().nullable(),
    category_id: z.number().int().positive().nullable(),
    category_name: z.string().nullable(),
    comment: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
});

export const InvestmentItemSchema = z.strictObject({
    id: z.number().int().positive(),
    name: z.string(),
    symbol: z.string(),
    asset_class: z.string(),
    currency: z.string(),
    current_price: z.number().nullable(),
    interest_rate: z.number().nullable(),
    maturity_date: z.string().nullable(),
    location: z.string().nullable(),
    municipality: z.string().nullable(),
    cadastral_income: z.number().nullable(),
    municipality_tax_rate: z.number().nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    price_provider: z.string().nullable(),
    price_provider_id: z.string().nullable(),
    price_provider_url: z.string().nullable(),
    price_provider_latest_url: z.string().nullable(),
    price_provider_latest_path: z.string().nullable(),
    price_provider_history_url: z.string().nullable(),
    price_provider_history_path: z.string().nullable(),
    price_provider_history_ts_path: z.string().nullable(),
    price_provider_history_price_path: z.string().nullable(),
    price_updated_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
});

export const PlannedTransactionItemSchema = z.strictObject({
    id: z.number().int().positive(),
    planned_date: z.string(),
    bank_account: z.string().nullable(),
    recipient_id: z.number().int().positive().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: z.number(),
    currency: z.string(),
    category_id: z.number().int().positive().nullable(),
    category_name: z.string().nullable(),
    comment: z.string().nullable(),
    url: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    reminder_days_before: z.number().int().nullable(),
    is_executed: z.boolean(),
    last_executed_date: z.string().nullable(),
    is_loan: z.boolean(),
    loan_type: z.string().nullable(),
    loan_principal: z.number().nullable(),
    loan_annual_interest_rate: z.number().nullable(),
    loan_term_months: z.number().int().nullable(),
    loan_start_date: z.string().nullable(),
    loan_payment_day: z.number().int().nullable(),
    loan_regular_payment_amount: z.number().nullable(),
    loan_first_payment_date: z.string().nullable(),
    loan_schedule: z.array(z.unknown()),
    executed_transaction_id: z.number().int().positive().nullable(),
    execution_count: z.number().int().nonnegative(),
    executions: z.array(z.unknown()),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    links: z.array(z.unknown()),
});
