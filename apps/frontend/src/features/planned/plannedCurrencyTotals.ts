import { addAll, multiply, toNumber } from "@/lib/money";

interface ConvertibleAmount {
  amount: number;
  currency?: string;
}

interface MonthlyConvertibleAmount extends ConvertibleAmount {
  is_active: boolean;
  is_recurring: boolean;
  frequency?: string | null;
  custom_interval_days?: number | null;
}

type AvailableConverter = (amount: number, fromCurrency?: string) => number | undefined;

interface ConvertedTotal {
  total: number;
  unavailableCount: number;
}

export function sumConvertedAmounts<T extends ConvertibleAmount>(
  items: T[],
  convertAmount: AvailableConverter,
  multiplier: (item: T) => number = () => 1,
): ConvertedTotal {
  const convertedAmounts: Array<ReturnType<typeof multiply>> = [];
  let unavailableCount = 0;

  for (const item of items) {
    const converted = convertAmount(item.amount, item.currency);
    if (converted === undefined) {
      unavailableCount += 1;
      continue;
    }
    convertedAmounts.push(multiply(converted, multiplier(item)));
  }

  return {
    total: toNumber(addAll(convertedAmounts)),
    unavailableCount,
  };
}

function monthlyMultiplier(item: MonthlyConvertibleAmount): number {
  return item.frequency === "daily" ? 30
    : item.frequency === "weekly" ? 4.33
      : item.frequency === "biweekly" ? 2.17
        : item.frequency === "monthly" ? 1
          : item.frequency === "quarterly" ? 1 / 3
            : item.frequency === "yearly" ? 1 / 12
              : item.frequency === "custom" && item.custom_interval_days
                ? 30 / item.custom_interval_days
                : 1;
}

export function sumConvertedMonthlyAmounts<T extends MonthlyConvertibleAmount>(
  items: T[],
  convertAmount: AvailableConverter,
): ConvertedTotal {
  return sumConvertedAmounts(
    items.filter((item) => item.is_active && item.is_recurring),
    convertAmount,
    monthlyMultiplier,
  );
}
