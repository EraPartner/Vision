import { addAll, multiply, toNumber } from "@vision/shared-utils/money";

interface ConvertibleAmount {
    amount: number;
    currency?: string;
}

type AvailableConverter = (
    amount: number,
    fromCurrency?: string,
) => number | undefined;

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
