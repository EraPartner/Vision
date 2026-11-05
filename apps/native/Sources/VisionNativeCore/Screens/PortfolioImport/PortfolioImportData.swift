import Foundation

public enum PortfolioImportFailure: Error, LocalizedError, Equatable, Sendable {
    case unverified(String)
    case ambiguous(String)
    public var errorDescription: String? {
        switch self {
        case .unverified(let detail), .ambiguous(let detail): detail
        }
    }
}

extension TaxValue {
    var importIntValue: Int? {
        guard let value = decimalValue, value >= 0, value <= 9_007_199_254_740_991 else { return nil }
        let integer = NSDecimalNumber(decimal: value).intValue
        return Decimal(integer) == value ? integer : nil
    }
}

public struct PortfolioImportFile: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let filename: String
    public let data: Data
    public let contentType: String
    public init(filename: String, data: Data, contentType: String = "application/octet-stream", id: UUID = UUID()) {
        self.id = id
        self.filename = filename
        self.data = data
        self.contentType = contentType
    }
    public static let maximumBytes = 50 * 1024 * 1024
    public static func read(_ url: URL) async -> Self? {
        await Task.detached {
            #if os(macOS)
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            #endif
            guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                size <= maximumBytes, let data = try? Data(contentsOf: url), data.count <= maximumBytes
            else { return nil }
            return Self(filename: url.lastPathComponent, data: data)
        }.value
    }
}

extension IntIdentifier where Tag == PortfolioImportBatchNumericIDTag {
    /// The same batch as the path parameters name it: the paths carry the batch's decimal text.
    public var pathID: PortfolioImportBatchID { PortfolioImportBatchID(String(rawValue)) }
}

/// The statement sources the server detects.
public enum PortfolioImportSource: String, Codable, CaseIterable, Sendable {
    case ibkr, kinesis, nexo, saxo
    case nexoPro = "nexo_pro"
}

public struct PortfolioImportDetected: Codable, Equatable, Sendable {
    public let source: PortfolioImportSource
    public let sourceAccountIdentities: [String]
    /// Only the IBKR funding history carries a preset beside its source.
    public let presetKey: PortfolioImportFormat?
    public init(
        source: PortfolioImportSource, sourceAccountIdentities: [String], presetKey: PortfolioImportFormat? = nil
    ) {
        self.source = source
        self.sourceAccountIdentities = sourceAccountIdentities
        self.presetKey = presetKey
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawSource = try c.decode(String.self, forKey: .source)
        sourceAccountIdentities = try c.decode([String].self, forKey: .sourceAccountIdentities)
        let rawPreset = try c.decodeIfPresent(String.self, forKey: .presetKey)
        guard let detectedSource = PortfolioImportSource(rawValue: rawSource),
            rawPreset == nil || rawPreset == PortfolioImportFormat.ibkrFundingHistory.rawValue
        else { throw PortfolioImportFailure.unverified("Unsupported detected portfolio source") }
        source = detectedSource
        presetKey = rawPreset.flatMap(PortfolioImportFormat.init(rawValue:))
    }
    enum Keys: String, CodingKey { case source, sourceAccountIdentities, presetKey }
    public func resolveAccount(_ accounts: [OpenAPI.Account]) -> AccountID? {
        let eligible = portfolioImportBrokerAccounts(accounts)
        let clean: (String) -> String = { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        let identities = Set(sourceAccountIdentities.map { $0.lowercased() })
        guard identities.count <= 1 else { return nil }
        let exact = eligible.filter {
            identities.contains(clean($0.name)) || $0.displayName.map { identities.contains(clean($0)) } == true
        }
        if !exact.isEmpty { return exact.count == 1 ? exact.first?.id : nil }
        let aliases: [PortfolioImportSource: [String]] = [
            .ibkr: ["ibkr", "interactive brokers"], .kinesis: ["kinesis", "kinesis money"], .nexo: ["nexo"],
            .nexoPro: ["nexo pro", "nexo"], .saxo: ["saxo", "saxo bank"],
        ]
        let matches = eligible.filter {
            (aliases[source] ?? []).contains(clean($0.name))
                || $0.institution.map { (aliases[source] ?? []).contains(clean($0)) } == true
        }
        return matches.count == 1 ? matches.first?.id : nil
    }
}

public func portfolioImportBrokerAccounts(_ accounts: [OpenAPI.Account]) -> [OpenAPI.Account] {
    accounts.filter { $0.isActive && [.brokerage, .cryptoExchange, .wallet].contains($0.type) }
}

public struct PortfolioImportParser: Codable, Equatable, Sendable, Identifiable {
    public let id: PortfolioParserConfigID
    public let name: String
    public let kind: String
    public let config: PortfolioImportConfig
    public let createdAt: String
    public let updatedAt: String
    enum CodingKeys: String, CodingKey {
        case id, name, kind, config
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct PortfolioImportPreviewRow: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let rowIndex: Int
    public let status: String
    public let route: String?
    public let txDate: String?
    public let type: OpenAPI.PortfolioTxnType?
    public let typeRaw: String?
    public let symbolRaw: String?
    public let nameRaw: String?
    public let units: String?
    public let pricePerUnit: String?
    public let amount: String?
    public let fees: String?
    public let taxes: String?
    public let currency: String?
    public let fxRateToEur: String?
    public let note: String?
    public let matchSource: String?
    public let errorMessage: String?
    public let userOverrideInvestmentId: InvestmentID?
    public var isHoldingResolvable: Bool {
        status == "matched" || (status == "error" && errorMessage == "unresolved instrument — pick or create a holding")
    }
    enum CodingKeys: String, CodingKey {
        case id, status, route, type, units, amount, fees, taxes, currency, note
        case rowIndex = "row_index"
        case txDate = "tx_date"
        case typeRaw = "type_raw"
        case symbolRaw = "symbol_raw"
        case nameRaw = "name_raw"
        case pricePerUnit = "price_per_unit"
        case fxRateToEur = "fx_rate_to_eur"
        case matchSource = "match_source"
        case errorMessage = "error_message"
        case userOverrideInvestmentId = "user_override_investment_id"
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let nullable: [CodingKeys] = [
            .route, .txDate, .type, .typeRaw, .symbolRaw, .nameRaw, .units, .pricePerUnit, .amount, .fees, .taxes,
            .currency, .fxRateToEur, .note, .matchSource, .errorMessage, .userOverrideInvestmentId,
        ]
        guard nullable.allSatisfy(c.contains) else {
            throw PortfolioImportFailure.unverified("Incomplete portfolio preview row")
        }
        id = try c.decode(String.self, forKey: .id)
        rowIndex = try c.decode(Int.self, forKey: .rowIndex)
        status = try c.decode(String.self, forKey: .status)
        route = try c.decodeIfPresent(String.self, forKey: .route)
        txDate = try c.decodeIfPresent(String.self, forKey: .txDate)
        type = try c.decodeIfPresent(OpenAPI.PortfolioTxnType.self, forKey: .type)
        typeRaw = try c.decodeIfPresent(String.self, forKey: .typeRaw)
        symbolRaw = try c.decodeIfPresent(String.self, forKey: .symbolRaw)
        nameRaw = try c.decodeIfPresent(String.self, forKey: .nameRaw)
        units = try c.decodeIfPresent(String.self, forKey: .units)
        pricePerUnit = try c.decodeIfPresent(String.self, forKey: .pricePerUnit)
        amount = try c.decodeIfPresent(String.self, forKey: .amount)
        fees = try c.decodeIfPresent(String.self, forKey: .fees)
        taxes = try c.decodeIfPresent(String.self, forKey: .taxes)
        currency = try c.decodeIfPresent(String.self, forKey: .currency)
        fxRateToEur = try c.decodeIfPresent(String.self, forKey: .fxRateToEur)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        matchSource = try c.decodeIfPresent(String.self, forKey: .matchSource)
        errorMessage = try c.decodeIfPresent(String.self, forKey: .errorMessage)
        userOverrideInvestmentId = try c.decodeIfPresent(InvestmentID.self, forKey: .userOverrideInvestmentId)
    }
}

public struct PortfolioImportPreviewGroup: Decodable, Equatable, Sendable, Identifiable {
    public let isCash: Bool
    public let investmentId: InvestmentID?
    public let investmentName: String?
    public let investmentSymbol: String?
    public let investmentAssetClass: OpenAPI.AssetClass?
    public let rawSymbol: String?
    public let rawName: String?
    public let rowCount: Int
    public let rows: [PortfolioImportPreviewRow]
    public var id: String { investmentId.map { "inv:\($0)" } ?? "raw:\((rawSymbol ?? rawName ?? "?").lowercased())" }
    public var resolvableRowIds: [String] { isCash ? [] : rows.filter(\.isHoldingResolvable).map(\.id) }
    enum CodingKeys: String, CodingKey {
        case rows
        case isCash = "is_cash"
        case investmentId = "investment_id"
        case investmentName = "investment_name"
        case investmentSymbol = "investment_symbol"
        case investmentAssetClass = "investment_asset_class"
        case rawSymbol = "raw_symbol"
        case rawName = "raw_name"
        case rowCount = "row_count"
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard
            [CodingKeys.investmentId, .investmentName, .investmentSymbol, .investmentAssetClass, .rawSymbol, .rawName]
                .allSatisfy(c.contains)
        else { throw PortfolioImportFailure.unverified("Incomplete portfolio preview group") }
        isCash = try c.decode(Bool.self, forKey: .isCash)
        investmentId = try c.decodeIfPresent(InvestmentID.self, forKey: .investmentId)
        investmentName = try c.decodeIfPresent(String.self, forKey: .investmentName)
        investmentSymbol = try c.decodeIfPresent(String.self, forKey: .investmentSymbol)
        investmentAssetClass = try c.decodeIfPresent(OpenAPI.AssetClass.self, forKey: .investmentAssetClass)
        rawSymbol = try c.decodeIfPresent(String.self, forKey: .rawSymbol)
        rawName = try c.decodeIfPresent(String.self, forKey: .rawName)
        rowCount = try c.decode(Int.self, forKey: .rowCount)
        rows = try c.decode([PortfolioImportPreviewRow].self, forKey: .rows)
    }
}

public struct PortfolioImportPreview: Decodable, Equatable, Sendable {
    public let batchId: PortfolioImportBatchNumericID
    public let accountId: AccountID?
    public let accountName: String?
    public let accountValid: Bool
    public let groups: [PortfolioImportPreviewGroup]
    public let totals: [String: Int]
    public var requiresAccountRepair: Bool {
        (accountId != nil && !accountValid)
            || groups.contains {
                $0.isCash
                    && $0.rows.contains {
                        $0.status == "error" && $0.errorMessage == "brokerage cash row requires a batch account"
                    }
            }
    }
    enum CodingKeys: String, CodingKey {
        case groups, totals
        case batchId = "batch_id"
        case accountId = "account_id"
        case accountName = "account_name"
        case accountValid = "account_valid"
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.accountId), c.contains(.accountName) else {
            throw PortfolioImportFailure.unverified("Incomplete portfolio account routing evidence")
        }
        batchId = try c.decode(PortfolioImportBatchNumericID.self, forKey: .batchId)
        accountId = try c.decodeIfPresent(AccountID.self, forKey: .accountId)
        accountName = try c.decodeIfPresent(String.self, forKey: .accountName)
        accountValid = try c.decode(Bool.self, forKey: .accountValid)
        groups = try c.decode([PortfolioImportPreviewGroup].self, forKey: .groups)
        totals = try c.decode([String: Int].self, forKey: .totals)
    }
    public func validate(batchId: PortfolioImportBatchNumericID) throws {
        let ids = groups.flatMap(\.rows).map(\.id)
        guard self.batchId == batchId, batchId.rawValue > 0, batchId.rawValue <= 9_007_199_254_740_991,
            ["symbol", "name_exact", "unresolved", "error"].allSatisfy({ totals[$0] != nil }),
            totals.values.allSatisfy({ $0 >= 0 }), groups.allSatisfy({ $0.rowCount >= 0 }), Set(ids).count == ids.count
        else { throw PortfolioImportFailure.unverified("Unverified portfolio preview") }
        for row in groups.flatMap(\.rows) {
            guard row.id.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil, row.rowIndex >= 0 else {
                throw PortfolioImportFailure.unverified("Invalid preview row identity")
            }
            for amount in [row.units, row.pricePerUnit, row.amount, row.fees, row.taxes, row.fxRateToEur].compactMap({
                $0
            }) {
                guard amount.range(of: "^-?[0-9]+(?:\\.[0-9]+)?$", options: .regularExpression) != nil else {
                    throw PortfolioImportFailure.unverified("Invalid preview decimal string")
                }
            }
        }
    }
}

public struct PortfolioImportCommitResult: Decodable, Equatable, Sendable {
    public let batchId: PortfolioImportBatchNumericID
    public let total: Int
    public let imported: Int
    public let duplicates: Int
    public let errors: Int
    enum CodingKeys: String, CodingKey {
        case total, imported, duplicates, errors
        case batchId = "batch_id"
    }
}

public struct PortfolioImportOutcome: Decodable, Equatable, Sendable {
    public let batchId: PortfolioImportBatchNumericID
    public let total: Int?
    public let skipped: Int?
    public let imported: Int
    public let duplicates: Int
    public let errors: Int
    public let status: String?
    public let requiresReview: Bool
    enum CodingKeys: String, CodingKey {
        case total, skipped, imported, duplicates, errors, status
        case batchId = "batch_id"
        case requiresReview = "requires_review"
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        batchId = try c.decode(PortfolioImportBatchNumericID.self, forKey: .batchId)
        requiresReview = try c.decodeIfPresent(Bool.self, forKey: .requiresReview) ?? false
        total = try c.decodeIfPresent(Int.self, forKey: .total)
        skipped = try c.decodeIfPresent(Int.self, forKey: .skipped)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        imported = try c.decodeIfPresent(Int.self, forKey: .imported) ?? (requiresReview ? 0 : -1)
        duplicates = try c.decodeIfPresent(Int.self, forKey: .duplicates) ?? (requiresReview ? 0 : -1)
        errors = try c.decodeIfPresent(Int.self, forKey: .errors) ?? (requiresReview ? 0 : -1)
        guard batchId.rawValue > 0, batchId.rawValue <= 9_007_199_254_740_991,
            [imported, duplicates, errors].allSatisfy({ $0 >= 0 }),
            skipped.map({ $0 >= 0 }) ?? true,
            total.map({ $0 >= 0 }) ?? true
        else { throw PortfolioImportFailure.unverified("Invalid portfolio import outcome") }
    }
}

public struct PortfolioImportProbe: Decodable, Equatable, Sendable {
    public let detected: PortfolioImportDetected?
    public let detectionError: String?
    public let preview: Preview?
    public let previewError: String?
    public let separator: String
    public struct Preview: Decodable, Equatable, Sendable {
        public let headers: [String]
        public let rows: [[String]]
    }
}

public struct PortfolioImportBatch: Decodable, Equatable, Sendable, Identifiable {
    public let id: PortfolioImportBatchNumericID
    public let adapterName: String
    public let sourceFilename: String?
    public let accountId: AccountID?
    public let status: OpenAPI.PortfolioImportBatch.Status
    public let rowsTotal: Int
    public let rowsError: Int
    public let customConfig: TaxValue?
    public var canRollback: Bool { [.complete, .completeWithErrors].contains(status) }
    public init(from decoder: any Decoder) throws {
        let value = try TaxValue(from: decoder)
        func id(_ raw: TaxValue?) -> Int? {
            if let integer = raw?.importIntValue, integer > 0 { return integer }
            if let string = raw?.stringValue, string.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
                let integer = Int(string), integer <= 9_007_199_254_740_991
            {
                return integer
            }
            return nil
        }
        guard let batchId = id(value["id"]), let adapter = value["adapter_name"]?.stringValue,
            let rawStatus = value["status"]?.stringValue,
            let rowsTotal = value["rows_total"]?.importIntValue, let rowsError = value["rows_error"]?.importIntValue
        else { throw PortfolioImportFailure.unverified("Unverified portfolio batch") }
        let status = OpenAPI.PortfolioImportBatch.Status(rawValue: rawStatus)
        if case .unknown = status { throw PortfolioImportFailure.unverified("Unverified portfolio batch") }
        let rawAccount = value["account_id"]
        guard rawAccount == nil || rawAccount == .null || id(rawAccount) != nil else {
            throw PortfolioImportFailure.unverified("Invalid portfolio batch account")
        }
        self.id = PortfolioImportBatchNumericID(batchId)
        adapterName = adapter
        sourceFilename = value["source_filename"]?.stringValue
        accountId = id(rawAccount).map { AccountID($0) }
        self.status = status
        self.rowsTotal = rowsTotal
        self.rowsError = rowsError
        customConfig = value["custom_config"]
    }
}

public struct PortfolioImportBatchPage: Decodable, Equatable, Sendable {
    public let items: [PortfolioImportBatch]
    public let total: Int
    public let limit: Int
    public let offset: Int
    public func validate(limit: Int, offset: Int) throws {
        guard (1...200).contains(limit), offset >= 0, self.limit == limit, self.offset == offset, total >= 0,
            items.count <= limit, Set(items.map(\.id)).count == items.count
        else { throw PortfolioImportFailure.unverified("Unverified portfolio batch response") }
    }
}
