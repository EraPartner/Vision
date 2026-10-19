/**
 * Accounts hub totals (ADR-216): every account's computed balance converted to
 * one display currency, the per-group subtotals and the "Net cash" line, all
 * computed here instead of in the browser.
 *
 * Each balance partition (ADR-094) converts on its own at the latest stored
 * rate. A partition without a rate is left out and its account is counted as
 * unconverted, never added 1:1.
 *
 * Populations (same rules the hub has always used):
 *   groups       cash (checking, savings, pension) · portfolio (brokerage,
 *                crypto_exchange, wallet) · liabilities · archived (any
 *                inactive account, whatever its type)
 *   subtotal     ledger balances of the group's accounts, except the
 *                holdings-only types (crypto_exchange, wallet), plus the
 *                position value the portfolio summary assigns to the group's
 *                portfolio-type accounts
 *   net cash     active, in_net_worth, non-portfolio accounts
 */

import accountRepository from "../repositories/accountRepository.ts";
import type { AccountBalanceQueryRow } from "../types/rows.ts";
import type { CurrencyCode } from "@vision/types/brands";
import {
  addMoney,
  money,
  roundMoney,
  sumMoney,
  toDecimal,
  type Decimal,
  type Money,
} from "../lib/money.ts";
import { EUR } from "../lib/currencyCode.ts";
import { logger } from "../config/logger.ts";
import {
  convertAtLatestRates,
  currencyCode,
  loadLatestRatesToEur,
  type LatestRatesToEur,
} from "./currency/latestRateConversion.ts";
import { getPortfolioSummary } from "./portfolio/portfolioSummaryService.ts";
import {
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  portfolioSummaryCache,
  resolveCacheWithInflight,
} from "./info/cache.ts";

const ACCOUNT_GROUP_IDS = [
  "cash",
  "portfolio",
  "liabilities",
  "archived",
] as const;
type AccountGroupId = (typeof ACCOUNT_GROUP_IDS)[number];

const PORTFOLIO_TYPES = new Set(["brokerage", "crypto_exchange", "wallet"]);
const HOLDINGS_ONLY_TYPES = new Set(["crypto_exchange", "wallet"]);

function groupOf(row: AccountBalanceQueryRow): AccountGroupId {
  if (row.is_active === false) return "archived";
  if (row.type === "liability") return "liabilities";
  if (PORTFOLIO_TYPES.has(row.type)) return "portfolio";
  return "cash";
}

interface ConvertedAccount {
  row: AccountBalanceQueryRow;
  group: AccountGroupId;
  balance: Money;
  unconvertedCurrencies: CurrencyCode[];
}

function convertAccount(
  row: AccountBalanceQueryRow,
  target: CurrencyCode,
  rates: LatestRatesToEur,
): ConvertedAccount {
  const amounts: Money[] = [];
  const unconvertedCurrencies: CurrencyCode[] = [];
  for (const part of row.balance_parts ?? []) {
    const from = currencyCode(part.currency);
    const converted = convertAtLatestRates(
      money(part.balance, from),
      target,
      rates,
    );
    if (converted) amounts.push(converted);
    else if (!toDecimal(part.balance).isZero())
      unconvertedCurrencies.push(from);
  }
  return {
    row,
    group: groupOf(row),
    balance: sumMoney(amounts, target),
    unconvertedCurrencies,
  };
}

/** Sum of converted balances plus the accounts that had a part left out. */
function total(accounts: ConvertedAccount[], target: CurrencyCode) {
  const incomplete = accounts.filter((a) => a.unconvertedCurrencies.length > 0);
  return {
    total: sumMoney(
      accounts.map((a) => a.balance),
      target,
    ).amount,
    unconverted_count: incomplete.length,
    unconverted_currencies: [
      ...new Set(incomplete.flatMap((a) => a.unconvertedCurrencies)),
    ].sort(),
  };
}

/**
 * Position value per account from the canonical portfolio summary (shared
 * cache with GET /api/info/portfolio-summary), or undefined when the summary
 * cannot be computed.
 */
async function holdingsByAccount(
  target: CurrencyCode,
): Promise<Map<number, Money> | undefined> {
  try {
    const summary = await resolveCacheWithInflight(
      portfolioSummaryCache,
      target,
      {
        ttlMs: PORTFOLIO_SUMMARY_CACHE_TTL_MS,
        loader: () => getPortfolioSummary(target),
      },
    );
    const values = new Map<number, Money>();
    for (const row of summary.byAccount) {
      if (row.account_id == null || row.contribution_kind !== "position")
        continue;
      // The summary is computed in `target`, so its values are already Money in it.
      const value = money(row.currentValue, target);
      const previous = values.get(row.account_id);
      values.set(row.account_id, previous ? addMoney(previous, value) : value);
    }
    return values;
  } catch (err) {
    logger.warn("Account totals: portfolio holdings unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function computeAccountTotals({
  currency = EUR,
}: { currency?: CurrencyCode } = {}) {
  const target = currency;
  const [rows, rates] = await Promise.all([
    accountRepository.getAll({ active: null }),
    loadLatestRatesToEur(),
  ]);
  const accounts = rows.map((row) => convertAccount(row, target, rates));
  const needsHoldings = accounts.some((a) => PORTFOLIO_TYPES.has(a.row.type));
  const holdings = needsHoldings ? await holdingsByAccount(target) : new Map();

  const groups = Object.fromEntries(
    ACCOUNT_GROUP_IDS.map((id) => {
      const members = accounts.filter((a) => a.group === id);
      const cash = total(
        members.filter((a) => !HOLDINGS_ONLY_TYPES.has(a.row.type)),
        target,
      );
      const portfolioMembers = members.filter((a) =>
        PORTFOLIO_TYPES.has(a.row.type),
      );
      const holdingsUnavailable =
        portfolioMembers.length > 0 && holdings === undefined;
      const holdingsTotal = sumMoney(
        portfolioMembers.map(
          (a) => holdings?.get(a.row.id) ?? money(0, target),
        ),
        target,
      ).amount;
      return [
        id,
        {
          total: roundMoney(cash.total.plus(holdingsTotal)),
          cash: roundMoney(cash.total),
          holdings: roundMoney(holdingsTotal),
          holdings_unavailable: holdingsUnavailable,
          unconverted_count: cash.unconverted_count,
          unconverted_currencies: cash.unconverted_currencies,
        },
      ];
    }),
  ) as Record<
    AccountGroupId,
    {
      total: number;
      cash: number;
      holdings: number;
      holdings_unavailable: boolean;
      unconverted_count: number;
      unconverted_currencies: CurrencyCode[];
    }
  >;

  const netCash = total(
    accounts.filter(
      (a) =>
        a.row.is_active &&
        a.row.in_net_worth &&
        !PORTFOLIO_TYPES.has(a.row.type),
    ),
    target,
  );

  return {
    currency: target,
    net_cash: {
      total: roundMoney(netCash.total),
      unconverted_count: netCash.unconverted_count,
      unconverted_currencies: netCash.unconverted_currencies,
    },
    groups,
    accounts: accounts.map((a) => ({
      id: Number(a.row.id),
      group: a.group,
      converted_balance: roundMoney(a.balance.amount),
      unconverted_currencies: a.unconvertedCurrencies,
    })),
  };
}
