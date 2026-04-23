import { todayYmd } from '@/lib/timezone';

export type AddTransactionFormState = {
  transaction_date: string;
  bank_account: string;
  recipient_id: string;
  category_id: string;
  memo: string;
  amount: string;
  currency: string;
  comment: string;
};

export function createAddTransactionFormState(defaultCurrency?: string): AddTransactionFormState {
  return {
    transaction_date: todayYmd(),
    bank_account: "",
    recipient_id: "",
    category_id: "",
    memo: "",
    amount: "",
    currency: defaultCurrency || "EUR",
    comment: "",
  };
}
