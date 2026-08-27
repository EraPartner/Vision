export const MAX_COMPARE_SYMBOLS = 6;

const PROVIDER_SYMBOL_PATTERN = /^[A-Z0-9^][A-Z0-9.^=/_-]{0,31}$/;

export function normalizeResearchSymbol(raw: string): string | undefined {
    const symbol = raw.trim().toUpperCase();
    return PROVIDER_SYMBOL_PATTERN.test(symbol) ? symbol : undefined;
}

export function parseResearchSymbols(params: URLSearchParams): string[] {
    const unique: string[] = [];
    for (const raw of params.getAll("symbol")) {
        const symbol = normalizeResearchSymbol(raw);
        if (symbol && !unique.includes(symbol)) unique.push(symbol);
        if (unique.length === MAX_COMPARE_SYMBOLS) break;
    }
    return unique;
}
