// Pure PlannedPayment (frontend) <-> PlannedTransaction (backend wire shape)
// DTO mapping layer. No React in here — usePlannedPayments consumes these, and
// they are unit-tested in plannedPaymentMapper.test.ts.
import type { PlannedRecurrencePattern } from "@vision/types/recurrence";
import type {
    PlannedTransaction,
    PlannedTransactionCreate,
    PlannedTransactionUpdate,
    PlannedTransactionExecution,
    PlannedLoanType,
    PlannedLoanScheduleEntry,
} from "@/types/api";

export interface PlannedPayment {
    id: number;
    name: string;
    amount: number;
    currency: string;
    due_date: string; // ISO date
    is_recurring: boolean;
    // The planned-transaction recurrence vocabulary (canonical list in
    // @vision/types/recurrence — note 'biweekly', no hyphen), plus the
    // view-model-only "custom" bucket that stands in for `every N days`.
    frequency?: PlannedRecurrencePattern | "custom";
    is_loan?: boolean;
    loan_type?: PlannedLoanType;
    loan_principal?: number;
    loan_annual_interest_rate?: number;
    loan_term_months?: number;
    loan_start_date?: string;
    loan_payment_day?: number;
    loan_regular_payment_amount?: number;
    loan_first_payment_date?: string;
    loan_schedule?: PlannedLoanScheduleEntry[];
    custom_interval_days?: number;
    // `null` is an explicit "clear the bound" signal from the editor; `undefined`
    // means "leave unchanged". Both must be representable so a cleared end date /
    // max count reaches mapToUpdateAPI as null instead of being dropped.
    end_date?: string | null;
    max_occurrences?: number | null;
    recipient?: string;
    recipient_id?: number;
    category?: string;
    category_id?: number;
    bank_account?: string;
    notes?: string;
    url?: string;
    is_executed?: boolean;
    last_executed_date?: string;
    executed_transaction_id?: number;
    execution_count?: number;
    executions?: PlannedTransactionExecution[];
    tags?: string[];
    is_active: boolean;
    created_at: string;
}

// Map backend PlannedTransaction to frontend PlannedPayment format
export function mapFromAPI(
    pt: PlannedTransaction,
    defaultCurrency: string,
): PlannedPayment {
    // Parse recurrence_pattern to extract frequency
    let frequency: PlannedPayment["frequency"] = "monthly";
    let custom_interval_days: number | undefined;

    if (pt.recurrence_pattern) {
        const pattern = pt.recurrence_pattern.toLowerCase();
        if (pattern === "daily") frequency = "daily";
        else if (pattern === "weekly") frequency = "weekly";
        else if (pattern === "biweekly" || pattern === "bi-weekly")
            frequency = "biweekly";
        else if (pattern === "monthly") frequency = "monthly";
        else if (pattern === "quarterly") frequency = "quarterly";
        else if (pattern === "yearly") frequency = "yearly";
        else {
            // Try to parse custom pattern like "every 10 days" or just a number
            const match = pattern.match(/(\d+)/);
            if (match) {
                frequency = "custom";
                custom_interval_days = parseInt(match[1]);
            }
        }
    }

    // Normalize planned_date to YYYY-MM-DD format (strip time portion if present)
    let normalizedDate = pt.planned_date;
    if (normalizedDate && normalizedDate.includes("T")) {
        normalizedDate = normalizedDate.split("T")[0];
    }

    return {
        id: pt.id,
        name: pt.memo || pt.recipient_name || "Unnamed payment",
        amount: pt.amount,
        currency: pt.currency || defaultCurrency,
        due_date: normalizedDate,
        url: pt.url,
        is_recurring: pt.is_recurring,
        is_loan: !!pt.is_loan,
        loan_type: pt.loan_type ?? undefined,
        loan_principal: pt.loan_principal ?? undefined,
        loan_annual_interest_rate: pt.loan_annual_interest_rate ?? undefined,
        loan_term_months: pt.loan_term_months ?? undefined,
        loan_start_date: pt.loan_start_date ?? undefined,
        loan_payment_day: pt.loan_payment_day ?? undefined,
        loan_regular_payment_amount:
            pt.loan_regular_payment_amount ?? undefined,
        loan_first_payment_date: pt.loan_first_payment_date ?? undefined,
        loan_schedule: pt.loan_schedule || [],
        frequency: pt.is_recurring ? frequency : undefined,
        custom_interval_days,
        end_date: pt.recurrence_end_date ?? undefined,
        max_occurrences: pt.max_occurrences ?? undefined,
        recipient: pt.recipient_name,
        recipient_id: pt.recipient_id,
        category: pt.category_name,
        category_id: pt.category_id,
        bank_account: pt.bank_account,
        notes: pt.comment,
        tags: pt.tags?.map((tag) => tag.slug) ?? [],
        is_active: pt.is_active,
        is_executed: pt.is_executed,
        last_executed_date: pt.last_executed_date,
        executed_transaction_id: pt.executed_transaction_id,
        execution_count: pt.execution_count || 0,
        executions: pt.executions || [],
        created_at: pt.created_at,
    };
}

// Map frontend PlannedPayment to backend PlannedTransactionCreate format
export function mapToCreateAPI(
    payment: Omit<PlannedPayment, "id" | "created_at">,
): PlannedTransactionCreate {
    // Build recurrence_pattern from frequency
    let recurrence_pattern: string | undefined;
    if (payment.is_recurring && payment.frequency) {
        if (payment.frequency === "custom" && payment.custom_interval_days) {
            recurrence_pattern = `every ${payment.custom_interval_days} days`;
        } else {
            recurrence_pattern = payment.frequency;
        }
    }

    // Loans drive their own monthly schedule server-side (the backend stores
    // recurrence_pattern='monthly'); don't send a display string like
    // "loan(12 months)" — it isn't a valid pattern and the UI renders the loan
    // label from loan_term_months, not this field.

    return {
        planned_date: payment.due_date,
        bank_account: payment.bank_account || undefined,
        recipient_id: payment.recipient_id || undefined,
        memo: payment.name,
        amount: payment.amount,
        currency: payment.currency,
        category_id: payment.category_id,
        comment: payment.notes,
        url: payment.url,
        is_recurring: payment.is_recurring,
        recurrence_pattern,
        // Recurrence bounds — these were dropped here, so "ends Dec 2026 / max 12"
        // silently recurred forever (and the editor showed the loss as endless).
        recurrence_end_date: payment.end_date ?? undefined,
        max_occurrences: payment.max_occurrences ?? undefined,
        is_loan: !!payment.is_loan,
        loan_type: payment.loan_type,
        loan_principal: payment.loan_principal,
        loan_annual_interest_rate: payment.loan_annual_interest_rate,
        loan_term_months: payment.loan_term_months,
        loan_start_date: payment.loan_start_date,
        loan_payment_day: payment.loan_payment_day,
        tags: payment.tags,
    };
}

// Map frontend PlannedPayment partial updates to backend format
export function mapToUpdateAPI(
    updates: Partial<PlannedPayment>,
): PlannedTransactionUpdate {
    const result: PlannedTransactionUpdate = {};

    if (updates.due_date !== undefined) result.planned_date = updates.due_date;
    if (updates.bank_account !== undefined)
        result.bank_account = updates.bank_account;
    if (updates.recipient_id !== undefined)
        result.recipient_id = updates.recipient_id;
    if (updates.name !== undefined) result.memo = updates.name;
    if (updates.amount !== undefined) result.amount = updates.amount;
    if (updates.currency !== undefined) result.currency = updates.currency;
    if (updates.category_id !== undefined)
        result.category_id = updates.category_id;
    if (updates.notes !== undefined) result.comment = updates.notes;
    if (updates.url !== undefined) result.url = updates.url;
    if (updates.is_recurring !== undefined)
        result.is_recurring = updates.is_recurring;
    if (updates.end_date !== undefined)
        result.recurrence_end_date = updates.end_date ?? null;
    if (updates.max_occurrences !== undefined)
        result.max_occurrences = updates.max_occurrences ?? null;
    if (updates.is_loan !== undefined) result.is_loan = updates.is_loan;
    if (updates.loan_type !== undefined) result.loan_type = updates.loan_type;
    if (updates.loan_principal !== undefined)
        result.loan_principal = updates.loan_principal;
    if (updates.loan_annual_interest_rate !== undefined)
        result.loan_annual_interest_rate = updates.loan_annual_interest_rate;
    if (updates.loan_term_months !== undefined)
        result.loan_term_months = updates.loan_term_months;
    if (updates.loan_start_date !== undefined)
        result.loan_start_date = updates.loan_start_date;
    if (updates.loan_payment_day !== undefined)
        result.loan_payment_day = updates.loan_payment_day;
    if (updates.is_active !== undefined) result.is_active = updates.is_active;
    if (updates.tags !== undefined) result.tags = updates.tags;

    // Handle recurrence_pattern
    if (
        updates.frequency !== undefined ||
        updates.custom_interval_days !== undefined
    ) {
        const freq = updates.frequency;
        if (freq === "custom" && updates.custom_interval_days) {
            result.recurrence_pattern = `every ${updates.custom_interval_days} days`;
        } else if (freq) {
            result.recurrence_pattern = freq;
        }
    }

    return result;
}
