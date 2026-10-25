import Foundation

/// Read models retain server-owned Decimal amounts and their reporting currency.

/// Whether a partition, broker series or broker row belongs to a broker account.
public typealias PortfolioAssignment = OpenAPI.PortfolioSummaryByAccountItem.Assignment

public struct PortfolioInvestment: Codable, Equatable, Sendable, Identifiable {
    public let id: InvestmentID
    public let name: String
    public let symbol: String?
    public let assetClass: OpenAPI.AssetClass
    public let currency: CurrencyCode
    public let currentPrice: Decimal?
    public let interestRate: Decimal?
    public let maturityDate: String?
    public let location: String?
    public let municipality: String?
    public let cadastralIncome: Decimal?
    public let municipalityTaxRate: Decimal?
    public let notes: String?
    public let isActive: Bool
    public let priceProvider: OpenAPI.PriceProvider
    public let priceProviderId: String?  // lint:allow raw-id provider symbol, not a Vision entity (UNTYPED_IDS)
    public let priceProviderUrl: String?
    public let priceProviderLatestUrl: String?
    public let priceProviderLatestPath: String?
    public let priceProviderHistoryUrl: String?
    public let priceProviderHistoryPath: String?
    public let priceProviderHistoryTsPath: String?
    public let priceProviderHistoryPricePath: String?
    public let priceUpdatedAt: String?
    public let showInTicker: Bool?
    public let createdAt: String
    public let updatedAt: String
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case symbol = "symbol"
        case assetClass = "asset_class"
        case currency = "currency"
        case currentPrice = "current_price"
        case interestRate = "interest_rate"
        case maturityDate = "maturity_date"
        case location = "location"
        case municipality = "municipality"
        case cadastralIncome = "cadastral_income"
        case municipalityTaxRate = "municipality_tax_rate"
        case notes = "notes"
        case isActive = "is_active"
        case priceProvider = "price_provider"
        case priceProviderId = "price_provider_id"
        case priceProviderUrl = "price_provider_url"
        case priceProviderLatestUrl = "price_provider_latest_url"
        case priceProviderLatestPath = "price_provider_latest_path"
        case priceProviderHistoryUrl = "price_provider_history_url"
        case priceProviderHistoryPath = "price_provider_history_path"
        case priceProviderHistoryTsPath = "price_provider_history_ts_path"
        case priceProviderHistoryPricePath = "price_provider_history_price_path"
        case priceUpdatedAt = "price_updated_at"
        case showInTicker = "show_in_ticker"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(InvestmentID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol)
        assetClass = try values.decode(OpenAPI.AssetClass.self, forKey: .assetClass)
        currency = try values.decode(CurrencyCode.self, forKey: .currency)
        currentPrice = try values.portfolioDecimalIfPresent(forKey: .currentPrice)
        interestRate = try values.portfolioDecimalIfPresent(forKey: .interestRate)
        maturityDate = try values.decodeIfPresent(String.self, forKey: .maturityDate)
        location = try values.decodeIfPresent(String.self, forKey: .location)
        municipality = try values.decodeIfPresent(String.self, forKey: .municipality)
        cadastralIncome = try values.portfolioDecimalIfPresent(forKey: .cadastralIncome)
        municipalityTaxRate = try values.portfolioDecimalIfPresent(forKey: .municipalityTaxRate)
        notes = try values.decodeIfPresent(String.self, forKey: .notes)
        isActive = try values.decode(Bool.self, forKey: .isActive)
        priceProvider = try values.decode(OpenAPI.PriceProvider.self, forKey: .priceProvider)
        priceProviderId = try values.decodeIfPresent(String.self, forKey: .priceProviderId)
        priceProviderUrl = try values.decodeIfPresent(String.self, forKey: .priceProviderUrl)
        priceProviderLatestUrl = try values.decodeIfPresent(String.self, forKey: .priceProviderLatestUrl)
        priceProviderLatestPath = try values.decodeIfPresent(String.self, forKey: .priceProviderLatestPath)
        priceProviderHistoryUrl = try values.decodeIfPresent(String.self, forKey: .priceProviderHistoryUrl)
        priceProviderHistoryPath = try values.decodeIfPresent(String.self, forKey: .priceProviderHistoryPath)
        priceProviderHistoryTsPath = try values.decodeIfPresent(String.self, forKey: .priceProviderHistoryTsPath)
        priceProviderHistoryPricePath = try values.decodeIfPresent(String.self, forKey: .priceProviderHistoryPricePath)
        priceUpdatedAt = try values.decodeIfPresent(String.self, forKey: .priceUpdatedAt)
        showInTicker = try values.decodeIfPresent(Bool.self, forKey: .showInTicker)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
    }
}

public struct PortfolioTransaction: Codable, Equatable, Sendable, Identifiable {
    public let id: PortfolioTransactionID
    public let investmentId: InvestmentID
    public let type: OpenAPI.PortfolioTxnType
    public let date: String
    public let amount: Decimal
    public let units: Decimal?
    public let pricePerUnit: Decimal?
    public let fees: Decimal?
    public let taxes: Decimal?
    public let currency: CurrencyCode
    public let fxRateToEur: Decimal?
    public let note: String?
    public let accountId: AccountID?
    public let isRecurring: Bool
    public let recurrenceInterval: OpenAPI.RecurrenceInterval?
    public let recurrenceEndDate: String?
    public let importBatchId: PortfolioImportBatchID?
    public let createdAt: String
    public let updatedAt: String
    public let incomeRecognitionRole: OpenAPI.PortfolioTransaction.IncomeRecognitionRole
    public let dividendAmountConvention: OpenAPI.PortfolioTransaction.DividendAmountConvention
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case investmentId = "investment_id"
        case type = "type"
        case date = "date"
        case amount = "amount"
        case units = "units"
        case pricePerUnit = "price_per_unit"
        case fees = "fees"
        case taxes = "taxes"
        case currency = "currency"
        case fxRateToEur = "fx_rate_to_eur"
        case note = "note"
        case accountId = "account_id"
        case isRecurring = "is_recurring"
        case recurrenceInterval = "recurrence_interval"
        case recurrenceEndDate = "recurrence_end_date"
        case importBatchId = "import_batch_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case incomeRecognitionRole = "income_recognition_role"
        case dividendAmountConvention = "dividend_amount_convention"
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(PortfolioTransactionID.self, forKey: .id)
        investmentId = try values.decode(InvestmentID.self, forKey: .investmentId)
        type = try values.decode(OpenAPI.PortfolioTxnType.self, forKey: .type)
        date = try values.decode(String.self, forKey: .date)
        amount = try values.portfolioDecimal(forKey: .amount)
        units = try values.portfolioDecimalIfPresent(forKey: .units)
        pricePerUnit = try values.portfolioDecimalIfPresent(forKey: .pricePerUnit)
        fees = try values.portfolioDecimalIfPresent(forKey: .fees)
        taxes = try values.portfolioDecimalIfPresent(forKey: .taxes)
        currency = try values.decode(CurrencyCode.self, forKey: .currency)
        fxRateToEur = try values.portfolioDecimalIfPresent(forKey: .fxRateToEur)
        note = try values.decodeIfPresent(String.self, forKey: .note)
        accountId = try values.decodeIfPresent(AccountID.self, forKey: .accountId)
        isRecurring = try values.decode(Bool.self, forKey: .isRecurring)
        recurrenceInterval = try values.decodeIfPresent(OpenAPI.RecurrenceInterval.self, forKey: .recurrenceInterval)
        recurrenceEndDate = try values.decodeIfPresent(String.self, forKey: .recurrenceEndDate)
        importBatchId = try values.decodeIfPresent(PortfolioImportBatchID.self, forKey: .importBatchId)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        incomeRecognitionRole =
            values.contains(.incomeRecognitionRole)
            ? try values.decode(OpenAPI.PortfolioTransaction.IncomeRecognitionRole.self, forKey: .incomeRecognitionRole)
            : .standard
        dividendAmountConvention = try values.decode(
            OpenAPI.PortfolioTransaction.DividendAmountConvention.self, forKey: .dividendAmountConvention)
        let verifiedRole: Bool
        switch incomeRecognitionRole {
        case .standard: verifiedRole = true
        case .includedInUnits: verifiedRole = type == .dividend
        case .unknown: verifiedRole = false
        }
        guard verifiedRole else {
            throw DecodingError.dataCorruptedError(
                forKey: .incomeRecognitionRole, in: values,
                debugDescription: "Unverified portfolio income recognition role")
        }
    }
}

public struct PortfolioHolding: Decodable, Equatable, Sendable, Identifiable {
    public let id: InvestmentID
    public let name: String
    public let symbol: String?
    public let assetClass: OpenAPI.AssetClass
    public let isActive: Bool
    public let currency: CurrencyCode
    public let originalCurrency: CurrencyCode
    public let createdAt: String
    public let updatedAt: String
    public let notes: String?
    public let location: String?
    public let municipality: String?
    public let cadastralIncome: Decimal?
    public let municipalityTaxRate: Decimal?
    public let maturityDate: String?
    public let priceProvider: OpenAPI.PriceProvider?
    public let priceProviderId: String?  // lint:allow raw-id provider symbol, not a Vision entity (UNTYPED_IDS)
    public let priceUpdatedAt: String?
    public let totalUnits: Decimal
    public let currentPrice: Decimal
    public let interestRate: Decimal
    public let totalInvested: Decimal
    public let totalBuyCost: Decimal
    public let totalSellProceeds: Decimal
    public let currentValue: Decimal
    public let totalFees: Decimal
    public let totalTaxes: Decimal
    public let totalDividends: Decimal
    public let totalIncome: Decimal
    public let avgCostBasis: Decimal
    public let realizedGain: Decimal
    public let unrealizedGain: Decimal
    public let totalGain: Decimal
    public let gainLoss: Decimal
    public let gainLossPercent: Decimal
    public let assetGain: Decimal?
    public let fxGain: Decimal?
    public let nativeCurrentValue: Decimal?
    public let accruedInterest: Decimal
    public let projectedAnnualInterest: Decimal
    public let totalAppreciation: Decimal
    public let totalInKindIncome: Decimal?
    public let usedFallbackRate: Bool?
    public let fullyAssigned: Bool
    public let oversold: Bool
    public let byAccount: [PortfolioPartition]
    public let transactionCount: Int?
    public let summarySource: String?
    public let nativeCurrentPrice: Decimal?
    public let nativeAvgCostBasis: Decimal?
    public let unrealizedGainPercent: Decimal?
    /// Latest rent_income amount in its booking currency, without conversion.
    public let estimatedMonthlyRent: Decimal?
    /// Latest rent converted to the reporting currency at the latest stored rate on the server.
    /// `0` without rent; `nil` when the rent's currency has no stored rate (ADR-216).
    public let monthlyRent: Decimal?
    /// `totalFees + totalTaxes`, from the server's rounded fields.
    public let feesAndTaxes: Decimal?
    /// Real estate return: `totalAppreciation + totalIncome - totalFees - totalTaxes`, on the server.
    public let propertyReturn: Decimal?
    /// This holding's figures per broker account, every contribution kind summed on the server.
    /// The broker filter reads these instead of adding `byAccount` rows.
    public let accountTotals: [OpenAPI.PortfolioSummaryAccountTotals]
    public var isClosed: Bool { totalUnits <= 0 && currentValue == 0 }
    /// A provider other than `manual`; an absent or empty provider is manual.
    public var hasLiveProvider: Bool {
        guard let provider = priceProvider, provider != .unknown("") else { return false }
        return provider != .manual
    }
    public func rawValue(_ key: String) -> TableRawValue {
        switch key {
        case "name": .text(name)
        case "symbol": symbol.map(TableRawValue.text) ?? .none
        case "assetClass": .text(assetClass.rawValue)
        case "currency": .text(currency.rawValue)
        case "totalUnits": .number(totalUnits)
        case "currentPrice": .number(currentPrice)
        case "currentValue": .number(currentValue)
        case "totalInvested": .number(totalInvested)
        case "gainLoss": .number(gainLoss)
        case "gainLossPercent": .number(gainLossPercent)
        default: .none
        }
    }
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case symbol = "symbol"
        case assetClass = "assetClass"
        case isActive = "is_active"
        case currency = "currency"
        case originalCurrency = "originalCurrency"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case notes = "notes"
        case location = "location"
        case municipality = "municipality"
        case cadastralIncome = "cadastral_income"
        case municipalityTaxRate = "municipality_tax_rate"
        case maturityDate = "maturity_date"
        case priceProvider = "price_provider"
        case priceProviderId = "price_provider_id"
        case priceUpdatedAt = "price_updated_at"
        case totalUnits = "totalUnits"
        case currentPrice = "currentPrice"
        case interestRate = "interestRate"
        case totalInvested = "totalInvested"
        case totalBuyCost = "totalBuyCost"
        case totalSellProceeds = "totalSellProceeds"
        case currentValue = "currentValue"
        case totalFees = "totalFees"
        case totalTaxes = "totalTaxes"
        case totalDividends = "totalDividends"
        case totalIncome = "totalIncome"
        case avgCostBasis = "avgCostBasis"
        case realizedGain = "realizedGain"
        case unrealizedGain = "unrealizedGain"
        case totalGain = "totalGain"
        case gainLoss = "gainLoss"
        case gainLossPercent = "gainLossPercent"
        case assetGain = "assetGain"
        case fxGain = "fxGain"
        case nativeCurrentValue = "nativeCurrentValue"
        case accruedInterest = "accruedInterest"
        case projectedAnnualInterest = "projectedAnnualInterest"
        case totalAppreciation = "totalAppreciation"
        case totalInKindIncome = "totalInKindIncome"
        case usedFallbackRate = "usedFallbackRate"
        case fullyAssigned = "fullyAssigned"
        case oversold = "oversold"
        case byAccount = "byAccount"
        case transactionCount = "transactionCount"
        case summarySource, nativeCurrentPrice, nativeAvgCostBasis, unrealizedGainPercent, estimatedMonthlyRent
        case monthlyRent, feesAndTaxes, propertyReturn, accountTotals
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(InvestmentID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol)
        assetClass = try values.decode(OpenAPI.AssetClass.self, forKey: .assetClass)
        isActive = try values.decode(Bool.self, forKey: .isActive)
        currency = try values.decode(CurrencyCode.self, forKey: .currency)
        originalCurrency = try values.decode(CurrencyCode.self, forKey: .originalCurrency)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        notes = try values.decodeIfPresent(String.self, forKey: .notes)
        location = try values.decodeIfPresent(String.self, forKey: .location)
        municipality = try values.decodeIfPresent(String.self, forKey: .municipality)
        cadastralIncome = try values.portfolioDecimalIfPresent(forKey: .cadastralIncome)
        municipalityTaxRate = try values.portfolioDecimalIfPresent(forKey: .municipalityTaxRate)
        maturityDate = try values.decodeIfPresent(String.self, forKey: .maturityDate)
        priceProvider = try values.decodeIfPresent(OpenAPI.PriceProvider.self, forKey: .priceProvider)
        priceProviderId = try values.decodeIfPresent(String.self, forKey: .priceProviderId)
        priceUpdatedAt = try values.decodeIfPresent(String.self, forKey: .priceUpdatedAt)
        totalUnits = try values.decode(Decimal.self, forKey: .totalUnits)
        currentPrice = try values.decode(Decimal.self, forKey: .currentPrice)
        interestRate = try values.decode(Decimal.self, forKey: .interestRate)
        totalInvested = try values.decode(Decimal.self, forKey: .totalInvested)
        totalBuyCost = try values.decode(Decimal.self, forKey: .totalBuyCost)
        totalSellProceeds = try values.decode(Decimal.self, forKey: .totalSellProceeds)
        currentValue = try values.decode(Decimal.self, forKey: .currentValue)
        totalFees = try values.decode(Decimal.self, forKey: .totalFees)
        totalTaxes = try values.decode(Decimal.self, forKey: .totalTaxes)
        totalDividends = try values.decode(Decimal.self, forKey: .totalDividends)
        totalIncome = try values.decode(Decimal.self, forKey: .totalIncome)
        avgCostBasis = try values.decode(Decimal.self, forKey: .avgCostBasis)
        realizedGain = try values.decode(Decimal.self, forKey: .realizedGain)
        unrealizedGain = try values.decode(Decimal.self, forKey: .unrealizedGain)
        totalGain = try values.decode(Decimal.self, forKey: .totalGain)
        gainLoss = try values.decode(Decimal.self, forKey: .gainLoss)
        gainLossPercent = try values.decode(Decimal.self, forKey: .gainLossPercent)
        assetGain = try values.decodeIfPresent(Decimal.self, forKey: .assetGain)
        fxGain = try values.decodeIfPresent(Decimal.self, forKey: .fxGain)
        nativeCurrentValue = try values.decodeIfPresent(Decimal.self, forKey: .nativeCurrentValue)
        accruedInterest = try values.decode(Decimal.self, forKey: .accruedInterest)
        projectedAnnualInterest = try values.decode(Decimal.self, forKey: .projectedAnnualInterest)
        totalAppreciation = try values.decode(Decimal.self, forKey: .totalAppreciation)
        totalInKindIncome = try values.decodeIfPresent(Decimal.self, forKey: .totalInKindIncome)
        usedFallbackRate = try values.decodeIfPresent(Bool.self, forKey: .usedFallbackRate)
        fullyAssigned = try values.decode(Bool.self, forKey: .fullyAssigned)
        oversold = try values.decode(Bool.self, forKey: .oversold)
        byAccount = try values.decode([PortfolioPartition].self, forKey: .byAccount)
        transactionCount = try values.decodeIfPresent(Int.self, forKey: .transactionCount)
        summarySource = try values.decodeIfPresent(String.self, forKey: .summarySource)
        nativeCurrentPrice = try values.decodeIfPresent(Decimal.self, forKey: .nativeCurrentPrice)
        nativeAvgCostBasis = try values.decodeIfPresent(Decimal.self, forKey: .nativeAvgCostBasis)
        unrealizedGainPercent = try values.decodeIfPresent(Decimal.self, forKey: .unrealizedGainPercent)
        estimatedMonthlyRent = try values.decodeIfPresent(Decimal.self, forKey: .estimatedMonthlyRent)
        monthlyRent = try values.portfolioDecimalIfPresent(forKey: .monthlyRent)
        feesAndTaxes = try values.portfolioDecimalIfPresent(forKey: .feesAndTaxes)
        propertyReturn = try values.portfolioDecimalIfPresent(forKey: .propertyReturn)
        accountTotals =
            try values.decodeIfPresent([OpenAPI.PortfolioSummaryAccountTotals].self, forKey: .accountTotals) ?? []
    }
}

public struct PortfolioPartition: Codable, Equatable, Sendable {
    public let accountId: AccountID?
    public let assignment: PortfolioAssignment
    public let contributionKind: OpenAPI.PortfolioSummaryByAccountItem.ContributionKind
    public let oversold: Bool
    public let currentValue: Decimal
    public let totalInvested: Decimal
    public let realizedGain: Decimal
    public let unrealizedGain: Decimal
    public let gainLoss: Decimal
    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case assignment = "assignment"
        case contributionKind = "contribution_kind"
        case oversold = "oversold"
        case currentValue = "currentValue"
        case totalInvested = "totalInvested"
        case realizedGain = "realizedGain"
        case unrealizedGain = "unrealizedGain"
        case gainLoss = "gainLoss"
    }
}

public struct PortfolioTotals: Codable, Equatable, Sendable {
    public let totalPortfolioValue: Decimal
    public let totalInvested: Decimal
    public let totalGainLoss: Decimal
    public let totalRealizedGain: Decimal
    public let totalUnrealizedGain: Decimal
    public let totalGain: Decimal
    public let totalIncome: Decimal
    public let totalFees: Decimal
    public let totalTaxes: Decimal
    public let totalAssetGain: Decimal
    public let totalFxGain: Decimal
    public let totalReturnPct: Decimal
    public let totalInKindIncome: Decimal?
    public let usedFallbackRate: Bool
    enum CodingKeys: String, CodingKey {
        case totalPortfolioValue = "totalPortfolioValue"
        case totalInvested = "totalInvested"
        case totalGainLoss = "totalGainLoss"
        case totalRealizedGain = "totalRealizedGain"
        case totalUnrealizedGain = "totalUnrealizedGain"
        case totalGain = "totalGain"
        case totalIncome = "totalIncome"
        case totalFees = "totalFees"
        case totalTaxes = "totalTaxes"
        case totalAssetGain = "totalAssetGain"
        case totalFxGain = "totalFxGain"
        case totalReturnPct = "totalReturnPct"
        case totalInKindIncome = "totalInKindIncome"
        case usedFallbackRate = "usedFallbackRate"
    }
}

public struct PortfolioCashFees: Codable, Equatable, Sendable {
    public let total: Decimal
    public let gainAfterFees: Decimal
    public let usedFallbackRate: Bool
    public let byAccount: [PortfolioCashFeeAccount]
    enum CodingKeys: String, CodingKey {
        case total = "total"
        case gainAfterFees = "gainAfterFees"
        case usedFallbackRate = "usedFallbackRate"
        case byAccount = "byAccount"
    }
}

public struct PortfolioCashFeeAccount: Codable, Equatable, Sendable {
    public let accountId: AccountID
    public let total: Decimal
    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case total = "total"
    }
}

public struct PortfolioSummaryData: Decodable, Equatable, Sendable {
    public let currency: CurrencyCode
    public let computedAt: String
    public let totals: PortfolioTotals
    public let summaries: [PortfolioHolding]
    public let byAccount: [PortfolioPartition]
    public let brokerageCashFees: PortfolioCashFees?
    /// Portfolio-wide figures per broker account (`account_id` nil is unassigned), summed on the
    /// server: the broker filter's options and subtotals.
    public let accountTotals: [OpenAPI.PortfolioSummaryAccountTotals]
    /// Totals per asset class present in `summaries`, and per asset page group, summed on the
    /// server (ADR-216): the asset pages and the allocation read these, never summing holdings.
    public let byAssetClass: [OpenAPI.PortfolioAssetClassTotals]
    public let byAssetGroup: [OpenAPI.PortfolioAssetGroupTotals]
    public let firstInvestmentDate: String?
    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case computedAt = "computed_at"
        case totals = "totals"
        case summaries = "summaries"
        case byAccount = "byAccount"
        case brokerageCashFees = "brokerageCashFees"
        case accountTotals, byAssetClass, byAssetGroup
        case firstInvestmentDate
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        currency = try values.decode(CurrencyCode.self, forKey: .currency)
        computedAt = try values.decode(String.self, forKey: .computedAt)
        totals = try values.decode(PortfolioTotals.self, forKey: .totals)
        summaries = try values.decode([PortfolioHolding].self, forKey: .summaries)
        byAccount = try values.decode([PortfolioPartition].self, forKey: .byAccount)
        brokerageCashFees = try values.decodeIfPresent(PortfolioCashFees.self, forKey: .brokerageCashFees)
        accountTotals =
            try values.decodeIfPresent([OpenAPI.PortfolioSummaryAccountTotals].self, forKey: .accountTotals) ?? []
        byAssetClass =
            try values.decodeIfPresent([OpenAPI.PortfolioAssetClassTotals].self, forKey: .byAssetClass) ?? []
        byAssetGroup =
            try values.decodeIfPresent([OpenAPI.PortfolioAssetGroupTotals].self, forKey: .byAssetGroup) ?? []
        firstInvestmentDate = try values.decodeIfPresent(String.self, forKey: .firstInvestmentDate)
    }
}

/// The server totals of one asset page (`findHoldingTotals`, hooks/portfolio/assetGroupTotals.ts).
public struct PortfolioHoldingTotals: Equatable, Sendable {
    public let totalPortfolioValue: Decimal
    public let totalInvested: Decimal
    public let totalRealizedGain: Decimal
    public let totalUnrealizedGain: Decimal
    public let totalIncome: Decimal
    public let totalDividends: Decimal
    public let totalFeesAndTaxes: Decimal
    public let netReturnExcludingIncome: Decimal
    public let netReturnWithDividends: Decimal
    public let totalAppreciation: Decimal
    public let totalPropertyReturn: Decimal
    public let totalAccruedInterest: Decimal
    public let totalProjectedAnnualInterest: Decimal
    public let valueWeightedInterestRate: Decimal
    public let estimatedMonthlyRent: Decimal
    /// Some property's rent has no stored rate, so the monthly rent is incomplete.
    public let monthlyRentRateMissing: Bool

    /// Shown while the summary is loading or holds no matching group.
    public static let empty = PortfolioHoldingTotals(
        totalPortfolioValue: 0, totalInvested: 0, totalRealizedGain: 0, totalUnrealizedGain: 0, totalIncome: 0,
        totalDividends: 0, totalFeesAndTaxes: 0, netReturnExcludingIncome: 0, netReturnWithDividends: 0,
        totalAppreciation: 0, totalPropertyReturn: 0, totalAccruedInterest: 0, totalProjectedAnnualInterest: 0,
        valueWeightedInterestRate: 0, estimatedMonthlyRent: 0, monthlyRentRateMissing: false)
}

extension PortfolioHoldingTotals {
    init(_ group: OpenAPI.PortfolioAssetGroupTotals) {
        self.init(
            totalPortfolioValue: group.totalPortfolioValue, totalInvested: group.totalInvested,
            totalRealizedGain: group.totalRealizedGain, totalUnrealizedGain: group.totalUnrealizedGain,
            totalIncome: group.totalIncome, totalDividends: group.totalDividends,
            totalFeesAndTaxes: group.totalFeesAndTaxes, netReturnExcludingIncome: group.netReturnExcludingIncome,
            netReturnWithDividends: group.netReturnWithDividends, totalAppreciation: group.totalAppreciation,
            totalPropertyReturn: group.totalPropertyReturn, totalAccruedInterest: group.totalAccruedInterest,
            totalProjectedAnnualInterest: group.totalProjectedAnnualInterest,
            valueWeightedInterestRate: group.valueWeightedInterestRate,
            estimatedMonthlyRent: group.estimatedMonthlyRent, monthlyRentRateMissing: group.monthlyRentRateMissing)
    }

    init(_ entry: OpenAPI.PortfolioAssetClassTotals) {
        self.init(
            totalPortfolioValue: entry.totalPortfolioValue, totalInvested: entry.totalInvested,
            totalRealizedGain: entry.totalRealizedGain, totalUnrealizedGain: entry.totalUnrealizedGain,
            totalIncome: entry.totalIncome, totalDividends: entry.totalDividends,
            totalFeesAndTaxes: entry.totalFeesAndTaxes, netReturnExcludingIncome: entry.netReturnExcludingIncome,
            netReturnWithDividends: entry.netReturnWithDividends, totalAppreciation: entry.totalAppreciation,
            totalPropertyReturn: entry.totalPropertyReturn, totalAccruedInterest: entry.totalAccruedInterest,
            totalProjectedAnnualInterest: entry.totalProjectedAnnualInterest,
            valueWeightedInterestRate: entry.valueWeightedInterestRate,
            estimatedMonthlyRent: entry.estimatedMonthlyRent, monthlyRentRateMissing: entry.monthlyRentRateMissing)
    }
}

extension PortfolioSummaryData {
    /// The server totals of exactly these asset classes: the asset group with the same classes, or
    /// the single class's own entry (`findHoldingTotals`).
    public func holdingTotals(assetClasses: [OpenAPI.AssetClass]) -> PortfolioHoldingTotals {
        let wanted = Set(assetClasses)
        // The generated totals name their classes as text; compare them as asset classes.
        let group = byAssetGroup.first { entry in
            Set(entry.assetClasses.map { OpenAPI.AssetClass(rawValue: $0) }) == wanted
        }
        if let group {
            return PortfolioHoldingTotals(group)
        }
        if assetClasses.count == 1,
            let single = byAssetClass.first(where: { OpenAPI.AssetClass(rawValue: $0.assetClass) == assetClasses[0] })
        {
            return PortfolioHoldingTotals(single)
        }
        return .empty
    }
}

public struct PortfolioPerformanceSnapshot: Codable, Equatable, Sendable, Identifiable {
    public let date: String
    public let invested: Decimal
    public let value: Decimal
    public let stocksEtfsValue: Decimal
    public let cryptoValue: Decimal
    public let metalsValue: Decimal
    public let stocksEtfsInvested: Decimal
    public let cryptoInvested: Decimal
    public let metalsInvested: Decimal
    public let inflationAdjustedValue: Decimal
    public let gainLoss: Decimal
    public let returnPct: Decimal
    public let isProvisional: Bool
    public let valueFxNeutral: Decimal?
    public var id: String { date }
    enum CodingKeys: String, CodingKey {
        case date = "date"
        case invested = "invested"
        case value = "value"
        case stocksEtfsValue = "stocks_etfs_value"
        case cryptoValue = "crypto_value"
        case metalsValue = "metals_value"
        case stocksEtfsInvested = "stocks_etfs_invested"
        case cryptoInvested = "crypto_invested"
        case metalsInvested = "metals_invested"
        case inflationAdjustedValue = "inflation_adjusted_value"
        case gainLoss = "gain_loss"
        case returnPct = "return_pct"
        case isProvisional = "is_provisional"
        case valueFxNeutral = "value_fx_neutral"
    }
}

public struct PortfolioPerformanceMetrics: Codable, Equatable, Sendable {
    public let currentValue: Decimal
    public let totalInvested: Decimal
    public let totalGainLoss: Decimal
    public let totalReturnPct: Decimal
    public let annualizedReturn: Decimal
    public let realReturnPct: Decimal
    public let cumulativeInflation: Decimal
    enum CodingKeys: String, CodingKey {
        case currentValue = "currentValue"
        case totalInvested = "totalInvested"
        case totalGainLoss = "totalGainLoss"
        case totalReturnPct = "totalReturnPct"
        case annualizedReturn = "annualizedReturn"
        case realReturnPct = "realReturnPct"
        case cumulativeInflation = "cumulativeInflation"
    }
}

public struct PortfolioHeatmap: Codable, Equatable, Sendable {
    public let years: [Int]
    public let data: [String: [Decimal?]]
    public let maxAbsPct: Decimal
    enum CodingKeys: String, CodingKey {
        case years = "years"
        case data = "data"
        case maxAbsPct = "maxAbsPct"
    }
}

public struct PortfolioPerformanceBreakdown: Codable, Equatable, Sendable, Identifiable {
    public let id: InvestmentID
    public let name: String
    public let symbol: String?
    public let assetClass: OpenAPI.AssetClass
    public let currency: CurrencyCode
    public let currentValue: Decimal
    public let totalInvested: Decimal
    public let gainLoss: Decimal
    public let gainLossPercent: Decimal
    public let assetGain: Decimal?
    public let fxGain: Decimal?
    public let nativeCurrentValue: Decimal?
    public let usedFallbackRate: Bool?
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case symbol = "symbol"
        case assetClass = "assetClass"
        case currency = "currency"
        case currentValue = "currentValue"
        case totalInvested = "totalInvested"
        case gainLoss = "gainLoss"
        case gainLossPercent = "gainLossPercent"
        case assetGain = "assetGain"
        case fxGain = "fxGain"
        case nativeCurrentValue = "nativeCurrentValue"
        case usedFallbackRate = "usedFallbackRate"
    }
}

public struct PortfolioPerformanceData: Codable, Equatable, Sendable {
    public let currency: CurrencyCode
    public let startDate: String
    public let endDate: String
    public let snapshots: [PortfolioPerformanceSnapshot]
    public let metrics: PortfolioPerformanceMetrics?
    public let heatmap: PortfolioHeatmap
    public let breakdownSummary: [PortfolioPerformanceBreakdown]
    public let totals: PortfolioTotals?
    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case startDate = "start_date"
        case endDate = "end_date"
        case snapshots = "snapshots"
        case metrics = "metrics"
        case heatmap = "heatmap"
        case breakdownSummary = "breakdownSummary"
        case totals = "totals"
    }
}

public struct PortfolioBrokerSeries: Codable, Equatable, Sendable, Identifiable {
    public let accountKey: String
    public let accountId: AccountID?
    public let accountName: String
    public let assignment: PortfolioAssignment
    public var id: String { accountKey }
    enum CodingKeys: String, CodingKey {
        case accountKey = "accountKey"
        case accountId = "accountId"
        case accountName = "accountName"
        case assignment = "assignment"
    }
}

public struct PortfolioBrokerRow: Codable, Equatable, Sendable, Identifiable {
    public let date: String
    public let currency: CurrencyCode
    public let accountKey: String
    public let accountId: AccountID?
    public let accountName: String
    public let assignment: PortfolioAssignment
    public let value: Decimal
    public let invested: Decimal
    public let gainLoss: Decimal
    public let computedAt: String
    public var id: String { date + "|" + accountKey }
    enum CodingKeys: String, CodingKey {
        case date = "date"
        case currency = "currency"
        case accountKey = "accountKey"
        case accountId = "accountId"
        case accountName = "accountName"
        case assignment = "assignment"
        case value = "value"
        case invested = "invested"
        case gainLoss = "gainLoss"
        case computedAt = "computedAt"
    }
}

public struct PortfolioBrokerPerformance: Codable, Equatable, Sendable {
    public let currency: CurrencyCode
    public let startDate: String
    public let endDate: String
    public let dates: [String]
    public let series: [PortfolioBrokerSeries]
    public let rows: [PortfolioBrokerRow]
    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case startDate = "startDate"
        case endDate = "endDate"
        case dates = "dates"
        case series = "series"
        case rows = "rows"
    }
}

public struct PortfolioQuote: Codable, Equatable, Sendable, Identifiable {
    public let symbol: String
    public let currency: CurrencyCode
    public let name: String?
    public let price: Decimal?
    public let change: Decimal?
    public let changePercent: Decimal?
    public var id: String { symbol }
    enum CodingKeys: String, CodingKey {
        case symbol = "symbol"
        case currency = "currency"
        case name = "name"
        case price = "price"
        case change = "change"
        case changePercent = "changePercent"
    }
}

public struct PortfolioNewsArticle: Codable, Equatable, Sendable, Identifiable {
    public let title: String?
    public let link: String?
    public let publisher: String?
    public let publishedAt: Decimal?
    public let thumbnail: String?
    public let relatedSymbols: [String]
    public var id: String { (link ?? "") + "|" + (title ?? "") }
    enum CodingKeys: String, CodingKey {
        case title = "title"
        case link = "link"
        case publisher = "publisher"
        case publishedAt = "publishedAt"
        case thumbnail = "thumbnail"
        case relatedSymbols = "relatedSymbols"
    }
}

public struct PortfolioExposureContribution: Codable, Equatable, Sendable {
    public let sourceType: OpenAPI.PortfolioExposureContribution.SourceType
    public let investmentId: InvestmentID
    public let investmentName: String
    public let sourceFundName: String?
    public let amount: Decimal
    public let sourceAsOfDate: String?
    public let stale: Bool
    enum CodingKeys: String, CodingKey {
        case sourceType = "sourceType"
        case investmentId = "investmentId"
        case investmentName = "investmentName"
        case sourceFundName = "sourceFundName"
        case amount = "amount"
        case sourceAsOfDate = "sourceAsOfDate"
        case stale = "stale"
    }
}

public struct PortfolioExposureRow: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let amount: Decimal
    public let weightPercent: Decimal
    public let contributions: [PortfolioExposureContribution]
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case label = "label"
        case amount = "amount"
        case weightPercent = "weightPercent"
        case contributions = "contributions"
    }
}

public struct PortfolioExposureDimension: Codable, Equatable, Sendable {
    public let rows: [PortfolioExposureRow]
    public let classifiedValue: Decimal
    public let classifiedWeightPercent: Decimal
    public let unclassifiedValue: Decimal
    public let unclassifiedWeightPercent: Decimal
    enum CodingKeys: String, CodingKey {
        case rows = "rows"
        case classifiedValue = "classifiedValue"
        case classifiedWeightPercent = "classifiedWeightPercent"
        case unclassifiedValue = "unclassifiedValue"
        case unclassifiedWeightPercent = "unclassifiedWeightPercent"
    }
}

public struct PortfolioExposureFund: Codable, Equatable, Sendable, Identifiable {
    public let investmentId: InvestmentID
    public let investmentName: String
    public let asOfDate: String
    public let evaluatedAt: String
    public let ageDays: Int
    public let maximumAgeDays: Int
    public let stale: Bool
    public let coverageStatus: OpenAPI.PortfolioExposureFundSource.CoverageStatus
    public var id: InvestmentID { investmentId }
    enum CodingKeys: String, CodingKey {
        case investmentId = "investmentId"
        case investmentName = "investmentName"
        case asOfDate = "asOfDate"
        case evaluatedAt = "evaluatedAt"
        case ageDays = "ageDays"
        case maximumAgeDays = "maximumAgeDays"
        case stale = "stale"
        case coverageStatus = "coverageStatus"
    }
}

public struct PortfolioExposureWarning: Codable, Equatable, Sendable {
    public let code: String
    enum CodingKeys: String, CodingKey {
        case code = "code"
    }
}

public struct PortfolioExposureData: Codable, Equatable, Sendable {
    public let currency: CurrencyCode
    public let computedAt: String
    public let totalValue: Decimal
    public let uncoveredValue: Decimal
    public let uncoveredWeightPercent: Decimal
    public let coveredCashValue: Decimal
    public let coveredCashWeightPercent: Decimal
    public let fundSources: [PortfolioExposureFund]
    public let issuer: PortfolioExposureDimension
    public let sector: PortfolioExposureDimension
    public let issuerCountry: PortfolioExposureDimension
    public let warnings: [PortfolioExposureWarning]
    public let scopeNotes: [String]
    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case computedAt = "computedAt"
        case totalValue = "totalValue"
        case uncoveredValue = "uncoveredValue"
        case uncoveredWeightPercent = "uncoveredWeightPercent"
        case coveredCashValue = "coveredCashValue"
        case coveredCashWeightPercent = "coveredCashWeightPercent"
        case fundSources = "fundSources"
        case issuer = "issuer"
        case sector = "sector"
        case issuerCountry = "issuerCountry"
        case warnings = "warnings"
        case scopeNotes = "scopeNotes"
    }
}

public struct PortfolioPriceRefresh: Codable, Equatable, Sendable {
    public let updated: Int
    public let total: Int?
    public let message: String?
    public let prices: [String: Decimal?]?
    public let priceSources: [String: String]?
    public var staleCount: Int {
        priceSources?.values.filter { $0 == "cached" || $0 == "historical_fallback" }.count ?? 0
    }
    enum CodingKeys: String, CodingKey {
        case updated = "updated"
        case total = "total"
        case message = "message"
        case prices = "prices"
        case priceSources = "priceSources"
    }
}

public struct PortfolioPage<Value: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Value]
    public let total: Int
    public let limit: Int?
    public let offset: Int?
}

public enum PortfolioPriceFreshness: Equatable, Sendable {
    case none, notFetched
    case asOf(String)
    public static func aggregate(_ holdings: [PortfolioHolding]) -> Self {
        let live = holdings.filter { $0.isActive && $0.hasLiveProvider }
        guard !live.isEmpty else { return .none }
        var oldest: Date?
        for holding in live {
            guard let text = holding.priceUpdatedAt, let date = timestamp(text) else { return .notFetched }
            if oldest == nil || date < oldest! { oldest = date }
        }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .asOf(format.string(from: oldest!))
    }
    public static func isStale(_ holding: PortfolioHolding, now: Date = Date()) -> Bool {
        guard holding.hasLiveProvider else { return false }
        guard let text = holding.priceUpdatedAt, let date = timestamp(text) else { return true }
        return now.timeIntervalSince(date) > 86_400
    }
    private static func timestamp(_ text: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: text) { return date }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: text)
    }
}

extension KeyedDecodingContainer {
    fileprivate func portfolioDecimal(forKey key: Key) throws -> Decimal {
        guard let value = try portfolioDecimalIfPresent(forKey: key) else {
            throw DecodingError.valueNotFound(
                Decimal.self, .init(codingPath: codingPath + [key], debugDescription: "Required decimal value"))
        }
        return value
    }
    fileprivate func portfolioDecimalIfPresent(forKey key: Key) throws -> Decimal? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        if let value = try? decode(Decimal.self, forKey: key) { return value }
        let text = try decode(String.self, forKey: key)
        guard text.range(of: #"^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$"#, options: .regularExpression) != nil,
            let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")), !value.isNaN
        else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "Expected decimal value")
        }
        return value
    }
}
