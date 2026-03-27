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
    transaction_date: new Date().toISOString().split("T")[0],
    bank_account: "",
    recipient_id: "",
    category_id: "",
    memo: "",
    amount: "",
    currency: defaultCurrency || "EUR",
    comment: "",
  };
}
