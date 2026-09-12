import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";

export const DEFAULT_PORTFOLIO_IMPORT_CONFIG: PortfolioCustomConfig = {
    dateColumn: "",
    typeColumn: "",
    symbolColumn: "",
    nameColumn: "",
    unitsColumn: "",
    priceColumn: "",
    amountColumn: "",
    feesColumn: "",
    taxesColumn: "",
    currencyColumn: "",
    fxRateColumn: "",
    noteColumn: "",
    dateFormat: "%Y-%m-%d",
    separator: ",",
    encoding: "utf-8",
    skipRows: 0,
    defaultAssetClass: "stock",
    defaultType: "buy",
    typeMapping: {},
};

const PORTFOLIO_IMPORT_PRESETS: Record<string, PortfolioCustomConfig> = {
    ibkr: {
        ...DEFAULT_PORTFOLIO_IMPORT_CONFIG,
        format: "ibkr_transaction_history",
        dateColumn: "Date",
        typeColumn: "Transaction Type",
        symbolColumn: "Symbol",
        unitsColumn: "Quantity",
        priceColumn: "Price",
        amountColumn: "Gross Amount",
        feesColumn: "Commission",
        currencyColumn: "Price Currency",
        fxRateColumn: "Exchange Rate",
        noteColumn: "Description",
        typeMapping: { "Foreign Tax Withholding": "tax" },
    },
    kinesis: {
        ...DEFAULT_PORTFOLIO_IMPORT_CONFIG,
        format: "kinesis_transaction_history",
        dateColumn: "DateTime",
        typeColumn: "Transaction_Type",
        symbolColumn: "Currency_Code",
        unitsColumn: "Amount",
        priceColumn: "Trade_Price",
        amountColumn: "Trade_Value",
        feesColumn: "Fee",
        currencyColumn: "Trade_Value_Currency",
        defaultAssetClass: "crypto",
    },
    nexo: {
        ...DEFAULT_PORTFOLIO_IMPORT_CONFIG,
        format: "nexo_transaction_history",
        dateColumn: "Date / Time (UTC)",
        typeColumn: "Type",
        symbolColumn: "Output Currency",
        unitsColumn: "Output Amount",
        amountColumn: "USD Equivalent",
        feesColumn: "Fee",
        currencyColumn: "Output Currency",
        noteColumn: "Details",
        dateFormat: "%Y-%m-%d %H:%M:%S",
        defaultAssetClass: "crypto",
    },
    saxo: {
        ...DEFAULT_PORTFOLIO_IMPORT_CONFIG,
        format: "saxo_transaction_history",
        dateColumn: "Transactiedatum",
        typeColumn: "Acties",
        symbolColumn: "Instrumentsymbool",
        nameColumn: "Instrument",
        unitsColumn: "Acties",
        priceColumn: "Acties",
        amountColumn: "Boekingsbedrag",
        feesColumn: "Totale kosten",
        currencyColumn: "Instrumentvaluta",
        fxRateColumn: "Omrekeningskoers",
        noteColumn: "Opmerking",
        dateFormat: "%Y-%m-%d",
        defaultAssetClass: "stock",
    },
};

type SpecializedHintKey =
    | "portfolioImport.ibkrParserHint"
    | "portfolioImport.kinesisParserHint"
    | "portfolioImport.nexoParserHint"
    | "portfolioImport.saxoParserHint";

const SPECIALIZED_HINT_KEYS: Partial<
    Record<NonNullable<PortfolioCustomConfig["format"]>, SpecializedHintKey>
> = {
    ibkr_transaction_history: "portfolioImport.ibkrParserHint",
    kinesis_transaction_history: "portfolioImport.kinesisParserHint",
    nexo_transaction_history: "portfolioImport.nexoParserHint",
    saxo_transaction_history: "portfolioImport.saxoParserHint",
};

export function portfolioImportPresetConfig(
    source: string,
): PortfolioCustomConfig | undefined {
    const preset = PORTFOLIO_IMPORT_PRESETS[source];
    return preset ? { ...preset } : undefined;
}

export function portfolioImportSpecializedHintKey(
    format: PortfolioCustomConfig["format"],
): SpecializedHintKey | undefined {
    return format ? SPECIALIZED_HINT_KEYS[format] : undefined;
}
