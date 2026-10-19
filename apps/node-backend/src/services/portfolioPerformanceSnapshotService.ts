/**
 * Portfolio Performance Snapshot Service
 *
 * Thin orchestrator — delegates snapshot computation/storage to snapshotBuilder,
 * exposes DB read helpers, and re-exports math utilities consumed by info routes.
 */

import { withTransaction } from "../database/connection.ts";
import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  accountDisplayNameRowSchema,
  brokerSnapshotRowSchema,
  currentDateRowSchema,
  portfolioPerformanceSnapshotRowSchema,
  regclassRowSchema,
} from "../database/rows/portfolio.ts";
import { toYmd } from "../lib/dateFormat.ts";
import {
  computeMetrics,
  computeHeatmap,
} from "./calculations/portfolioMath.ts";
import { computeAndStoreSnapshots as computeAggregateSnapshots } from "./portfolio/snapshotBuilder.ts";
import {
  getPortfolioSummary,
  getBreakdownSummary,
} from "./portfolio/portfolioSummaryService.ts";
import { addAll, toDecimal } from "../lib/money.ts";
import type { Decimal } from "../lib/money.ts";
import { nanToZero } from "../lib/math.ts";
import type { AccountId, CurrencyCode } from "@vision/types/brands";

/** One `getSnapshots` row, as served to the performance chart. */
export type PortfolioPerformanceSnapshot = {
  snapshot_date: Date;
  invested: string;
  value: string;
  stocks_etfs_value: string;
  crypto_value: string;
  metals_value: string;
  cash_value: string;
  gain_loss: string;
  return_pct: string;
  inflation_adjusted_value: string;
  stocks_etfs_invested: string;
  crypto_invested: string;
  metals_invested: string;
  currency: CurrencyCode;
  value_fx_neutral: string | undefined;
};
interface BrokerSnapshotPartition {
  accountKey: string;
  accountId: number | null;
  accountName: string;
  value: Decimal;
  invested: Decimal;
  gainLoss: Decimal;
}

// Re-export the imported bindings so both `import { x } from` consumers and the
// default-object consumers below share a single declaration each (SIMP-51).
export { computeMetrics, computeHeatmap };
export { getPortfolioSummary, getBreakdownSummary };

const BROKER_HISTORY_PARITY_TOLERANCE = 0.011;

async function hasBrokerSnapshotTable() {
  const row = await checkedRow(
    regclassRowSchema,
    sql`SELECT to_regclass('public.portfolio_broker_snapshots') AS relation`,
  );
  return Boolean(row?.relation);
}

/**
 * Store exactly one forward-only broker split for the current app date.
 * Older dates are never recalculated, so later lot retagging cannot rewrite
 * history.  The current date is replaceable because price/account changes
 * during the day must settle to one internally consistent close.
 */
export async function __storeCurrentBrokerSnapshot(
  currency: string,
  summary: Awaited<ReturnType<typeof getPortfolioSummary>>,
) {
  if (!(await hasBrokerSnapshotTable())) return { stored: false, rows: 0 };

  const accountIds = [
    ...new Set(
      summary.byAccount.map((row) => row.account_id).filter((id) => id != null),
    ),
  ];
  return withTransaction(async () => {
    const nameRows =
      accountIds.length > 0
        ? await checkedRows(
            accountDisplayNameRowSchema,
            db
              .selectFrom("accounts")
              .select([
                "id",
                sql<string>`COALESCE(NULLIF(display_name, ''), name)`.as(
                  "display_name",
                ),
              ])
              .where("id", "=", sql<AccountId>`ANY(${accountIds}::int[])`),
          )
        : [];
    const names = new Map<number, string>(
      nameRows.map((row) => [Number(row.id), row.display_name]),
    );

    const byKey = new Map<string, BrokerSnapshotPartition>();
    for (const row of summary.byAccount) {
      const key =
        row.account_id == null ? "unassigned" : `account:${row.account_id}`;
      const current = byKey.get(key) ?? {
        accountKey: key,
        accountId: row.account_id,
        accountName:
          row.account_id == null
            ? "Unassigned"
            : (names.get(Number(row.account_id)) ??
              `Account ${row.account_id}`),
        value: toDecimal(0),
        invested: toDecimal(0),
        gainLoss: toDecimal(0),
      };
      current.value = current.value.plus(
        toDecimal(nanToZero(row.currentValue)),
      );
      current.invested = current.invested.plus(
        toDecimal(nanToZero(row.totalInvested)),
      );
      current.gainLoss = current.gainLoss.plus(
        toDecimal(nanToZero(row.gainLoss)),
      );
      byKey.set(key, current);
    }

    const rows = [...byKey.values()];
    const valueSum = addAll(rows.map((row) => row.value));
    const parity = summary.brokerSnapshotParity;
    const parityDifference = parity
      ? toDecimal(parity.partitionValue).minus(parity.totalValue)
      : valueSum.minus(nanToZero(summary.totals.totalPortfolioValue));
    if (
      parity
        ? !parityDifference.toDecimalPlaces(6).isZero()
        : parityDifference.abs().gt(BROKER_HISTORY_PARITY_TOLERANCE)
    ) {
      throw new Error(
        `Broker snapshot parity failed: partitions=${parity?.partitionValue ?? valueSum.toFixed(2)} total=${parity?.totalValue ?? toDecimal(nanToZero(summary.totals.totalPortfolioValue)).toFixed(2)}`,
      );
    }

    const snapshotDate: string | undefined = (
      await checkedRow(
        currentDateRowSchema,
        sql`SELECT CURRENT_DATE::text AS today`,
      )
    )?.today;
    await sql`DELETE FROM portfolio_broker_snapshots
      WHERE snapshot_date = ${snapshotDate} AND currency = ${currency}`.execute(db);
    for (const row of rows) {
      await sql`INSERT INTO portfolio_broker_snapshots
          (snapshot_date, currency, account_key, account_id, account_name,
           value, invested, gain_loss, computed_at)
        VALUES (${snapshotDate}, ${currency}, ${row.accountKey}, ${row.accountId},
                ${row.accountName}, ${row.value.toString()}, ${row.invested.toString()},
                ${row.gainLoss.toString()}, now())`.execute(db);
    }
    return { stored: true, rows: rows.length, snapshotDate };
  });
}

/** Recompute aggregate history, then append/replace today's broker split only. */
export async function computeAndStoreSnapshots(targetCurrency = "EUR") {
  const snapshots = await computeAggregateSnapshots(targetCurrency);
  if (snapshots.length === 0 || !(await hasBrokerSnapshotTable())) {
    return snapshots;
  }
  const summary = await getPortfolioSummary(targetCurrency, {
    includeBrokerSnapshotParity: true,
  });
  await __storeCurrentBrokerSnapshot(targetCurrency, summary);
  return snapshots;
}

function selectSnapshots(currency: string) {
  return db
    .selectFrom("portfolio_performance_snapshots")
    .selectAll()
    .where(sql<string>`currency`, "=", currency);
}

/**
 * @param startDate 'YYYY-MM-DD'
 * @param endDate 'YYYY-MM-DD'
 */
export async function getSnapshots(
  startDate: string,
  endDate: string,
  currency = "EUR",
): Promise<PortfolioPerformanceSnapshot[]> {
  // SELECT * + shape in JS: value_fx_neutral only exists once migration 0039
  // is applied, and enumerating it in SQL would break un-migrated databases.
  const rows = await checkedRows(
    portfolioPerformanceSnapshotRowSchema,
    selectSnapshots(currency)
      .where("snapshot_date", ">=", sql<Date>`${startDate}`)
      .where("snapshot_date", "<=", sql<Date>`${endDate}`)
      .orderBy("snapshot_date", "asc"),
  );

  return rows.map((row) => ({
    snapshot_date: row.snapshot_date,
    invested: row.invested,
    value: row.value,
    stocks_etfs_value: row.stocks_etfs_value,
    crypto_value: row.crypto_value,
    metals_value: row.metals_value,
    cash_value: row.cash_value,
    gain_loss: row.gain_loss,
    return_pct: row.return_pct,
    inflation_adjusted_value: row.inflation_adjusted_value ?? row.value,
    stocks_etfs_invested: row.stocks_etfs_invested ?? "0",
    crypto_invested: row.crypto_invested ?? "0",
    metals_invested: row.metals_invested ?? "0",
    currency: row.currency,
    // undefined (omitted from JSON) when the column is absent or unpopulated —
    // the frontend hides the FX-neutral series in that case.
    value_fx_neutral: row.value_fx_neutral ?? undefined,
  }));
}

export async function getBrokerSnapshots(
  startDate: string,
  endDate: string,
  currency = "EUR",
) {
  if (!(await hasBrokerSnapshotTable())) return [];
  const rows = await checkedRows(
    brokerSnapshotRowSchema,
    db
      .selectFrom("portfolio_broker_snapshots")
      .select([
        "snapshot_date",
        "currency",
        "account_key",
        "account_id",
        "account_name",
        "value",
        "invested",
        "gain_loss",
        "computed_at",
      ])
      .where(sql<string>`currency`, "=", currency)
      .where("snapshot_date", ">=", sql<Date>`${startDate}`)
      .where("snapshot_date", "<=", sql<Date>`${endDate}`)
      .orderBy("snapshot_date", "asc")
      .orderBy("account_key", "asc"),
  );
  return rows.map((row) => ({
    // A pg DATE is a local-midnight Date: format its local calendar day, not
    // its UTC instant (which is the previous day east of UTC).
    date: toYmd(row.snapshot_date),
    currency: row.currency,
    accountKey: row.account_key,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountName: row.account_name,
    assignment: row.account_id == null ? "unassigned" : "account",
    value: Number(row.value),
    invested: Number(row.invested),
    gainLoss: Number(row.gain_loss),
    computedAt: row.computed_at,
  }));
}

async function getLatestSnapshot(currency = "EUR") {
  const row = await checkedRow(
    portfolioPerformanceSnapshotRowSchema,
    selectSnapshots(currency).orderBy("snapshot_date", "desc").limit(1),
  );

  return row ?? null;
}

export { getLatestSnapshot as __getLatestSnapshot };
