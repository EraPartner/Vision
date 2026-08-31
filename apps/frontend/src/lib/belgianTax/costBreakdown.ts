interface CostTransaction {
    type: string;
    date?: string;
    amount?: number;
    taxes?: number;
    fees?: number;
    currency?: string;
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

interface BuildCostBreakdownsOptions {
    summaries: readonly CostSummary[];
    year: number;
    convert: (amount: number, currency?: string) => number;
    labels: CostLabels;
    manualTaxes: number;
    manualFees: number;
}

function yearOf(date?: string): number {
    return Number.parseInt(date?.slice(0, 4) ?? "", 10);
}

function nonEmptyEntries(values: Record<string, number>): CostBreakdownEntry[] {
    return Object.entries(values)
        .map(([name, value]) => ({ name, value }))
        .filter(({ value }) => value > 0);
}

export function buildPortfolioCostBreakdowns({
    summaries,
    year,
    convert,
    labels,
    manualTaxes,
    manualFees,
}: BuildCostBreakdownsOptions): {
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
                Number(transaction.taxes) || 0,
                transaction.currency,
            );
            if (transaction.type === "sell" && convertedTaxes > 0) {
                taxes[labels.capitalGainsTax] += convertedTaxes;
            } else if (transaction.type === "dividend" && convertedTaxes > 0) {
                taxes[labels.dividendWithholding] += convertedTaxes;
            } else if (transaction.type === "buy" && convertedTaxes > 0) {
                taxes[labels.transactionTax] += convertedTaxes;
            } else if (transaction.type === "tax") {
                taxes[labels.otherTaxes] += convert(
                    Number(transaction.amount) || 0,
                    transaction.currency,
                );
            } else if (convertedTaxes > 0) {
                taxes[labels.otherTaxes] += convertedTaxes;
            }

            const convertedFees = convert(
                Number(transaction.fees) || 0,
                transaction.currency,
            );
            if (
                ["buy", "sell"].includes(transaction.type) &&
                convertedFees > 0
            ) {
                fees[labels.brokerFees] += convertedFees;
            } else if (transaction.type === "fee") {
                fees[labels.managementFees] += convert(
                    Number(transaction.amount) || 0,
                    transaction.currency,
                );
            } else if (convertedFees > 0) {
                fees[labels.otherFees] += convertedFees;
            }
        }
    }

    return {
        taxBreakdown: nonEmptyEntries(taxes),
        feeBreakdown: nonEmptyEntries(fees),
    };
}
