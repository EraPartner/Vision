export const ANALYSIS_DATASET_CATALOG_VERSION = 1;

const DATASETS = [
  {
    id: "transactions",
    schemaVersion: 1,
    relation: "vision_analysis.transactions_v1",
    grain: "one canonical ledger transaction, including inactive history",
    authorizationScope: "local-user-database",
    timeBasis: "transaction_date is a calendar date in APP_TIMEZONE",
    currencySemantics:
      "amount is expressed in currency; cross-currency aggregation requires an explicit reporting-currency conversion",
    signSemantics:
      "negative is an outflow and positive is an inflow or refund; is_transfer identifies internal movements",
    coverage:
      "all canonical ledger rows; raw import payloads and duplicate identities are excluded",
    primaryKey: ["transaction_id"],
    joinPaths: [
      {
        id: "transactions.account",
        toDatasetId: "accounts",
        cardinality: "many-to-one",
        fields: ["account_id"],
      },
    ],
  },
  {
    id: "accounts",
    schemaVersion: 1,
    relation: "vision_analysis.accounts_v1",
    grain: "one canonical own-account entity",
    authorizationScope: "local-user-database",
    timeBasis:
      "statement balance entries carry their own calendar balance_date",
    currencySemantics:
      "currency is the declared account currency; statement_balances retains each native currency independently",
    signSemantics:
      "statement balances retain the bank-declared signed value; liability interpretation uses account_type",
    coverage:
      "all own accounts including archived accounts; credential and provider configuration is excluded",
    primaryKey: ["account_id"],
    joinPaths: [],
  },
  {
    id: "holdings",
    schemaVersion: 1,
    relation: "vision_analysis.holding_events_v1",
    grain: "one canonical portfolio event used to replay holdings",
    authorizationScope: "local-user-database",
    timeBasis:
      "event_date is a calendar date; same-day replay orders by event_id with sells after other unit events",
    currencySemantics:
      "amount, fees and taxes use event currency; fx_rate_to_eur is transaction-date conversion evidence when present",
    signSemantics:
      "buy and gift add units, sell removes units, and corporate actions require the canonical portfolio replay engine",
    coverage:
      "all portfolio events; current units, cost basis and gain must be calculated by the versioned canonical engine",
    primaryKey: ["event_id"],
    joinPaths: [
      {
        id: "holdings.account",
        toDatasetId: "accounts",
        cardinality: "many-to-one",
        fields: ["account_id"],
      },
    ],
  },
  {
    id: "cash-flows",
    schemaVersion: 1,
    relation: "vision_analysis.cash_flows_v1",
    grain: "one canonical budgeting ledger transaction",
    authorizationScope: "local-user-database",
    timeBasis: "cash_flow_date is a calendar date in APP_TIMEZONE",
    currencySemantics:
      "all amount columns use currency; cross-currency totals require an explicit reporting-currency conversion",
    signSemantics:
      "signed_amount retains ledger sign; spending_amount is positive magnitude for non-transfer negative rows; positive_flow_amount combines income and refunds",
    coverage:
      "budgeting ledger cash flows only; portfolio income is excluded unless represented by a linked ledger transaction",
    primaryKey: ["cash_flow_id"],
    joinPaths: [
      {
        id: "cash-flows.account",
        toDatasetId: "accounts",
        cardinality: "many-to-one",
        fields: ["account_id"],
      },
    ],
  },
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const ANALYSIS_DATASETS_V1 = deepFreeze(DATASETS);

export function getAnalysisDataset(id, schemaVersion = 1) {
  return ANALYSIS_DATASETS_V1.find(
    (dataset) => dataset.id === id && dataset.schemaVersion === schemaVersion,
  );
}

export function assertAnalysisDatasetReference(reference) {
  const dataset = getAnalysisDataset(reference.id, reference.schemaVersion);
  if (!dataset) {
    throw new Error(
      `Unsupported analysis dataset ${reference.id}@${reference.schemaVersion}`,
    );
  }
  if (reference.authorizationScope !== dataset.authorizationScope) {
    throw new Error(
      `Analysis dataset scope mismatch for ${reference.id}@${reference.schemaVersion}`,
    );
  }
  for (const column of reference.requiredColumns ?? []) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(column)) {
      throw new Error(`Invalid analysis column identifier: ${column}`);
    }
  }
  return dataset;
}
