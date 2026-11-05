import Foundation

public enum PortfolioWriteValue: Encodable, Equatable, Sendable {
    case null
    case string(String)
    case number(Decimal)
    case bool(Bool)
    case array([Self])
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        }
    }
}
public struct PortfolioEditingPayload: Encodable, Equatable, Sendable {
    public var fields: [String: PortfolioWriteValue]
    public init(_ fields: [String: PortfolioWriteValue] = [:]) { self.fields = fields }
    public func encode(to encoder: any Encoder) throws { try fields.encode(to: encoder) }
}
public struct PortfolioFormIssue: Error, Equatable, Sendable {
    public let field: String
    public let key: String
    public init(_ field: String, _ key: String) {
        self.field = field
        self.key = key
    }
}
public enum PortfolioAssetKinds {
    /// The transaction types that move lots. The server also writes lot types the transaction
    /// type enum does not list (`transfer_in`, `transfer_out`, `asset_fee`, `unit_reversal`); they
    /// are the enum's unrecognized values.
    public static let lotTransactionTypes: Set<OpenAPI.PortfolioTxnType> = [
        .buy, .gift, .sell, .unknown("transfer_in"), .unknown("transfer_out"), .unknown("asset_fee"),
        .unknown("unit_reversal"),
    ]
    public static let all: [OpenAPI.AssetClass] = [.stock, .etf, .crypto, .metals, .realEstate, .savings, .bond]
    public static func unitBased(_ value: OpenAPI.AssetClass) -> Bool {
        switch value {
        case .stock, .etf, .crypto, .metals: true
        case .realEstate, .savings, .bond, .unknown: false
        }
    }
    public static func fixedIncome(_ value: OpenAPI.AssetClass) -> Bool {
        switch value {
        case .savings, .bond: true
        case .stock, .etf, .crypto, .metals, .realEstate, .unknown: false
        }
    }
    public static func defaultProvider(_ value: OpenAPI.AssetClass) -> OpenAPI.PriceProvider {
        switch value {
        case .crypto: .binance
        case .stock, .etf, .metals: .yahoo
        case .realEstate, .savings, .bond, .unknown: .manual
        }
    }
    public static func tradeTypes(_ value: OpenAPI.AssetClass) -> [OpenAPI.PortfolioTxnType] {
        if unitBased(value) { return [.buy, .sell, .gift, .dividend, .fee, .tax] }
        if value == .realEstate { return [.buy, .sell, .rentIncome, .appreciation, .fee, .tax] }
        if fixedIncome(value) { return [.buy, .sell, .interest, .fee, .tax] }
        return [.buy, .sell, .fee, .tax]
    }
}

/// Input derivation only, mirroring portfolioUnitMath.ts and the repository normalizer.
public struct PortfolioUnitInput: Equatable, Sendable {
    public let amount: Decimal?
    public let units: Decimal?
    public let price: Decimal?
    public let providedCount: Int
    public let consistent: Bool
    public init(amount: Decimal?, units: Decimal?, price: Decimal?, derive: Bool = true) {
        providedCount = [amount, units, price].compactMap { $0 }.count
        var a = amount
        var u = units
        var p = price
        if derive && providedCount >= 2 {
            if a == nil, let units, let price { a = Self.round(units * price, places: 4) }
            if u == nil, let amount, let price, price > 0 { u = Self.round(amount / price, places: 8) }
            if p == nil, let amount, let units, units > 0 { p = Self.round(amount / units, places: 6) }
        }
        self.amount = a
        self.units = u
        self.price = p
        if derive, providedCount >= 2, let a, let u, let p {
            consistent =
                Self.round(abs(Self.round(u * p, places: 4) - Self.round(a, places: 4)), places: 4) <= Decimal(
                    string: "0.01")!
        } else {
            consistent = false
        }
    }
    private static func round(_ value: Decimal, places: Int) -> Decimal {
        var input = value
        var result = Decimal.zero
        NSDecimalRound(&result, &input, places, .plain)
        return result
    }
}

public struct PortfolioProviderDraft: Equatable, Sendable {
    public var provider = OpenAPI.PriceProvider.manual
    public var id = ""
    public var legacyUrl = ""
    public var latestUrl = ""
    public var latestPath = ""
    public var historyUrl = ""
    public var historyPath = "points"
    public var historyTimestampPath = "timestamp_ms"
    public var historyPricePath = "price"
    public init() {}
    public init(investment: PortfolioInvestment) {
        provider = investment.priceProvider
        id = investment.priceProviderId ?? ""
        legacyUrl = investment.priceProviderUrl ?? ""
        latestUrl = investment.priceProviderLatestUrl ?? ""
        latestPath = investment.priceProviderLatestPath ?? ""
        historyUrl = investment.priceProviderHistoryUrl ?? ""
        historyPath = investment.priceProviderHistoryPath ?? "points"
        historyTimestampPath = investment.priceProviderHistoryTsPath ?? "timestamp_ms"
        historyPricePath = investment.priceProviderHistoryPricePath ?? "price"
    }
    public mutating func select(_ value: OpenAPI.PriceProvider) {
        provider = value
        id = ""
    }
    public var payload: [String: PortfolioWriteValue] {
        var fields: [String: PortfolioWriteValue] = ["price_provider": .string(provider.rawValue)]
        for (key, value) in [
            ("price_provider_id", id), ("price_provider_url", legacyUrl),
            ("price_provider_latest_url", latestUrl), ("price_provider_latest_path", latestPath),
            ("price_provider_history_url", historyUrl), ("price_provider_history_path", historyPath),
            ("price_provider_history_ts_path", historyTimestampPath),
            ("price_provider_history_price_path", historyPricePath),
        ] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { fields[key] = .string(trimmed) }
        }
        return fields
    }
}

public struct PortfolioInvestmentDraft: Equatable, Sendable {
    public let investmentId: InvestmentID?
    public var allowedAssetClasses: [OpenAPI.AssetClass]
    /// `nil` until the asset type is chosen.
    public var assetClass: OpenAPI.AssetClass?
    /// The user went back to the asset-type step after choosing one (`step === "type"`).
    public var isChoosingType = false
    public var name = ""
    public var symbol = ""
    public var currency: CurrencyCode
    public var currentPrice = ""
    public var interestRate = ""
    public var maturityDate = ""
    public var location = ""
    public var municipality = ""
    public var cadastralIncome = ""
    public var municipalityTaxRate = ""
    public var notes = ""
    public var provider = PortfolioProviderDraft()
    public var addInitialPurchase = true
    public var initialAmount = ""
    public var initialUnits = ""
    public var initialDate: String
    public var initialFees = ""
    public var initialAccountId: AccountID?
    public var brokerWasChosen = false
    public var isEditing: Bool { investmentId != nil }
    public var isUnitBased: Bool { assetClass.map(PortfolioAssetKinds.unitBased) ?? false }
    public var isFixedIncome: Bool { assetClass.map(PortfolioAssetKinds.fixedIncome) ?? false }
    /// Typed text for the form field `field` as the web inputs accept it
    /// (`InvestmentFormFields` `maxLength` and the upper-cased ticker).
    public static func input(_ value: String, field: String) -> String {
        switch field {
        case "symbol": String(value.uppercased().prefix(20))
        case "name": String(value.prefix(100))
        case "location", "municipality": String(value.prefix(200))
        case "notes": String(value.prefix(500))
        default: value
        }
    }
    public init(
        settings: NativeAppSettings, today: String, allowedAssetClasses: [OpenAPI.AssetClass] = PortfolioAssetKinds.all
    ) {
        investmentId = nil
        currency = PortfolioCurrency.reporting(settings)
        initialDate = today
        self.allowedAssetClasses = (allowedAssetClasses.isEmpty ? PortfolioAssetKinds.all : allowedAssetClasses).filter
        { PortfolioAssetKinds.all.contains($0) }
        if self.allowedAssetClasses.count == 1 { selectAssetClass(self.allowedAssetClasses[0]) }
    }
    public init(investment: PortfolioInvestment, settings: NativeAppSettings) {
        investmentId = investment.id
        allowedAssetClasses = [investment.assetClass]
        assetClass = investment.assetClass
        name = investment.name
        symbol = investment.symbol ?? ""
        currency = investment.currency
        // A quote belongs to the raw investment currency. A display-converted summary price
        // cannot be relabelled with that currency in an editor.
        currentPrice = LocaleNumber.editable(investment.currentPrice, format: settings.numberFormat)
        provider = .init(investment: investment)
        initialDate = ""
        addInitialPurchase = false
    }
    public mutating func selectAssetClass(_ value: OpenAPI.AssetClass) {
        guard !isEditing, allowedAssetClasses.contains(value) else { return }
        assetClass = value
        isChoosingType = false
        provider.provider = PortfolioAssetKinds.defaultProvider(value)
    }
    public func payload(format: NumberFormat) throws -> PortfolioEditingPayload {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw PortfolioFormIssue("name", isEditing ? "invEdit.nameRequired" : "addInv.nameRequired")
        }
        guard let assetClass, PortfolioAssetKinds.all.contains(assetClass) else {
            throw PortfolioFormIssue("assetClass", "addInv.chooseTypeDesc")
        }
        if isEditing && PortfolioAssetKinds.unitBased(assetClass)
            && symbol.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            throw PortfolioFormIssue("symbol", "invEdit.symbolRequired")
        }
        var fields = provider.payload
        fields["name"] = .string(trimmed)
        fields["currency"] = .string(currency.rawValue)
        if !isEditing { fields["asset_class"] = .string(assetClass.rawValue) }
        let symbol = symbol.trimmingCharacters(in: .whitespacesAndNewlines)
        if !symbol.isEmpty, !isEditing || PortfolioAssetKinds.unitBased(assetClass) {
            fields["symbol"] = .string(isEditing ? symbol.uppercased() : symbol)
        }
        if provider.provider == .manual, PortfolioAssetKinds.unitBased(assetClass), !currentPrice.isEmpty {
            fields["current_price"] = .number(try Self.numeric(currentPrice, field: "currentPrice", format: format))
        }
        if !isEditing {
            if PortfolioAssetKinds.fixedIncome(assetClass), !interestRate.isEmpty {
                fields["interest_rate"] = .number(try Self.numeric(interestRate, field: "interestRate", format: format))
            }
            if assetClass == .realEstate {
                if !cadastralIncome.isEmpty {
                    fields["cadastral_income"] = .number(
                        try Self.numeric(cadastralIncome, field: "cadastralIncome", format: format))
                }
                if !municipalityTaxRate.isEmpty {
                    fields["municipality_tax_rate"] = .number(
                        try Self.numeric(municipalityTaxRate, field: "municipalityTaxRate", format: format))
                }
            }
            for (key, value) in [
                ("maturity_date", maturityDate), ("location", location), ("municipality", municipality),
                ("notes", notes),
            ] {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { fields[key] = .string(trimmed) }
            }
        }
        return PortfolioEditingPayload(fields)
    }
    public func initialPurchase(format: NumberFormat, defaultBroker: AccountID?) throws -> PortfolioEditingPayload? {
        guard !isEditing, addInitialPurchase else { return nil }
        guard !initialDate.isEmpty else { throw PortfolioFormIssue("initialDate", "addPortTxn.error.dateRequired") }
        guard let amount = PortfolioTradeDraft.positive(initialAmount, format: format) else {
            throw PortfolioFormIssue("initialAmount", "addPortTxn.error.amountRequired")
        }
        let units = PortfolioTradeDraft.positive(initialUnits, format: format)
        if isUnitBased, units == nil {
            throw PortfolioFormIssue("initialUnits", "addPortTxn.error.unitsRequired")
        }
        let math = PortfolioUnitInput(amount: amount, units: units, price: nil, derive: isUnitBased)
        var fields: [String: PortfolioWriteValue] = [
            "type": .string(OpenAPI.PortfolioTxnType.buy.rawValue), "date": .string(initialDate),
            "amount": .number(amount), "currency": .string(currency.rawValue),
        ]
        if let units { fields["units"] = .number(units) }
        if let price = math.price { fields["price_per_unit"] = .number(price) }
        if !initialFees.isEmpty {
            fields["fees"] = .number(try Self.numeric(initialFees, field: "initialFees", format: format))
        }
        if let broker = brokerWasChosen ? initialAccountId : defaultBroker {
            fields["account_id"] = .number(Decimal(broker.rawValue))
        }
        return PortfolioEditingPayload(fields)
    }
    private static func numeric(_ value: String, field: String, format: NumberFormat) throws -> Decimal {
        guard let result = LocaleNumber.parse(value, format: format), !result.isNaN else {
            throw PortfolioFormIssue(field, "addInv.error.numberInvalid")
        }
        return result
    }
}

public struct PortfolioTradeDraft: Equatable, Sendable {
    public let investment: PortfolioInvestment
    public let transactionId: PortfolioTransactionID?
    public var type = OpenAPI.PortfolioTxnType.buy
    public var date: String
    public var amount = ""
    public var units = ""
    public var pricePerUnit = ""
    public var fees = ""
    public var taxes = ""
    public var dividendAmountConvention = OpenAPI.PortfolioTransaction.DividendAmountConvention.unknownValue
    public var fxRateToEur = ""
    public var note = ""
    public var accountId: AccountID?
    public var brokerWasChosen = false
    public var isRecurring = false
    public var recurrenceInterval = OpenAPI.RecurrenceInterval.monthly
    public var recurrenceEndDate = ""
    public let currency: CurrencyCode
    public var isEditing: Bool { transactionId != nil }
    public var isGift: Bool { type == .gift }
    public var isBuySell: Bool {
        PortfolioAssetKinds.unitBased(investment.assetClass) && [.buy, .sell].contains(type)
    }
    public var showUnits: Bool {
        PortfolioAssetKinds.unitBased(investment.assetClass) && [.buy, .sell, .gift].contains(type)
    }
    public var showFeesTaxes: Bool { [.buy, .sell, .dividend].contains(type) }
    public var showRecurring: Bool { [.buy, .sell, .dividend, .interest, .rentIncome].contains(type) }
    public init(investment: PortfolioInvestment, bookingCurrency: CurrencyCode, today: String) {
        self.investment = investment
        transactionId = nil
        currency = bookingCurrency
        date = today
    }
    public init(investment: PortfolioInvestment, transaction: PortfolioTransaction, settings: NativeAppSettings) {
        self.investment = investment
        transactionId = transaction.id
        currency = transaction.currency
        type = transaction.type
        date = String(transaction.date.prefix(10))
        amount = LocaleNumber.editable(transaction.amount, format: settings.numberFormat)
        units = LocaleNumber.editable(transaction.units, format: settings.numberFormat)
        pricePerUnit = LocaleNumber.editable(transaction.pricePerUnit, format: settings.numberFormat)
        fees = LocaleNumber.editable(transaction.fees, format: settings.numberFormat)
        taxes = LocaleNumber.editable(transaction.taxes, format: settings.numberFormat)
        dividendAmountConvention = transaction.dividendAmountConvention
        fxRateToEur = LocaleNumber.editable(transaction.fxRateToEur, format: settings.numberFormat)
        note = transaction.note ?? ""
        accountId = transaction.accountId
        brokerWasChosen = true
        isRecurring = transaction.isRecurring
        recurrenceInterval = transaction.recurrenceInterval ?? .monthly
        recurrenceEndDate = String((transaction.recurrenceEndDate ?? "").prefix(10))
    }
    public func unitInput(format: NumberFormat) -> PortfolioUnitInput {
        let parsedAmount =
            isEditing
            ? LocaleNumber.parse(amount, format: format).flatMap { $0 >= 0 ? $0 : nil }
            : Self.positive(amount, format: format)
        return PortfolioUnitInput(
            amount: parsedAmount, units: Self.positive(units, format: format),
            price: Self.positive(pricePerUnit, format: format), derive: isBuySell || (isEditing && isGift))
    }
    public func payload(format: NumberFormat, defaultBroker: AccountID?) throws -> PortfolioEditingPayload {
        let input = unitInput(format: format)
        if isBuySell && !input.consistent { throw PortfolioFormIssue("units", "addPortTxn.error.twoOfThreeRequired") }
        if !isGift && (input.amount == nil || (isEditing && (input.amount ?? 0) <= 0)) {
            throw PortfolioFormIssue("amount", "addPortTxn.error.amountRequired")
        }
        if isGift && input.units == nil { throw PortfolioFormIssue("units", "addPortTxn.error.unitsRequired") }
        if date.isEmpty { throw PortfolioFormIssue("date", "addPortTxn.error.dateRequired") }
        var fields: [String: PortfolioWriteValue] = ["date": .string(date), "is_recurring": .bool(isRecurring)]
        if !isEditing {
            fields["type"] = .string(type.rawValue)
            fields["currency"] = .string(currency.rawValue)
        }
        let amount = !isEditing && isGift ? Decimal.zero : input.amount
        if let amount { fields["amount"] = .number(amount) }
        if let units = input.units { fields["units"] = .number(units) }
        if let price = input.price { fields["price_per_unit"] = .number(price) }
        for (key, raw) in [("fees", fees), ("taxes", taxes), ("fx_rate_to_eur", fxRateToEur)] {
            if raw.isEmpty {
                if isEditing { fields[key] = key == "fx_rate_to_eur" ? .null : .number(0) }
            } else {
                guard let amount = LocaleNumber.parse(raw, format: format),
                    key == "fx_rate_to_eur" ? amount > 0 : amount >= 0
                else {
                    throw PortfolioFormIssue(
                        key == "fx_rate_to_eur" ? "fxRateToEur" : key, "addPortTxn.error.invalidNumber")
                }
                fields[key] = .number(isGift && key != "fx_rate_to_eur" ? 0 : amount)
            }
        }
        if isGift {
            fields["fees"] = .number(0)
            fields["taxes"] = .number(0)
        }
        fields["dividend_amount_convention"] = .string(
            (type == .dividend ? dividendAmountConvention : .unknownValue).rawValue)
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { fields["note"] = .string(trimmed) } else if isEditing { fields["note"] = .null }
        let broker = brokerWasChosen ? accountId : defaultBroker
        if let broker {
            fields["account_id"] = .number(Decimal(broker.rawValue))
        } else if isEditing {
            fields["account_id"] = .null
        }
        if isRecurring { fields["recurrence_interval"] = .string(recurrenceInterval.rawValue) }
        if isRecurring && !recurrenceEndDate.isEmpty {
            fields["recurrence_end_date"] = .string(recurrenceEndDate)
        } else if isEditing {
            fields["recurrence_end_date"] = .null
        }
        return PortfolioEditingPayload(fields)
    }
    public static func positive(_ text: String, format: NumberFormat) -> Decimal? {
        LocaleNumber.parse(text, format: format).flatMap { $0 > 0 ? $0 : nil }
    }
}
