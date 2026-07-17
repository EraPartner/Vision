/**
 * Pure Belgian portfolio-tax estimators (TOB / Reynders / CGT / WHT / TACR).
 *
 * Extracted from PortfolioTaxPage so the math is unit-testable and no longer
 * duplicated across the portfolio-tax and tax-overview pages.
 *
 * Money accumulation runs through decimal.js: summing many per-transaction
 * floats with `+` compounds IEEE-754 error, which is the kind of drift that
 * shows up in figures users file taxes against. The injected `convert` still
 * returns a float (the FX rate table lives in a React context), so each term is
 * float-precise, but the *accumulation* is exact. Public functions return plain
 * `number` so callers are unchanged. The golden fixtures in portfolioTax.test.ts
 * lock outputs to 8 dp — far below the cent the UI renders — so this stays
 * behaviour-preserving. Currency conversion is injected because the rate table
 * lives in a React context; everything else is a pure function of its inputs.
 */
import Decimal from 'decimal.js';
import type { BelgianTaxYearTable } from './constants';

export type PortfolioTaxTxn = {
  type: string;
  date?: string;
  amount?: number;
  taxes?: number;
  fees?: number;
  currency?: string;
};

export type PortfolioTaxInvestment = {
  id: number;
  assetClass: string;
  currency?: string;
  transactions: PortfolioTaxTxn[];
  realizedGain?: number;
  currentValue?: number;
  etfStructure?: string;
  subjectToReynders?: boolean;
  reyndersInterestPortion?: number;
};

/** Convert an amount in `currency` to the active target currency. */
export type ConvertFn = (amount: number, currency?: string) => number;

/** Manual per-investment, per-year tax/fee adjustment. */
export type ManualAdjustment = { taxes: number; fees: number };

/** Sum a list of (possibly float) terms with exact decimal accumulation. */
function sumDecimal(terms: readonly (number | Decimal)[]): Decimal {
  return terms.reduce<Decimal>((acc, t) => acc.plus(t), new Decimal(0));
}

/** Parse the 4-digit year prefix of an ISO date. */
export function yearOf(date?: string): number | null {
  if (!date) return null;
  const n = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(n) ? n : null;
}

/** Recorded costs of one kind in `txYear`: explicit txns of `txnType` + the per-txn `field`. */
function recordedForYear(
  inv: PortfolioTaxInvestment,
  txYear: number,
  convert: ConvertFn,
  txnType: 'tax' | 'fee',
  field: 'taxes' | 'fees',
): number {
  const terms: number[] = [];
  for (const txn of inv.transactions) {
    if (yearOf(txn.date) !== txYear) continue;
    if (txn.type === txnType) terms.push(convert(Number(txn.amount) || 0, txn.currency));
    terms.push(convert(Number(txn[field]) || 0, txn.currency));
  }
  return sumDecimal(terms).toNumber();
}

/** Recorded taxes for one investment in `txYear`: explicit `tax` txns + per-txn `taxes` field. */
export function recordedTaxesForYear(
  inv: PortfolioTaxInvestment,
  txYear: number,
  convert: ConvertFn,
): number {
  return recordedForYear(inv, txYear, convert, 'tax', 'taxes');
}

/** Recorded fees for one investment in `txYear`: explicit `fee` txns + per-txn `fees` field. */
export function recordedFeesForYear(
  inv: PortfolioTaxInvestment,
  txYear: number,
  convert: ConvertFn,
): number {
  return recordedForYear(inv, txYear, convert, 'fee', 'fees');
}

export interface InvestmentCosts {
  recordedTaxes: number;
  recordedFees: number;
  manualTaxes: number;
  manualFees: number;
  taxes: number;
  fees: number;
  total: number;
}

/** Combine recorded + manual taxes/fees for one investment/year. */
export function enrichInvestmentCosts(
  inv: PortfolioTaxInvestment,
  txYear: number,
  convert: ConvertFn,
  manual: ManualAdjustment,
): InvestmentCosts {
  const recordedTaxes = recordedTaxesForYear(inv, txYear, convert);
  const recordedFees = recordedFeesForYear(inv, txYear, convert);
  const taxes = new Decimal(recordedTaxes).plus(manual.taxes).toNumber();
  const fees = new Decimal(recordedFees).plus(manual.fees).toNumber();
  return {
    recordedTaxes,
    recordedFees,
    manualTaxes: manual.taxes,
    manualFees: manual.fees,
    taxes,
    fees,
    total: new Decimal(taxes).plus(fees).toNumber(),
  };
}

/** TOB (stock-exchange tax) actually recorded on `buy` txns in `txYear`. */
export function computeTobRecorded(
  investments: readonly PortfolioTaxInvestment[],
  txYear: number,
  convert: ConvertFn,
): number {
  const terms: number[] = [];
  for (const inv of investments) {
    for (const txn of inv.transactions) {
      if (yearOf(txn.date) !== txYear) continue;
      if (txn.type === 'buy') terms.push(convert(Number(txn.taxes) || 0, txn.currency));
    }
  }
  return sumDecimal(terms).toNumber();
}

/**
 * Auto-TOB: estimated stock-exchange tax on `buy` legs, capped per leg. ETFs
 * default to the accumulating-fund rate unless `etfStructure === 'distributing'`.
 */
export function computeTobAutoEstimate(
  investments: readonly PortfolioTaxInvestment[],
  txYear: number,
  taxTable: BelgianTaxYearTable,
  convert: ConvertFn,
): number {
  const tobRates = taxTable.tob;
  const rateForInvestment = (inv: PortfolioTaxInvestment): { rate: number; cap: number } | null => {
    switch (inv.assetClass) {
      case 'bond':
        return tobRates.bonds;
      case 'stock':
        return tobRates.sharesAndOther;
      case 'etf':
        return inv.etfStructure === 'distributing'
          ? tobRates.distributingFunds
          : tobRates.accumulatingFunds;
      default:
        return null;
    }
  };
  const legs: Decimal[] = [];
  for (const inv of investments) {
    const params = rateForInvestment(inv);
    if (!params) continue;
    for (const txn of inv.transactions) {
      if (txn.type !== 'buy' || yearOf(txn.date) !== txYear) continue;
      const amount = convert(Math.abs(Number(txn.amount) || 0), txn.currency);
      legs.push(Decimal.min(new Decimal(amount).times(params.rate), params.cap));
    }
  }
  return sumDecimal(legs).toNumber();
}

/**
 * Securities-account tax (TACR) — flat rate on aggregate value once it crosses
 * the threshold. Uses aggregate current value as a conservative proxy.
 */
export function computeTacrEstimate(
  investments: readonly PortfolioTaxInvestment[],
  taxTable: BelgianTaxYearTable,
  convert: ConvertFn,
): number {
  const aggregate = sumDecimal(
    investments.map((inv) => convert(Number(inv.currentValue) || 0, inv.currency)),
  );
  if (aggregate.lt(taxTable.securitiesAccountTaxThreshold)) return 0;
  return aggregate.times(taxTable.securitiesAccountTaxRate).toNumber();
}

export interface RealizedGainSplit {
  reyndersInterest: number;
  cgtGains: number;
}

/**
 * Route positive realized gains across the Reynders-interest pool (30%) and the
 * CGT pool (10%, from IY 2026). See PortfolioTaxPage history for the full
 * Reynders/CGT resolution rules this mirrors.
 */
export function computeRealizedGainSplit(
  investments: readonly PortfolioTaxInvestment[],
  convert: ConvertFn,
  cgtActive: boolean,
): RealizedGainSplit {
  let reyndersInterest = new Decimal(0);
  let cgtGains = new Decimal(0);
  for (const inv of investments) {
    const gainNum = convert(Number(inv.realizedGain) || 0, inv.currency);
    if (gainNum <= 0) continue;
    const gain = new Decimal(gainNum);
    const override = inv.subjectToReynders;
    const subjectToReynders = override === undefined ? inv.assetClass === 'bond' : override;
    if (subjectToReynders) {
      const portionRaw = inv.reyndersInterestPortion;
      const portion =
        typeof portionRaw === 'number' && portionRaw >= 0 && portionRaw <= 1 ? portionRaw : 1;
      reyndersInterest = reyndersInterest.plus(gain.times(portion));
      if (cgtActive) cgtGains = cgtGains.plus(gain.times(1 - portion));
    } else if (inv.assetClass !== 'bond') {
      cgtGains = cgtGains.plus(gain);
    } else if (cgtActive) {
      cgtGains = cgtGains.plus(gain);
    }
  }
  return { reyndersInterest: reyndersInterest.toNumber(), cgtGains: cgtGains.toNumber() };
}

/** Reynders tax — flat rate on the interest-attributable portion of fund gains. */
export function computeReyndersEstimate(
  split: RealizedGainSplit,
  taxTable: BelgianTaxYearTable,
): number {
  if (!taxTable.reyndersTaxRate) return 0;
  if (split.reyndersInterest <= 0) return 0;
  return new Decimal(split.reyndersInterest).times(taxTable.reyndersTaxRate).toNumber();
}

/** Capital-gains tax — flat rate on CGT-pool gains above the filing-status exemption. */
export function computeCgtEstimate(
  split: RealizedGainSplit,
  taxTable: BelgianTaxYearTable,
  filingStatus: string | undefined,
  cgtActive: boolean,
): number {
  if (!cgtActive) return 0;
  if (split.cgtGains <= 0) return 0;
  const exemption =
    filingStatus === 'married_joint'
      ? taxTable.capitalGainsTaxExemptionMarried
      : taxTable.capitalGainsTaxExemptionSingle;
  const taxable = Decimal.max(new Decimal(split.cgtGains).minus(exemption), 0);
  return taxable.times(taxTable.capitalGainsTaxRate).toNumber();
}

export interface DividendWht {
  totalDividendIncome: number;
  dividendWhtRecorded: number;
  grossDividendBase: number;
  grossDividendWht: number;
  dividendWhtReclaim: number;
  dividendWhtNetCost: number;
}

/** Dividend withholding tax: income, recorded WHT, and the exempt-bracket reclaim. */
export function computeDividendWht(
  investments: readonly PortfolioTaxInvestment[],
  txYear: number,
  taxTable: BelgianTaxYearTable,
  convert: ConvertFn,
  filingStatus?: string,
): DividendWht {
  const incomeTerms: number[] = [];
  const whtTerms: number[] = [];
  for (const inv of investments) {
    for (const txn of inv.transactions) {
      if (yearOf(txn.date) !== txYear || txn.type !== 'dividend') continue;
      incomeTerms.push(convert(Number(txn.amount) || 0, txn.currency));
      whtTerms.push(convert(Number(txn.taxes) || 0, txn.currency));
    }
  }
  const totalDividendIncome = sumDecimal(incomeTerms);
  const dividendWhtRecorded = sumDecimal(whtTerms);

  const grossDividendBase = totalDividendIncome.plus(dividendWhtRecorded);
  // The Belgian dividend exemption (~€859 for IY2025) is per taxpayer, so joint
  // filers can reclaim up to 2× — mirrors computeCgtEstimate's married doubling.
  const exemption =
    filingStatus === 'married_joint'
      ? new Decimal(taxTable.dividendExemption).times(2)
      : new Decimal(taxTable.dividendExemption);
  const reclaimCap = Decimal.min(grossDividendBase, exemption).times(taxTable.dividendWHTRate);
  const dividendWhtReclaim = Decimal.min(dividendWhtRecorded, reclaimCap);
  const dividendWhtNetCost = Decimal.max(dividendWhtRecorded.minus(dividendWhtReclaim), 0);

  return {
    totalDividendIncome: totalDividendIncome.toNumber(),
    dividendWhtRecorded: dividendWhtRecorded.toNumber(),
    grossDividendBase: grossDividendBase.toNumber(),
    grossDividendWht: dividendWhtRecorded.toNumber(),
    dividendWhtReclaim: dividendWhtReclaim.toNumber(),
    dividendWhtNetCost: dividendWhtNetCost.toNumber(),
  };
}
