/** Synthetic source context for IBKR planner and PostgreSQL checks. */
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const columns = [
  "Date",
  "Account",
  "Description",
  "Transaction Type",
  "Symbol",
  "Quantity",
  "Price",
  "Price Currency",
  "Gross Amount",
  "Commission",
  "Net Amount",
  "Exchange Rate",
  "Transaction Fees",
];
export function syntheticIbkrPlannerSource(overrides = {}) {
  const values = {
    Date: "2026-01-01",
    Account: "SYNTHETIC-ACCOUNT",
    Description: "Synthetic statement trade",
    "Transaction Type": "Buy",
    Symbol: "IBKRTEST",
    Quantity: "5",
    Price: "100",
    "Price Currency": "USD",
    "Gross Amount": "-400",
    Commission: "-1.6",
    "Net Amount": "-401.6",
    "Exchange Rate": "0.8",
    "Transaction Fees": "0",
    ...overrides.literal,
  };
  const raw = [
    "Transaction History",
    "Data",
    ...columns.map((key) => values[key]),
  ].join(",");
  return {
    id: 10,
    batch_id: 2,
    row_index: 0,
    status: "matched",
    route: "portfolio",
    type: values["Transaction Type"].toLowerCase(),
    type_raw: values["Transaction Type"],
    tx_date: values.Date,
    investment_id: 1,
    asset_class: "stock",
    account_id: 7,
    symbol_raw: "IBKRTEST",
    name_raw: null,
    units: "5.00000000",
    price_per_unit: "100.000000",
    amount: "500.0000",
    fees: "2.0000",
    taxes: "0.0000",
    currency: "USD",
    fx_rate_to_eur: "0.8000000000",
    note: "Synthetic statement trade",
    raw_data: raw,
    source_record_hash: hash(raw),
    dedup_fingerprint: hash(raw),
    dedup_fingerprint_version: 1,
    source_account_identity: values.Account,
    custom_config: {
      format: "ibkr_transaction_history",
      ibkr_source_context: {
        version: 1,
        source_file_hash: hash("Synthetic full statement"),
        source_columns: columns,
        base_currency: "EUR",
        header_record: ["Transaction History", "Header", ...columns].join(","),
        summary_base_currency_record: "Summary,Data,Base Currency,EUR",
        record_hashes: [hash(raw)],
      },
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "literal"),
    ),
  };
}
