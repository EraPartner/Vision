import { numberOrZero } from "../numeric.ts";
interface CostTransaction {
  type: string;
  date?: string | undefined;
  amount?: number | undefined;
  taxes?: number | undefined;
  fees?: number | undefined;
  currency?: string | undefined;
}

interface CostSummary {
  transactions: readonly CostTransaction[];
}

interface CostLabels {
  capitalGainsTax: string;
  dividendWithholding: string;
  transactionTax: string;
  otherTaxes: string;
  manualTaxAdjustments: string;
  brokerFees: string;
  managementFees: string;
  otherFees: string;
  manualFeeAdjustments: string;
}

interface CostBreakdownEntry {
  name: string;
  value: number;
}

interface BuildCostBreakdownsOptions<S extends CostSummary> {
  summaries: readonly S[];
  year: number;
  convert: (amount: number, currency?: string) => number;
  labels: CostLabels;
  manualTaxes: number;
  manualFees: number;
  /**
   * The TOB part of a sell's converted taxes (the TOB is due on the sale as on
   * the purchase). The rest of a sell's taxes is capital-gains tax when
   * `capitalGainsTaxActive`, otherwise another tax.
   */
  sellTransactionTax: (
    summary: S,
    transaction: S["transactions"][number],
  ) => number;
  capitalGainsTaxActive: boolean;
}

function yearOf(date?: string): number {
  return Number.parseInt(date?.slice(0, 4) ?? "", 10);
}

function addTo(
  values: Record<string, number>,
  key: string,
  amount: number,
): void {
  values[key] = (values[key] ?? 0) + amount;
}

function nonEmptyEntries(values: Record<string, number>): CostBreakdownEntry[] {
  return Object.entries(values)
    .map(([name, value]) => ({ name, value }))
    .filter(({ value }) => value > 0);
}

export function buildPortfolioCostBreakdowns<S extends CostSummary>({
  summaries,
  year,
  convert,
  labels,
  manualTaxes,
  manualFees,
  sellTransactionTax,
  capitalGainsTaxActive,
}: BuildCostBreakdownsOptions<S>): {
  taxBreakdown: CostBreakdownEntry[];
  feeBreakdown: CostBreakdownEntry[];
} {
  const taxes: Record<string, number> = {
    [labels.capitalGainsTax]: 0,
    [labels.dividendWithholding]: 0,
    [labels.transactionTax]: 0,
    [labels.otherTaxes]: 0,
    [labels.manualTaxAdjustments]: manualTaxes,
  };
  const fees: Record<string, number> = {
    [labels.brokerFees]: 0,
    [labels.managementFees]: 0,
    [labels.otherFees]: 0,
    [labels.manualFeeAdjustments]: manualFees,
  };

  for (const summary of summaries) {
    for (const transaction of summary.transactions) {
      if (yearOf(transaction.date) !== year) continue;

      const convertedTaxes = convert(
        numberOrZero(transaction.taxes),
        transaction.currency,
      );
      if (transaction.type === "sell" && convertedTaxes > 0) {
        const tob = sellTransactionTax(summary, transaction);
        if (tob > 0) addTo(taxes, labels.transactionTax, tob);
        if (convertedTaxes - tob > 0)
          addTo(
            taxes,
            capitalGainsTaxActive
              ? labels.capitalGainsTax
              : labels.otherTaxes,
            convertedTaxes - tob,
          );
      } else if (transaction.type === "dividend" && convertedTaxes > 0) {
        addTo(taxes, labels.dividendWithholding, convertedTaxes);
      } else if (transaction.type === "buy" && convertedTaxes > 0) {
        addTo(taxes, labels.transactionTax, convertedTaxes);
      } else if (transaction.type === "tax") {
        addTo(
          taxes,
          labels.otherTaxes,
          convert(numberOrZero(transaction.amount), transaction.currency),
        );
      } else if (convertedTaxes > 0) {
        addTo(taxes, labels.otherTaxes, convertedTaxes);
      }

      const convertedFees = convert(
        numberOrZero(transaction.fees),
        transaction.currency,
      );
      if (["buy", "sell"].includes(transaction.type) && convertedFees > 0) {
        addTo(fees, labels.brokerFees, convertedFees);
      } else if (transaction.type === "fee") {
        addTo(
          fees,
          labels.managementFees,
          convert(numberOrZero(transaction.amount), transaction.currency),
        );
      } else if (convertedFees > 0) {
        addTo(fees, labels.otherFees, convertedFees);
      }
    }
  }

  return {
    taxBreakdown: nonEmptyEntries(taxes),
    feeBreakdown: nonEmptyEntries(fees),
  };
}
