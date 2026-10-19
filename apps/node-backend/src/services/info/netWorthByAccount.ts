/**
 * Current net worth by account (ADR-093, ADR-216): each account that counts
 * toward net worth contributes its cash balance, converted to the target
 * currency at the latest stored rate, and every account (or the unassigned
 * bucket) its live holdings partitions from the portfolio summary.
 *
 * Holdings-only portfolio accounts (crypto exchanges, wallets) hold value only
 * as holdings, so their cash balance is not counted. A cash balance without a
 * stored rate is flagged and left out of the totals, never added 1:1.
 */

import accountService from "../accountService.ts";
import { resolveLiveSummary } from "./liveSummary.ts";
import {
  convertAtLatestRates,
  loadLatestRatesToEur,
} from "../currency/latestRateConversion.ts";
import type { CurrencyCode } from "@vision/types/brands";
import { addAll, money, roundMoney } from "../../lib/money.ts";
import { storedCurrencyCode } from "../../lib/currencyCode.ts";

const HOLDINGS_ONLY_ACCOUNT_TYPES = new Set(["crypto_exchange", "wallet"]);

export interface NetWorthAccountRow {
  /** null for holdings not assigned to an account. */
  accountId: number | null;
  /** display_name or name; null for the unassigned row or an unknown account. */
  name: string | null;
  type: string | null;
  /** The account's own currency, the source of `cash`. */
  cashCurrency: string | null;
  /** Converted cash balance; null when the account currency has no rate. */
  cash: number | null;
  holdings: number;
  /** cash + holdings; null when cash could not be converted. */
  total: number | null;
  unconverted: boolean;
}

export async function getNetWorthByAccount(targetCurrency: CurrencyCode) {
  const target = storedCurrencyCode(targetCurrency);
  const [{ items: accounts }, summary, rates] = await Promise.all([
    accountService.list({ active: null }),
    resolveLiveSummary(target),
    loadLatestRatesToEur(),
  ]);

  const accountsById = new Map(
    accounts.map((account) => [Number(account.id), account]),
  );
  const cashById = new Map<number, number | null>();
  for (const account of accounts) {
    if (!account.in_net_worth) continue;
    if (HOLDINGS_ONLY_ACCOUNT_TYPES.has(account.type)) {
      cashById.set(Number(account.id), 0);
      continue;
    }
    const converted = convertAtLatestRates(
      money(account.computed_balance ?? 0, storedCurrencyCode(account.currency)),
      target,
      rates,
    );
    cashById.set(
      Number(account.id),
      converted === undefined ? null : roundMoney(converted.amount),
    );
  }

  const holdingsById = new Map<number | null, number[]>();
  for (const partition of summary.byAccount) {
    const id =
      partition.account_id == null ? null : Number(partition.account_id);
    const values = holdingsById.get(id) ?? [];
    values.push(partition.currentValue);
    holdingsById.set(id, values);
  }

  const ids = new Set<number | null>([
    ...cashById.keys(),
    ...holdingsById.keys(),
  ]);
  const rows: NetWorthAccountRow[] = [...ids]
    .sort((a, b) => (a == null ? 1 : b == null ? -1 : a - b))
    .map((accountId) => {
      const account =
        accountId == null ? undefined : accountsById.get(accountId);
      // null = unconverted cash; accounts outside net worth contribute 0.
      const cash: number | null =
        accountId != null && cashById.has(accountId)
          ? (cashById.get(accountId) ?? null)
          : 0;
      const holdings = roundMoney(addAll(holdingsById.get(accountId) ?? []));
      return {
        accountId,
        name: account ? account.display_name || account.name : null,
        type: account?.type ?? null,
        cashCurrency: account
          ? storedCurrencyCode(account.currency)
          : null,
        cash,
        holdings,
        total: cash === null ? null : roundMoney(addAll([cash, holdings])),
        unconverted: cash === null,
      };
    });

  const unconvertedAccountIds = rows
    .filter((row) => row.unconverted)
    .map((row) => row.accountId as number);
  return {
    currency: target,
    rows,
    /** Σ row totals; null while any cash balance is unconverted. */
    total:
      unconvertedAccountIds.length > 0
        ? null
        : roundMoney(addAll(rows.map((row) => row.total))),
    unconvertedAccountIds,
  };
}
