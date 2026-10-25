import Foundation

/// Parser values retain unknown stored keys while the native editor changes known fields.
public struct PortfolioImportConfig: Codable, Equatable, Sendable {
    public private(set) var payload: TaxValue
    public init() {
        payload = .object([
            "dateColumn": .string(""),
            "typeColumn": .string(""),
            "symbolColumn": .string(""),
            "nameColumn": .string(""),
            "unitsColumn": .string(""),
            "priceColumn": .string(""),
            "amountColumn": .string(""),
            "feesColumn": .string(""),
            "taxesColumn": .string(""),
            "currencyColumn": .string(""),
            "fxRateColumn": .string(""),
            "noteColumn": .string(""),
            "dateFormat": .string("%Y-%m-%d"),
            "separator": .string(","),
            "encoding": .string("utf-8"),
            "defaultAssetClass": .string("stock"),
            "defaultType": .string("buy"),
            "number_format": .string("auto"),
            "skipRows": .number(0), "typeMapping": .object([:]),
        ])
    }
    public init(from decoder: any Decoder) throws {
        let supplied = try TaxValue(from: decoder)
        guard let object = supplied.objectValue else {
            throw PortfolioImportFailure.unverified("Parser config must be an object")
        }
        self.init()
        for (key, value) in object { payload[key] = value }
    }
    public func encode(to encoder: any Encoder) throws { try payload.encode(to: encoder) }
    public mutating func setValue(_ value: TaxValue?, for key: String) { payload[key] = value }
    public var dateColumn: String {
        get { payload["dateColumn"]?.stringValue ?? "" }
        set { payload["dateColumn"] = .string(newValue) }
    }
    public var typeColumn: String {
        get { payload["typeColumn"]?.stringValue ?? "" }
        set { payload["typeColumn"] = .string(newValue) }
    }
    public var symbolColumn: String {
        get { payload["symbolColumn"]?.stringValue ?? "" }
        set { payload["symbolColumn"] = .string(newValue) }
    }
    public var nameColumn: String {
        get { payload["nameColumn"]?.stringValue ?? "" }
        set { payload["nameColumn"] = .string(newValue) }
    }
    public var unitsColumn: String {
        get { payload["unitsColumn"]?.stringValue ?? "" }
        set { payload["unitsColumn"] = .string(newValue) }
    }
    public var priceColumn: String {
        get { payload["priceColumn"]?.stringValue ?? "" }
        set { payload["priceColumn"] = .string(newValue) }
    }
    public var amountColumn: String {
        get { payload["amountColumn"]?.stringValue ?? "" }
        set { payload["amountColumn"] = .string(newValue) }
    }
    public var feesColumn: String {
        get { payload["feesColumn"]?.stringValue ?? "" }
        set { payload["feesColumn"] = .string(newValue) }
    }
    public var taxesColumn: String {
        get { payload["taxesColumn"]?.stringValue ?? "" }
        set { payload["taxesColumn"] = .string(newValue) }
    }
    public var currencyColumn: String {
        get { payload["currencyColumn"]?.stringValue ?? "" }
        set { payload["currencyColumn"] = .string(newValue) }
    }
    public var fxRateColumn: String {
        get { payload["fxRateColumn"]?.stringValue ?? "" }
        set { payload["fxRateColumn"] = .string(newValue) }
    }
    public var noteColumn: String {
        get { payload["noteColumn"]?.stringValue ?? "" }
        set { payload["noteColumn"] = .string(newValue) }
    }
    public var dateFormat: String {
        get { payload["dateFormat"]?.stringValue ?? "" }
        set { payload["dateFormat"] = .string(newValue) }
    }
    public var separator: String {
        get { payload["separator"]?.stringValue ?? "" }
        set { payload["separator"] = .string(newValue) }
    }
    public var encoding: String {
        get { payload["encoding"]?.stringValue ?? "" }
        set { payload["encoding"] = .string(newValue) }
    }
    public var defaultAssetClass: String {
        get { payload["defaultAssetClass"]?.stringValue ?? "" }
        set { payload["defaultAssetClass"] = .string(newValue) }
    }
    public var defaultType: String {
        get { payload["defaultType"]?.stringValue ?? "" }
        set { payload["defaultType"] = .string(newValue) }
    }
    public var format: String? {
        get { payload["format"]?.stringValue }
        set { payload["format"] = newValue.map(TaxValue.string) }
    }
    public var sourceIdColumn: String? {
        get { payload["sourceIdColumn"]?.stringValue }
        set { payload["sourceIdColumn"] = newValue.map(TaxValue.string) }
    }
    public var sourceAccountColumn: String? {
        get { payload["sourceAccountColumn"]?.stringValue }
        set { payload["sourceAccountColumn"] = newValue.map(TaxValue.string) }
    }
    public var yieldBasisPolicy: String? {
        get { payload["yieldBasisPolicy"]?.stringValue }
        set { payload["yieldBasisPolicy"] = newValue.map(TaxValue.string) }
    }
    public var includedSymbols: String? {
        get { payload["includedSymbols"]?.stringValue }
        set { payload["includedSymbols"] = newValue.map(TaxValue.string) }
    }
    public var accountId: Int? {
        get { payload["accountId"]?.importIntValue }
        set { payload["accountId"] = newValue.map { .number(Decimal($0)) } }
    }
    public var transferDestinationAccountId: Int? {
        get { payload["transferDestinationAccountId"]?.importIntValue }
        set { payload["transferDestinationAccountId"] = newValue.map { .number(Decimal($0)) } }
    }
    public var transferOriginAccountId: Int? {
        get { payload["transferOriginAccountId"]?.importIntValue }
        set { payload["transferOriginAccountId"] = newValue.map { .number(Decimal($0)) } }
    }
    public var skipRows: Int {
        get { payload["skipRows"]?.importIntValue ?? 0 }
        set { payload["skipRows"] = .number(Decimal(max(0, newValue))) }
    }
    public var numberFormat: String {
        get { payload["number_format"]?.stringValue ?? "auto" }
        set { payload["number_format"] = .string(newValue) }
    }
    public var typeMapping: [String: String] {
        get { payload["typeMapping"]?.objectValue?.compactMapValues(\.stringValue) ?? [:] }
        set { payload["typeMapping"] = .object(newValue.mapValues(TaxValue.string)) }
    }
    public var hasRequiredMapping: Bool {
        !dateColumn.isEmpty && (!symbolColumn.isEmpty || !nameColumn.isEmpty) && !defaultAssetClass.isEmpty
    }
    public var specializedHintKey: String? {
        switch format {
        case "ibkr_transaction_history": "portfolioImport.ibkrParserHint"
        case "ibkr_funding_history": "portfolioImport.ibkrFundingParserHint"
        case "kinesis_transaction_history": "portfolioImport.kinesisParserHint"
        case "nexo_transaction_history": "portfolioImport.nexoParserHint"
        case "nexo_pro_spot_history": "portfolioImport.nexoProParserHint"
        case "saxo_transaction_history": "portfolioImport.saxoParserHint"
        default: nil
        }
    }
    public var isSpecialized: Bool { specializedHintKey != nil }
    public static func preset(_ source: String) -> Self? {
        var value = Self()
        switch source {
        case "ibkr":
            value.format = "ibkr_transaction_history"
            value.dateColumn = "Date"
            value.typeColumn = "Transaction Type"
            value.symbolColumn = "Symbol"
            value.unitsColumn = "Quantity"
            value.priceColumn = "Price"
            value.amountColumn = "Gross Amount"
            value.feesColumn = "Commission"
            value.currencyColumn = "Price Currency"
            value.fxRateColumn = "Exchange Rate"
            value.noteColumn = "Description"
            value.typeMapping = ["Foreign Tax Withholding": "tax"]
        case "ibkr_funding_history":
            value.format = "ibkr_funding_history"
            value.dateColumn = "Request Date"
            value.typeColumn = "Method"
            value.symbolColumn = "Reference Number"
            value.amountColumn = "Amount"
            value.sourceIdColumn = "Reference Number"
            value.sourceAccountColumn = "Account ID"
            value.noteColumn = "Method"
            value.numberFormat = "decimal_dot"
        case "kinesis":
            value.format = "kinesis_transaction_history"
            value.dateColumn = "DateTime"
            value.typeColumn = "Transaction_Type"
            value.symbolColumn = "Currency_Code"
            value.unitsColumn = "Amount"
            value.priceColumn = "Trade_Price"
            value.amountColumn = "Trade_Value"
            value.feesColumn = "Fee"
            value.currencyColumn = "Trade_Value_Currency"
            value.defaultAssetClass = "crypto"
        case "nexo":
            value.format = "nexo_transaction_history"
            value.dateColumn = "Date / Time (UTC)"
            value.typeColumn = "Type"
            value.symbolColumn = "Output Currency"
            value.unitsColumn = "Output Amount"
            value.amountColumn = "USD Equivalent"
            value.feesColumn = "Fee"
            value.currencyColumn = "Output Currency"
            value.noteColumn = "Details"
            value.dateFormat = "%Y-%m-%d %H:%M:%S"
            value.defaultAssetClass = "crypto"
        case "nexo_pro":
            value.format = "nexo_pro_spot_history"
            value.dateColumn = "timestamp"
            value.typeColumn = "side"
            value.symbolColumn = "pair"
            value.unitsColumn = "filledAmount"
            value.priceColumn = "executedPrice"
            value.feesColumn = "tradingFee"
            value.currencyColumn = "feeCurrency"
            value.dateFormat = "%Y-%m-%d %H:%M:%S"
            value.defaultAssetClass = "crypto"
        case "saxo":
            value.format = "saxo_transaction_history"
            value.dateColumn = "Transactiedatum"
            value.typeColumn = "Acties"
            value.symbolColumn = "Instrumentsymbool"
            value.nameColumn = "Instrument"
            value.unitsColumn = "Acties"
            value.priceColumn = "Acties"
            value.amountColumn = "Boekingsbedrag"
            value.feesColumn = "Totale kosten"
            value.currencyColumn = "Instrumentvaluta"
            value.fxRateColumn = "Omrekeningskoers"
            value.noteColumn = "Opmerking"
        default: return nil
        }
        return value
    }
    public func multipartFields(adapterName: String) throws -> [(String, String)] {
        var fields: [(String, String)] = [("adapter_name", adapterName)]
        if let format { fields.append(("portfolio_format", format)) }
        if let transferDestinationAccountId {
            fields.append(("transfer_destination_account_id", String(transferDestinationAccountId)))
        }
        if let transferOriginAccountId {
            fields.append(("transfer_origin_account_id", String(transferOriginAccountId)))
        }
        if let includedSymbols, !includedSymbols.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fields.append(("included_symbols", includedSymbols))
        }
        if let yieldBasisPolicy { fields.append(("yield_basis_policy", yieldBasisPolicy)) }
        fields += [
            ("date_format", dateFormat), ("separator", separator), ("encoding", encoding),
            ("skip_rows", String(skipRows)), ("number_format", numberFormat),
            ("default_asset_class", defaultAssetClass), ("default_type", defaultType),
            ("type_mapping", String(decoding: try JSONEncoder().encode(typeMapping), as: UTF8.self)),
            ("date_column", dateColumn),
        ]
        for (wire, value) in [
            ("type_column", typeColumn), ("symbol_column", symbolColumn), ("name_column", nameColumn),
            ("units_column", unitsColumn), ("price_column", priceColumn), ("amount_column", amountColumn),
            ("fees_column", feesColumn), ("taxes_column", taxesColumn), ("currency_column", currencyColumn),
            ("fx_rate_column", fxRateColumn), ("note_column", noteColumn), ("source_id_column", sourceIdColumn ?? ""),
            ("source_account_column", sourceAccountColumn ?? ""),
        ] where !value.isEmpty { fields.append((wire, value)) }
        if let accountId { fields += [("is_brokerage", "true"), ("account_id", String(accountId))] }
        return fields
    }
}
