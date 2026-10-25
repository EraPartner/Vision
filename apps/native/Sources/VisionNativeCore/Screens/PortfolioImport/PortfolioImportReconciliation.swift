import Foundation

/// The reviewed-session contract of ADR-236 and ADR-239: a statement scope, optional per-statement
/// policies and the owner's per-row answers. The server rebuilds the plan at commit time, so the
/// request carries no plan fingerprint and no reconciliation scope (both were removed with #339).
public enum PortfolioImportReconciliationPolicy: String, Codable, CaseIterable, Sendable {
    case preserveExisting = "preserve_existing"
    case preferSource = "prefer_source"
}
public struct PortfolioImportReconciliationBatchPolicy: Codable, Equatable, Sendable {
    public let batchId: Int
    public let adoptPolicy: PortfolioImportReconciliationPolicy
    public init(batchId: Int, adoptPolicy: PortfolioImportReconciliationPolicy) {
        self.batchId = batchId
        self.adoptPolicy = adoptPolicy
    }
}
/// The owner's answer for a row that resembles a transaction the account already holds: record it
/// as a new transaction (`keepBoth`), or settle it as that one (`sameTransaction`).
public struct PortfolioImportRowChoice: Codable, Equatable, Sendable {
    public enum Choice: String, Codable, CaseIterable, Sendable {
        case keepBoth = "keep_both"
        case sameTransaction = "same_transaction"
    }
    public let batchId: Int
    public let rowId: Int
    public let choice: Choice
    public init(batchId: Int, rowId: Int, choice: Choice) {
        self.batchId = batchId
        self.rowId = rowId
        self.choice = choice
    }
    /// The order in which the server echoes `rowChoices`: by batch, then row.
    static func ordered(_ left: Self, _ right: Self) -> Bool {
        left.batchId == right.batchId ? left.rowId < right.rowId : left.batchId < right.batchId
    }
}
public struct PortfolioImportReconciliationScope: Equatable, Sendable {
    public var batchIds: [Int]
    public var adoptPolicy: PortfolioImportReconciliationPolicy?
    public var batchPolicies: [PortfolioImportReconciliationBatchPolicy]
    public var rowChoices: [PortfolioImportRowChoice]
    public init(
        batchIds: [Int], adoptPolicy: PortfolioImportReconciliationPolicy? = nil,
        batchPolicies: [PortfolioImportReconciliationBatchPolicy] = [], rowChoices: [PortfolioImportRowChoice] = []
    ) {
        self.batchIds = batchIds
        self.adoptPolicy = adoptPolicy
        self.batchPolicies = batchPolicies
        self.rowChoices = rowChoices
    }
    public var sortedBatchPolicies: [PortfolioImportReconciliationBatchPolicy] {
        batchPolicies.sorted { $0.batchId < $1.batchId }
    }
    public var sortedRowChoices: [PortfolioImportRowChoice] { rowChoices.sorted(by: PortfolioImportRowChoice.ordered) }
    /// The shared preview and commit body. Optional parts are omitted when empty, like the web client.
    public func request() throws -> OpenAPI.PortfolioImportReconciliationRequest {
        let safe = ImportProof.safeInteger
        guard (1...100).contains(batchIds.count), batchIds.allSatisfy({ $0 > 0 && Decimal($0) <= safe }),
            batchPolicies.count <= 100, Set(batchPolicies.map(\.batchId)).count == batchPolicies.count,
            batchPolicies.allSatisfy({ batchIds.contains($0.batchId) }), rowChoices.count <= 10_000,
            Set(rowChoices.map { "\($0.batchId):\($0.rowId)" }).count == rowChoices.count,
            rowChoices.allSatisfy({
                $0.batchId > 0 && $0.rowId > 0 && Decimal($0.batchId) <= safe && Decimal($0.rowId) <= safe
                    && batchIds.contains($0.batchId)
            })
        else { throw APIError.invalidRequest("Invalid selected statements, statement policies or row choices") }
        let policies = sortedBatchPolicies.map {
            OpenAPI.PortfolioImportReconciliationRequest.BatchPoliciesItem(
                batchId: $0.batchId, adoptPolicy: $0.adoptPolicy.rawValue)
        }
        let choices = rowChoices.map {
            OpenAPI.PortfolioImportReconciliationRequest.RowChoicesItem(
                batchId: $0.batchId, rowId: $0.rowId, choice: $0.choice.rawValue)
        }
        return OpenAPI.PortfolioImportReconciliationRequest(
            batchIds: batchIds, adoptPolicy: adoptPolicy?.rawValue, batchPolicies: policies.isEmpty ? nil : policies,
            rowChoices: choices.isEmpty ? nil : choices)
    }
}

/// One reviewed outcome per staged row. `source`, `existing`, `adjustment` and `transfer` stay
/// dynamic values because the server adds fields per action kind.
public struct PortfolioImportReconciliationAction: Decodable, Equatable, Sendable, Identifiable {
    public let batchId: Int
    public let rowId: Int
    public let rowOrdinal: Int
    public let action: String
    public let investmentId: Int?
    public let policy: String?
    public let existingTransactionId: Int?
    public let source: TaxValue?
    public let existing: TaxValue?
    public let corrections: [String]?
    public let adjustment: TaxValue?
    public let transfer: TaxValue?
    public let economicsProven: Bool?
    /// Settled against another export of the same broker history or a manual cash entry.
    public let crossFormat: Bool?
    /// The existing transaction is brokerage cash, not a portfolio transaction.
    public let cash: Bool?
    /// For `duplicate_source`, the selected staged row that records the same event.
    public let duplicateOfRowId: Int?
    public var id: String { "\(batchId):\(rowId)" }
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        batchId = try ImportProof.integer(raw["batchId"], positive: true)
        rowId = try ImportProof.integer(raw["rowId"], positive: true)
        rowOrdinal = try ImportProof.integer(raw["rowOrdinal"], positive: true)
        action = try ImportProof.string(raw["action"])
        investmentId = try ImportProof.optionalInteger(raw["investmentId"], nullable: true)
        existingTransactionId = try ImportProof.optionalInteger(raw["existingTransactionId"])
        duplicateOfRowId = try ImportProof.optionalInteger(raw["duplicateOfRowId"])
        economicsProven = try ImportProof.optionalBool(raw["economicsProven"])
        crossFormat = try ImportProof.optionalBool(raw["crossFormat"])
        cash = try ImportProof.optionalBool(raw["cash"])
        policy = try ImportProof.nullableString(raw["policy"])
        if let policy { try ImportProof.require(["exact", "preserve_existing", "prefer_source"].contains(policy)) }
        source = raw["source"]
        existing = raw["existing"]
        for value in [source, existing].compactMap({ $0 }) { try ImportProof.values(value) }
        corrections = try ImportProof.optionalStrings(raw["corrections"])
        adjustment = raw["adjustment"]
        transfer = raw["transfer"]
        if let adjustment { try ImportProof.adjustment(adjustment) }
        if let transfer { try ImportProof.transfer(transfer) }
        if action == "adopt" { try ImportProof.require(existingTransactionId != nil) }
        if action == "adjustment" { try ImportProof.require(adjustment != nil) }
    }
}
public struct PortfolioImportReconciliationBlocker: Decodable, Equatable, Sendable {
    public let batchId: Int
    public let rowId: Int?
    public let rowOrdinal: Int?
    public let reason: String
    public let candidateTransactionIds: [Decimal]
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        batchId = try ImportProof.integer(raw["batchId"], positive: true)
        rowId = try ImportProof.optionalInteger(raw["rowId"])
        rowOrdinal = try ImportProof.optionalInteger(raw["rowOrdinal"])
        reason = try ImportProof.string(raw["reason"])
        guard let values = raw["candidateTransactionIds"]?.arrayValue else { throw ImportProof.failure() }
        candidateTransactionIds = try values.map {
            guard let result = $0.decimalValue else { throw ImportProof.failure() }
            return result
        }
    }
}
public struct PortfolioImportReconciliationPlan: Decodable, Equatable, Sendable {
    public let batchIds: [Int]
    public let adoptPolicy: PortfolioImportReconciliationPolicy?
    public let batchPolicies: [PortfolioImportReconciliationBatchPolicy]
    public let rowChoices: [PortfolioImportRowChoice]
    public let ready: Bool
    public let actions: [PortfolioImportReconciliationAction]
    public let blockers: [PortfolioImportReconciliationBlocker]
    public let summary: [String: Int]
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        batchIds = try ImportProof.integers(raw["batchIds"], positive: true)
        adoptPolicy = try ImportProof.policy(raw["adoptPolicy"], nullable: true)
        let policies = try (raw["batchPolicies"] ?? .array([])).decode([PortfolioImportReconciliationBatchPolicy].self)
        let choices = try (raw["rowChoices"] ?? .array([])).decode([PortfolioImportRowChoice].self)
        let safe = ImportProof.safeInteger
        try ImportProof.require(
            policies.count <= 100 && policies.allSatisfy { $0.batchId > 0 && Decimal($0.batchId) <= safe }
                && choices.allSatisfy {
                    $0.batchId > 0 && $0.rowId > 0 && Decimal($0.batchId) <= safe && Decimal($0.rowId) <= safe
                })
        batchPolicies = policies
        rowChoices = choices
        ready = try ImportProof.bool(raw["ready"])
        guard let actionRows = raw["actions"]?.arrayValue, let blockerRows = raw["blockers"]?.arrayValue else {
            throw ImportProof.failure()
        }
        actions = try actionRows.map { try $0.decode(PortfolioImportReconciliationAction.self) }
        blockers = try blockerRows.map { try $0.decode(PortfolioImportReconciliationBlocker.self) }
        summary = try ImportProof.counts(raw["summary"])
    }
    /// A plan that does not echo exactly the submitted scope is not a review of that scope.
    public func validate(scope: PortfolioImportReconciliationScope) throws {
        _ = try scope.request()
        try ImportProof.require(
            batchIds.sorted() == scope.batchIds.sorted() && adoptPolicy == scope.adoptPolicy
                && batchPolicies == scope.sortedBatchPolicies && rowChoices == scope.sortedRowChoices
                && actions.allSatisfy { scope.batchIds.contains($0.batchId) }
                && blockers.allSatisfy { scope.batchIds.contains($0.batchId) })
    }
}
/// Aggregate and per-batch counts of a committed session. `imported`, `duplicates` and `adopted`
/// are disjoint; `errors` is zero on success.
public struct PortfolioImportReconciliationResult: Decodable, Equatable, Sendable {
    public struct Batch: Decodable, Equatable, Sendable {
        public let batchId: Int
        public let imported: Int
        public let duplicates: Int
        public let adopted: Int
        public let errors: Int
        public init(from decoder: any Decoder) throws {
            let raw = try TaxValue(from: decoder)
            try ImportProof.object(raw)
            batchId = try ImportProof.integer(raw["batch_id"], positive: true)
            imported = try ImportProof.integer(raw["imported"])
            duplicates = try ImportProof.integer(raw["duplicates"])
            adopted = try ImportProof.integer(raw["adopted"])
            errors = try ImportProof.integer(raw["errors"])
        }
    }
    public let batches: [Batch]
    public let imported: Int
    public let duplicates: Int
    public let adopted: Int
    public let errors: Int
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        guard let rows = raw["batches"]?.arrayValue else { throw ImportProof.failure() }
        batches = try rows.map { try $0.decode(Batch.self) }
        imported = try ImportProof.integer(raw["imported"])
        duplicates = try ImportProof.integer(raw["duplicates"])
        adopted = try ImportProof.integer(raw["adopted"])
        errors = try ImportProof.integer(raw["errors"])
    }
    public func validate(scope: PortfolioImportReconciliationScope) throws {
        _ = try scope.request()
        try ImportProof.require(
            errors == 0 && batches.allSatisfy { $0.errors == 0 }
                && imported == batches.reduce(0) { $0 + $1.imported }
                && duplicates == batches.reduce(0) { $0 + $1.duplicates }
                && adopted == batches.reduce(0) { $0 + $1.adopted }
                && batches.map(\.batchId).sorted() == scope.batchIds.sorted())
    }
}

/// These checks verify the server's evidence and scope; they do not derive financial facts.
private enum ImportProof {
    static let safeInteger = Decimal(9_007_199_254_740_991)
    static func failure() -> APIError {
        .contract(
            .init(endpoint: "/api/portfolio/import/reconciliation", issues: ["Unverified portfolio import response"]))
    }
    static func require(_ value: @autoclosure () throws -> Bool) throws { if try !value() { throw failure() } }
    static func object(_ value: TaxValue) throws { try require(value.objectValue != nil) }
    static func string(_ value: TaxValue?) throws -> String {
        guard let result = value?.stringValue else { throw failure() }
        return result
    }
    static func optionalString(_ value: TaxValue?) throws -> String? {
        guard let value else { return nil }
        return try string(value)
    }
    static func nullableString(_ value: TaxValue?) throws -> String? {
        guard let value, value != .null else { return nil }
        return try string(value)
    }
    static func bool(_ value: TaxValue?) throws -> Bool {
        guard let result = value?.boolValue else { throw failure() }
        return result
    }
    static func optionalBool(_ value: TaxValue?) throws -> Bool? {
        guard let value else { return nil }
        return try bool(value)
    }
    /// A whole number from 0 (or 1 when `positive`) up to the largest safe integer.
    static func integer(_ value: TaxValue?, positive: Bool = false) throws -> Int {
        guard let number = value?.decimalValue, !number.isNaN, number >= (positive ? 1 : 0), number <= safeInteger
        else { throw failure() }
        let result = NSDecimalNumber(decimal: number).intValue
        try require(Decimal(result) == number)
        return result
    }
    static func optionalInteger(_ value: TaxValue?, positive: Bool = true, nullable: Bool = false) throws -> Int? {
        guard let value else { return nil }
        if nullable && value == .null { return nil }
        return try integer(value, positive: positive)
    }
    static func integers(_ value: TaxValue?, positive: Bool) throws -> [Int] {
        guard let rows = value?.arrayValue else { throw failure() }
        return try rows.map { try integer($0, positive: positive) }
    }
    static func optionalStrings(_ value: TaxValue?) throws -> [String]? {
        guard let value else { return nil }
        guard let rows = value.arrayValue else { throw failure() }
        return try rows.map { try string($0) }
    }
    static func counts(_ value: TaxValue?) throws -> [String: Int] {
        guard let fields = value?.objectValue else { throw failure() }
        return try fields.mapValues { try integer($0) }
    }
    static func policy(_ value: TaxValue?, nullable: Bool = false) throws -> PortfolioImportReconciliationPolicy? {
        if nullable && value == .null { return nil }
        guard let result = PortfolioImportReconciliationPolicy(rawValue: try string(value)) else { throw failure() }
        return result
    }
    /// Source and existing values: strings, numbers or null, with the two closed vocabularies.
    static func values(_ raw: TaxValue) throws {
        guard let fields = raw.objectValue else { throw failure() }
        try require(
            fields.values.allSatisfy { value in
                switch value {
                case .null, .number, .string: true
                default: false
                }
            })
        if let role = fields["income_recognition_role"], role != .null {
            try require(
                ["standard", "included_in_units"].contains(role.stringValue ?? "")
                    && (role != .string("included_in_units") || fields["type"] == .string("dividend")))
        }
        if let convention = fields["dividend_amount_convention"], convention != .null {
            try require(["gross", "net", "unknown"].contains(convention.stringValue ?? ""))
        }
    }
    static func adjustment(_ raw: TaxValue) throws {
        try object(raw)
        _ = try string(raw["date"])
        _ = try string(raw["units"])
        _ = try integer(raw["accountId"], positive: true)
        try require(
            ["yield_reversal", "asset_fee"].contains(raw["kind"]?.stringValue ?? "")
                && ["zero_yield_only", "carried"].contains(raw["basisPolicy"]?.stringValue ?? ""))
    }
    static func transfer(_ raw: TaxValue) throws {
        try object(raw)
        for field in ["date", "units", "feeUnits", "receivedUnits"] { _ = try string(raw[field]) }
        for field in ["sourceAccountId", "destinationAccountId"] { _ = try integer(raw[field], positive: true) }
    }
}
