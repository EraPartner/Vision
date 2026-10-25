import Foundation

public enum PortfolioImportReconciliationMode: String, CaseIterable, Codable, Sendable {
    case full
    case adoptExistingOnly = "adopt_existing_only"
    case correctExistingOnly = "correct_existing_only"
    case recordInKindIncomeOnly = "record_in_kind_income_only"
    case recordCashOnly = "record_cash_only"
}
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
public struct PortfolioImportReconciliationScope: Equatable, Sendable {
    public var batchIds: [Int]
    public var adoptPolicy: PortfolioImportReconciliationPolicy?
    public var batchPolicies: [PortfolioImportReconciliationBatchPolicy]
    public var reconciliationScope: PortfolioImportReconciliationMode
    public var cashFundingPolicy: String?
    public init(
        batchIds: [Int], adoptPolicy: PortfolioImportReconciliationPolicy? = nil,
        batchPolicies: [PortfolioImportReconciliationBatchPolicy] = [],
        reconciliationScope: PortfolioImportReconciliationMode = .full, cashFundingPolicy: String? = nil
    ) {
        self.batchIds = batchIds
        self.adoptPolicy = adoptPolicy
        self.batchPolicies = batchPolicies
        self.reconciliationScope = reconciliationScope
        self.cashFundingPolicy = cashFundingPolicy
    }
    public func requestBody() throws -> TaxValue {
        guard (1...100).contains(batchIds.count),
            batchIds.allSatisfy({ $0 > 0 && Decimal($0) <= ImportProof.safeInteger }),
            batchPolicies.count <= 100, Set(batchPolicies.map(\.batchId)).count == batchPolicies.count,
            batchPolicies.allSatisfy({ batchIds.contains($0.batchId) })
        else { throw APIError.invalidRequest("Invalid selected statements or statement policies") }
        let overrides = batchPolicies.sorted { $0.batchId < $1.batchId }
        switch reconciliationScope {
        case .adoptExistingOnly:
            guard
                batchIds.allSatisfy({ id in
                    (overrides.first { $0.batchId == id }?.adoptPolicy ?? adoptPolicy) == .preserveExisting
                })
            else { throw APIError.invalidRequest("Source attachment requires preserving existing facts") }
        case .correctExistingOnly:
            guard adoptPolicy == .preferSource, overrides.allSatisfy({ $0.adoptPolicy == .preferSource }) else {
                throw APIError.invalidRequest("Existing corrections require explicit source facts")
            }
        case .recordInKindIncomeOnly, .recordCashOnly:
            guard adoptPolicy == .preserveExisting, overrides.allSatisfy({ $0.adoptPolicy == .preserveExisting }) else {
                throw APIError.invalidRequest("Recording requires preserving existing facts")
            }
        case .full: break
        }
        if reconciliationScope == .recordCashOnly {
            guard cashFundingPolicy == "own_account_transfer" else {
                throw APIError.invalidRequest("Cash recording requires confirmed own-account funding")
            }
        } else if cashFundingPolicy != nil {
            throw APIError.invalidRequest("Cash funding confirmation requires the cash-only scope")
        }
        var body: [String: TaxValue] = ["batch_ids": .array(batchIds.map { .number(Decimal($0)) })]
        if reconciliationScope != .full { body["reconciliation_scope"] = .string(reconciliationScope.rawValue) }
        if let adoptPolicy { body["adopt_policy"] = .string(adoptPolicy.rawValue) }
        if let cashFundingPolicy { body["cash_funding_policy"] = .string(cashFundingPolicy) }
        if !overrides.isEmpty {
            body["batch_policies"] = .array(
                overrides.map {
                    .object([
                        "batch_id": .number(Decimal($0.batchId)), "adopt_policy": .string($0.adoptPolicy.rawValue),
                    ])
                })
        }
        return .object(body)
    }
}

public struct PortfolioImportReconciliationAction: Decodable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let batchId: Int
    public let rowId: Int
    public let rowOrdinal: Int
    public let action: String
    public let investmentId: Int?
    public let isCash: Bool?
    public let policy: String?
    public let existingTransactionId: Int?
    public let importedTransactionId: Int?
    public let originalBatchId: Int?
    public let existingCashFeeTransactionId: Int?
    public let source: TaxValue?
    public let existing: TaxValue?
    public let importedExisting: TaxValue?
    public let corrections: [String]?
    public let adjustment: TaxValue?
    public let transfer: TaxValue?
    public let cashValues: TaxValue?
    public let cashFeeValues: TaxValue?
    public let cashProof: TaxValue?
    public let incomeProof: TaxValue?
    public let dateProof: TaxValue?
    public let economicsProven: Bool?
    public var id: String { "\(batchId):\(rowId)" }
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        self.raw = raw
        batchId = try ImportProof.integer(raw["batchId"], positive: true)
        rowId = try ImportProof.integer(raw["rowId"], positive: true)
        rowOrdinal = try ImportProof.integer(raw["rowOrdinal"], positive: true)
        action = try ImportProof.string(raw["action"])
        investmentId = try ImportProof.optionalInteger(raw["investmentId"], nullable: true, safe: true)
        existingTransactionId = try ImportProof.optionalInteger(raw["existingTransactionId"], safe: true)
        importedTransactionId = try ImportProof.optionalInteger(raw["importedTransactionId"], safe: true)
        originalBatchId = try ImportProof.optionalInteger(raw["originalBatchId"], safe: true)
        existingCashFeeTransactionId = try ImportProof.optionalInteger(raw["existingCashFeeTransactionId"], safe: true)
        isCash = try ImportProof.optionalBool(raw["isCash"])
        economicsProven = try ImportProof.optionalBool(raw["economicsProven"])
        policy = try ImportProof.optionalString(raw["policy"])
        if let policy { try ImportProof.require(["exact", "preserve_existing", "prefer_source"].contains(policy)) }
        source = raw["source"]
        existing = raw["existing"]
        importedExisting = raw["importedExisting"]
        for value in [source, existing, importedExisting].compactMap({ $0 }) { try ImportProof.values(value) }
        corrections = try ImportProof.optionalStrings(raw["corrections"])
        adjustment = raw["adjustment"]
        transfer = raw["transfer"]
        cashValues = raw["cashValues"]
        cashFeeValues = raw["cashFeeValues"]
        cashProof = raw["cashProof"]
        incomeProof = raw["incomeProof"]
        dateProof = raw["dateProof"]
        if let adjustment { try ImportProof.adjustment(adjustment) }
        if let transfer { try ImportProof.transfer(transfer) }
        for value in [cashValues, cashFeeValues].compactMap({ $0 }) { try ImportProof.cashValues(value) }
        if let cashProof { try ImportProof.cashProof(cashProof) }
        if let incomeProof { try ImportProof.incomeProof(incomeProof) }
        if let dateProof { try ImportProof.dateProof(dateProof) }
        if isCash == true && action == "adopt" {
            try ImportProof.require(
                investmentId == nil && policy == "prefer_source" && existingTransactionId != nil
                    && !(corrections ?? []).isEmpty
                    && (corrections ?? []).allSatisfy { ["amount", "currency"].contains($0) }
                    && source?["date"] == existing?["date"])
            for value in [source, existing] {
                try ImportProof.require(
                    value != nil && ImportProof.date(value?["date"]?.stringValue)
                        && ImportProof.currency(value?["currency"]?.stringValue)
                        && ImportProof.nonemptyNumber(value?["amount"]) != nil
                        && ImportProof.nonemptyNumber(value?["amount"]) != 0)
            }
        }
        if action == "repair_duplicate" {
            try ImportProof.require(
                existingTransactionId != nil && importedTransactionId != nil && originalBatchId != nil && source != nil
                    && existing != nil && importedExisting != nil && existingTransactionId != importedTransactionId)
        }
        if action == "adjustment" { try ImportProof.require(adjustment != nil) }
    }
}
public struct PortfolioImportReconciliationBlocker: Decodable, Equatable, Sendable {
    public let batchId: Int
    public let rowId: Int?
    public let rowOrdinal: Int?
    public let referenceTransactionId: String?
    public let reason: String
    public let candidateTransactionIds: [Decimal]
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        batchId = try ImportProof.integer(raw["batchId"], positive: true)
        rowId = try ImportProof.optionalInteger(raw["rowId"])
        rowOrdinal = try ImportProof.optionalInteger(raw["rowOrdinal"])
        reason = try ImportProof.string(raw["reason"])
        referenceTransactionId = try ImportProof.optionalString(raw["referenceTransactionId"])
        if let referenceTransactionId { try ImportProof.require(ImportProof.uuid(referenceTransactionId)) }
        guard let values = raw["candidateTransactionIds"]?.arrayValue else { throw ImportProof.failure() }
        candidateTransactionIds = try values.map {
            guard let result = $0.decimalValue else { throw ImportProof.failure() }
            return result
        }
    }
}
public struct PortfolioImportReconciliationPlan: Decodable, Equatable, Sendable {
    public let raw: TaxValue
    public let reconciliationScope: PortfolioImportReconciliationMode?
    public let pending: Int?
    public let complete: Bool?
    public let deferredCounts: [String: Int]?
    public let selectedRowIds: [Int]?
    public let batchIds: [Int]
    public let adoptPolicy: PortfolioImportReconciliationPolicy?
    public let batchPolicies: [PortfolioImportReconciliationBatchPolicy]
    public let planFingerprint: String
    public let ready: Bool
    public let actions: [PortfolioImportReconciliationAction]
    public let blockers: [PortfolioImportReconciliationBlocker]
    public let summary: [String: Int]
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        try ImportProof.object(raw)
        self.raw = raw
        reconciliationScope = try ImportProof.mode(raw)
        pending = try ImportProof.optionalInteger(raw["pending"], positive: false)
        complete = try ImportProof.optionalBool(raw["complete"])
        deferredCounts = try ImportProof.optionalCounts(raw["deferredCounts"])
        selectedRowIds = try ImportProof.selectedIds(raw["selectedRowIds"])
        batchIds = try ImportProof.integers(raw["batchIds"], positive: true)
        adoptPolicy = try ImportProof.policy(raw["adoptPolicy"], nullable: true)
        batchPolicies = try (raw["batchPolicies"] ?? .array([])).decode([PortfolioImportReconciliationBatchPolicy].self)
        try ImportProof.require(
            batchPolicies.count <= 100
                && batchPolicies.allSatisfy { $0.batchId > 0 && Decimal($0.batchId) <= ImportProof.safeInteger })
        planFingerprint = try ImportProof.string(raw["planFingerprint"])
        try ImportProof.require(!planFingerprint.isEmpty)
        ready = try ImportProof.bool(raw["ready"])
        guard let actionRows = raw["actions"]?.arrayValue, let blockerRows = raw["blockers"]?.arrayValue else {
            throw ImportProof.failure()
        }
        actions = try actionRows.map { try $0.decode(PortfolioImportReconciliationAction.self) }
        blockers = try blockerRows.map { try $0.decode(PortfolioImportReconciliationBlocker.self) }
        summary = try ImportProof.counts(raw["summary"])
    }
    public func validate(scope: PortfolioImportReconciliationScope) throws {
        _ = try scope.requestBody()
        try ImportProof.metadata(raw, mode: scope.reconciliationScope)
        try ImportProof.require(
            batchIds.sorted() == scope.batchIds.sorted() && adoptPolicy == scope.adoptPolicy
                && batchPolicies == scope.batchPolicies.sorted { $0.batchId < $1.batchId })
        try ImportProof.require(
            actions.allSatisfy { scope.batchIds.contains($0.batchId) }
                && blockers.allSatisfy { scope.batchIds.contains($0.batchId) })
        if actions.contains(where: { $0.dateProof != nil }) {
            try ImportProof.require(scope.reconciliationScope == .correctExistingOnly)
            try ImportProof.dateGroups(actions)
        }
        let income = actions.contains { $0.incomeProof != nil || $0.action == "record_income" }
        if income { try ImportProof.require([.full, .recordInKindIncomeOnly].contains(scope.reconciliationScope)) }
        if [.full, .recordInKindIncomeOnly].contains(scope.reconciliationScope) {
            try ImportProof.incomeActions(actions, full: scope.reconciliationScope == .full)
        }
        let cash = actions.filter {
            $0.cashProof != nil || $0.cashValues != nil || $0.cashFeeValues != nil
                || $0.existingCashFeeTransactionId != nil
        }
        if !cash.isEmpty {
            if scope.reconciliationScope == .full {
                try ImportProof.cashActions(cash)
                try ImportProof.require(
                    cash.allSatisfy { $0.cashProof == nil || ["duplicate", "settled"].contains($0.action) })
            } else {
                try ImportProof.require(scope.reconciliationScope == .recordCashOnly)
            }
        }
        if scope.reconciliationScope == .recordCashOnly { try ImportProof.cashActions(actions) }
        if scope.reconciliationScope != .full {
            try ImportProof.require(selectedRowIds != nil && selectedRowIds!.sorted() == actions.map(\.rowId).sorted())
            let allowed =
                scope.reconciliationScope == .recordInKindIncomeOnly
                ? ["record_income", "duplicate", "settled"]
                : (scope.reconciliationScope == .recordCashOnly
                    ? ["cash", "duplicate", "settled"] : ["adopt", "duplicate", "settled"])
            for action in actions {
                try ImportProof.require(allowed.contains(action.action))
                if [.adoptExistingOnly, .recordInKindIncomeOnly, .recordCashOnly].contains(scope.reconciliationScope) {
                    try ImportProof.require(action.policy != "prefer_source")
                }
                if scope.reconciliationScope == .correctExistingOnly && action.action == "adopt" {
                    try ImportProof.require(
                        action.policy == "prefer_source" && action.existingTransactionId != nil
                            && !(action.corrections ?? []).isEmpty)
                    if action.dateProof != nil {
                        try ImportProof.require(ImportProof.dateCorrection(action))
                    } else {
                        try ImportProof.require(
                            action.source?["date"] == action.existing?["date"]
                                && (action.corrections ?? []).allSatisfy {
                                    ["amount", "price_per_unit", "fees", "taxes", "currency", "fx_rate_to_eur"]
                                        .contains($0)
                                })
                    }
                }
            }
            for (kind, count) in summary {
                try ImportProof.require(count == actions.filter { $0.action == kind }.count)
            }
            try ImportProof.require(actions.allSatisfy { summary[$0.action] != nil })
        }
    }
}
public struct PortfolioImportReconciliationResult: Decodable, Equatable, Sendable {
    public let raw: TaxValue
    public let reconciliationScope: PortfolioImportReconciliationMode?
    public let pending: Int?
    public let complete: Bool?
    public let deferredCounts: [String: Int]?
    public let selectedRowIds: [Int]?
    public let batches: [Batch]
    public let imported: Int
    public let duplicates: Int
    public let adopted: Int
    public let repaired: Int
    public let errors: Int
    public let recordedIncome: Int?
    public let recordedCash: Int?
    public struct Batch: Decodable, Equatable, Sendable {
        public let raw: TaxValue
        public let batchId: Int
        public let imported: Int
        public let duplicates: Int
        public let adopted: Int
        public let repaired: Int
        public let errors: Int
        public let recordedIncome: Int?
        public let recordedCash: Int?
        public let pending: Int?
        public init(from decoder: any Decoder) throws {
            raw = try TaxValue(from: decoder)
            try ImportProof.resultCounts(raw)
            batchId = try ImportProof.integer(raw["batch_id"], positive: true)
            imported = try ImportProof.integer(raw["imported"])
            duplicates = try ImportProof.integer(raw["duplicates"])
            adopted = try ImportProof.integer(raw["adopted"])
            repaired = try ImportProof.integer(raw["repaired"])
            errors = try ImportProof.integer(raw["errors"])
            recordedIncome = try ImportProof.optionalInteger(raw["recordedIncome"], positive: false)
            recordedCash = try ImportProof.optionalInteger(raw["recordedCash"], positive: false)
            pending = try ImportProof.optionalInteger(raw["pending"], positive: false)
        }
    }
    public init(from decoder: any Decoder) throws {
        raw = try TaxValue(from: decoder)
        try ImportProof.resultCounts(raw)
        reconciliationScope = try ImportProof.mode(raw)
        pending = try ImportProof.optionalInteger(raw["pending"], positive: false)
        complete = try ImportProof.optionalBool(raw["complete"])
        deferredCounts = try ImportProof.optionalCounts(raw["deferredCounts"])
        selectedRowIds = try ImportProof.selectedIds(raw["selectedRowIds"])
        guard let rows = raw["batches"]?.arrayValue else { throw ImportProof.failure() }
        batches = try rows.map { try $0.decode(Batch.self) }
        imported = try ImportProof.integer(raw["imported"])
        duplicates = try ImportProof.integer(raw["duplicates"])
        adopted = try ImportProof.integer(raw["adopted"])
        repaired = try ImportProof.integer(raw["repaired"])
        errors = try ImportProof.integer(raw["errors"])
        recordedIncome = try ImportProof.optionalInteger(raw["recordedIncome"], positive: false)
        recordedCash = try ImportProof.optionalInteger(raw["recordedCash"], positive: false)
    }
    public func validate(scope: PortfolioImportReconciliationScope) throws {
        _ = try scope.requestBody()
        try ImportProof.metadata(raw, mode: scope.reconciliationScope)
        for batch in batches { try ImportProof.metadata(batch.raw, mode: scope.reconciliationScope) }
        try ImportProof.require(
            batches.map(\.batchId).sorted() == scope.batchIds.sorted() && errors == 0
                && batches.allSatisfy {
                    $0.errors == 0 && Decimal($0.duplicates) >= Decimal($0.adopted) + Decimal($0.repaired)
                })
        for key in ["imported", "duplicates", "adopted", "repaired"] {
            try ImportProof.require(
                ImportProof.sum(batches.map { $0.raw[key]!.decimalValue! }) == raw[key]?.decimalValue)
        }
        for key in ["recordedIncome", "recordedCash"] {
            if let count = raw[key] {
                try ImportProof.require(
                    batches.allSatisfy { $0.raw[key] != nil }
                        && ImportProof.sum(batches.map { $0.raw[key]!.decimalValue! }) == count.decimalValue)
            } else {
                try ImportProof.require(batches.allSatisfy { $0.raw[key] == nil })
            }
        }
        try ImportProof.require(
            Decimal(recordedIncome ?? 0) + Decimal(recordedCash ?? 0) <= Decimal(imported)
                && batches.allSatisfy {
                    Decimal($0.recordedIncome ?? 0) + Decimal($0.recordedCash ?? 0) <= Decimal($0.imported)
                })
        if let pending {
            try ImportProof.require(
                batches.allSatisfy { $0.pending != nil }
                    && ImportProof.sum(batches.map { Decimal($0.pending!) }) == Decimal(pending))
        }
        if scope.reconciliationScope != .full {
            try ImportProof.require(
                selectedRowIds != nil && repaired == 0
                    && ([.recordInKindIncomeOnly, .recordCashOnly].contains(scope.reconciliationScope) || imported == 0)
            )
        }
        if scope.reconciliationScope == .recordInKindIncomeOnly {
            try ImportProof.require(
                recordedIncome != nil && imported == recordedIncome && adopted == 0
                    && batches.allSatisfy {
                        $0.recordedIncome != nil && $0.recordedIncome == $0.imported && $0.adopted == 0
                            && $0.repaired == 0
                    })
        }
        if scope.reconciliationScope == .recordCashOnly {
            try ImportProof.require(
                recordedCash != nil && imported == recordedCash && adopted == 0 && (recordedIncome ?? 0) == 0
                    && batches.allSatisfy {
                        $0.recordedCash != nil && $0.recordedCash == $0.imported && $0.adopted == 0 && $0.repaired == 0
                            && ($0.recordedIncome ?? 0) == 0
                    })
        }
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
    static func bool(_ value: TaxValue?) throws -> Bool {
        guard let result = value?.boolValue else { throw failure() }
        return result
    }
    static func optionalBool(_ value: TaxValue?) throws -> Bool? {
        guard let value else { return nil }
        return try bool(value)
    }
    static func integer(_ value: TaxValue?, positive: Bool = false, safe _: Bool = false) throws -> Int {
        guard let number = value?.decimalValue, !number.isNaN, number >= (positive ? 1 : 0), number <= safeInteger
        else { throw failure() }
        let result = NSDecimalNumber(decimal: number).intValue
        try require(Decimal(result) == number)
        return result
    }
    static func optionalInteger(_ value: TaxValue?, positive: Bool = true, nullable: Bool = false, safe: Bool = false)
        throws -> Int?
    {
        guard let value else { return nil }
        if nullable && value == .null { return nil }
        return try integer(value, positive: positive, safe: safe)
    }
    static func integers(_ value: TaxValue?, positive: Bool, safe: Bool = false) throws -> [Int] {
        guard let rows = value?.arrayValue else { throw failure() }
        return try rows.map { try integer($0, positive: positive, safe: safe) }
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
    static func optionalCounts(_ value: TaxValue?) throws -> [String: Int]? {
        guard let value else { return nil }
        return try counts(value)
    }
    static func selectedIds(_ value: TaxValue?) throws -> [Int]? {
        guard let value else { return nil }
        let ids = try integers(value, positive: true, safe: true)
        try require(Set(ids).count == ids.count)
        return ids
    }
    static func mode(_ raw: TaxValue) throws -> PortfolioImportReconciliationMode? {
        guard let value = raw["reconciliationScope"] else { return nil }
        guard let result = PortfolioImportReconciliationMode(rawValue: try string(value)) else { throw failure() }
        return result
    }
    static func policy(_ value: TaxValue?, nullable: Bool = false) throws -> PortfolioImportReconciliationPolicy? {
        if nullable && value == .null { return nil }
        guard let result = PortfolioImportReconciliationPolicy(rawValue: try string(value)) else { throw failure() }
        return result
    }
    static func sum(_ values: [Decimal]) -> Decimal { values.reduce(0, +) }
    static func metadata(_ raw: TaxValue, mode expected: PortfolioImportReconciliationMode) throws {
        try require((try mode(raw) ?? .full) == expected)
        let pending = try optionalInteger(raw["pending"], positive: false)
        let complete = try optionalBool(raw["complete"])
        let deferred = try optionalCounts(raw["deferredCounts"])
        if expected != .full || pending != nil || complete != nil || deferred != nil {
            try require(pending != nil && complete != nil && deferred != nil)
        }
        if let pending, let complete { try require(complete == (pending == 0)) }
        if let pending, let deferred { try require(sum(deferred.values.map { Decimal($0) }) == Decimal(pending)) }
    }
    static func resultCounts(_ value: TaxValue) throws {
        try object(value)
        _ = try mode(value)
        _ = try optionalInteger(value["pending"], positive: false)
        _ = try optionalBool(value["complete"])
        _ = try optionalCounts(value["deferredCounts"])
        _ = try selectedIds(value["selectedRowIds"])
        for field in ["imported", "duplicates", "adopted", "repaired", "errors"] { _ = try integer(value[field]) }
        for field in ["recordedIncome", "recordedCash"] { _ = try optionalInteger(value[field], positive: false) }
    }
    static func matches(_ value: String?, _ pattern: String) -> Bool {
        value?.range(of: pattern, options: .regularExpression) != nil
    }
    static func uuid(_ value: String) -> Bool {
        let text = value.lowercased()
        return text == "00000000-0000-0000-0000-000000000000" || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            || matches(text, #"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"#)
    }
    static func nonnull(_ first: TaxValue?, _ fallback: TaxValue?) -> TaxValue? {
        first == nil || first == .null ? fallback : first
    }
    static func truthy(_ value: TaxValue?) -> Bool {
        switch value {
        case .string(let text): !text.isEmpty
        case .number(let number): number != 0
        case .bool(let value): value
        case .null, nil: false
        default: true
        }
    }
    static func currency(_ value: String?) -> Bool { matches(value, #"^[A-Z]{3}$"#) }
    static func date(_ value: String?) -> Bool {
        guard let value, matches(value, #"^\d{4}-\d{2}-\d{2}$"#) else { return false }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]), parts[2] >= 1 else { return false }
        let maxDay =
            parts[1] == 2
            ? (parts[0] % 4 == 0 && (parts[0] % 100 != 0 || parts[0] % 400 == 0) ? 29 : 28)
            : ([4, 6, 9, 11].contains(parts[1]) ? 30 : 31)
        return parts[2] <= maxDay
    }
    static func number(_ value: TaxValue?) -> Decimal? {
        guard let value else { return nil }
        switch value {
        case .number(let result): return result.isNaN ? nil : result
        case .null: return 0
        case .string(let raw):
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { return 0 }
            if matches(text, #"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$"#) {
                return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")).flatMap { $0.isNaN ? nil : $0 }
            }
            for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
                if text.lowercased().hasPrefix(prefix), let parsed = UInt64(String(text.dropFirst(2)), radix: radix) {
                    return Decimal(parsed)
                }
            }
            return nil
        default: return nil
        }
    }
    static func nonemptyNumber(_ value: TaxValue?) -> Decimal? {
        guard let value, value != .null else { return nil }
        if case .string(let text) = value, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return number(value)
    }
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
    static func strict(_ raw: TaxValue, required: Set<String>, optional: Set<String> = []) throws {
        guard let fields = raw.objectValue else { throw failure() }
        let keys = Set(fields.keys)
        try require(required.isSubset(of: keys) && keys.isSubset(of: required.union(optional)))
    }
    static func cashValues(_ raw: TaxValue) throws {
        try strict(
            raw,
            required: ["date", "amount", "currency", "accountId", "isTransfer", "transferSource", "transferPeerId"])
        try require(
            date(raw["date"]?.stringValue) && matches(raw["amount"]?.stringValue, #"^-?\d+(?:\.\d+)?$"#)
                && currency(raw["currency"]?.stringValue) && raw["transferSource"] == .string("brokerage")
                && raw["transferPeerId"] == .null)
        _ = try integer(raw["accountId"], positive: true, safe: true)
        _ = try bool(raw["isTransfer"])
    }
    static func cashProof(_ raw: TaxValue) throws {
        try strict(
            raw, required: ["kind", "groupKey", "eventKey", "eventKind", "fileHash", "memberCount", "componentCount"])
        try require(
            raw["kind"] == .string("closed_kinesis_cash")
                && ["trade_quote", "own_account_funding", "card_expense"].contains(raw["eventKind"]?.stringValue ?? ""))
        for field in ["groupKey", "eventKey", "fileHash"] {
            try require(matches(raw[field]?.stringValue, #"^[a-f0-9]{64}$"#))
        }
        _ = try integer(raw["memberCount"], positive: true, safe: true)
        try require([1, 2].contains(try integer(raw["componentCount"])))
    }
    static func incomeProof(_ raw: TaxValue) throws {
        try strict(raw, required: ["kind"], optional: ["unitRowId", "unitTransactionId"])
        try require(raw["kind"] == .string("paired_kinesis_income"))
        _ = try optionalInteger(raw["unitRowId"], safe: true)
        _ = try optionalInteger(raw["unitTransactionId"], safe: true)
    }
    static func dateProof(_ raw: TaxValue) throws {
        try strict(raw, required: ["kind", "groupKey", "recordedDate", "paymentDate", "memberCount"])
        try require(
            raw["kind"] == .string("closed_kinesis_yield_group")
                && matches(raw["groupKey"]?.stringValue, #"^[a-f0-9]{64}$"#) && date(raw["recordedDate"]?.stringValue)
                && date(raw["paymentDate"]?.stringValue))
        _ = try integer(raw["memberCount"], positive: true)
    }
    static func adjustment(_ raw: TaxValue) throws {
        try object(raw)
        _ = try string(raw["date"])
        _ = try string(raw["units"])
        _ = try integer(raw["accountId"], positive: true, safe: true)
        try require(
            ["yield_reversal", "asset_fee"].contains(raw["kind"]?.stringValue ?? "")
                && ["zero_yield_only", "carried"].contains(raw["basisPolicy"]?.stringValue ?? ""))
    }
    static func transfer(_ raw: TaxValue) throws {
        try object(raw)
        for field in ["date", "units", "feeUnits", "receivedUnits"] { _ = try string(raw[field]) }
        for field in ["sourceAccountId", "destinationAccountId"] { _ = try integer(raw[field], positive: true) }
    }
    static func dateCorrection(_ action: PortfolioImportReconciliationAction) -> Bool {
        guard let proof = action.dateProof, let source = action.source, let existing = action.existing else {
            return false
        }
        return action.corrections == ["date"] && proof["recordedDate"] != proof["paymentDate"]
            && existing["date"] == proof["recordedDate"] && source["date"] == proof["paymentDate"]
            && existing["type"] == .string("gift")
            && ["amount", "price_per_unit", "fees", "taxes"].allSatisfy {
                existing[$0] == nil || existing[$0] == .null || number(existing[$0]) == 0
            }
            && [
                "type", "units", "amount", "price_per_unit", "fees", "taxes", "currency", "fx_rate_to_eur",
                "dividend_amount_convention",
            ].allSatisfy { source[$0] == existing[$0] }
    }
    static func dateGroups(_ actions: [PortfolioImportReconciliationAction]) throws {
        var groups: [String: (date: TaxValue?, count: Int, ids: Set<Int>)] = [:]
        var existingIds: Set<Int> = []
        for action in actions {
            guard let proof = action.dateProof else { continue }
            let key = try string(proof["groupKey"])
            let count = try integer(proof["memberCount"], positive: true)
            guard action.action == "adopt", let id = action.existingTransactionId, !existingIds.contains(id),
                dateCorrection(action)
            else { throw failure() }
            var group = groups[key] ?? (proof["paymentDate"], count, [])
            try require(group.date == proof["paymentDate"] && group.count == count && !group.ids.contains(id))
            group.ids.insert(id)
            try require(group.ids.count <= count)
            existingIds.insert(id)
            groups[key] = group
        }
    }
    static func incomeActions(_ actions: [PortfolioImportReconciliationAction], full: Bool) throws {
        let incomes = full ? actions.filter { $0.incomeProof != nil || $0.action == "record_income" } : actions
        var unitIds: Set<Int> = []
        var rowIds: Set<Int> = []
        var incomeIds: Set<Int> = []
        for action in incomes {
            guard let proof = action.incomeProof else { throw failure() }
            try require(
                ["record_income", "duplicate", "settled"].contains(action.action) && action.dateProof == nil
                    && (action.corrections ?? []).isEmpty && action.cashProof == nil && action.cashValues == nil
                    && action.cashFeeValues == nil && action.transfer == nil && action.adjustment == nil
                    && action.policy != "prefer_source")
            let unitId = try optionalInteger(proof["unitTransactionId"], safe: true)
            if let unitId {
                try require(!unitIds.contains(unitId))
                unitIds.insert(unitId)
            }
            if full {
                let rowId = try integer(proof["unitRowId"], positive: true, safe: true)
                try require(!rowIds.contains(rowId))
                rowIds.insert(rowId)
                let units = actions.filter { $0.rowId == rowId }
                guard units.count == 1, let unit = units.first else { throw failure() }
                try require(
                    unit.id != action.id && unit.batchId == action.batchId
                        && ["insert", "adopt", "duplicate", "settled"].contains(unit.action) && unit.incomeProof == nil
                        && unit.cashProof == nil && (unit.source == nil || unit.source?["type"] == .string("gift"))
                        && (unit.existing == nil || unit.existing?["type"] == .string("gift"))
                        && unit.investmentId != nil && action.investmentId == unit.investmentId)
                let unitDate = nonnull(unit.source?["date"], unit.existing?["date"])
                let incomeDate = nonnull(action.source?["date"], action.existing?["date"])
                if unitDate != nil && unitDate != .null && incomeDate != nil && incomeDate != .null {
                    try require(unitDate == incomeDate)
                }
                if let source = unit.source {
                    try require(
                        ["amount", "price_per_unit", "fees", "taxes"].allSatisfy {
                            number(source[$0] ?? .number(0)) == 0
                        }
                            && (source["income_recognition_role"] == nil || source["income_recognition_role"] == .null
                                || source["income_recognition_role"] == .string("standard"))
                    )
                }
                if unit.action == "insert" {
                    try require(
                        action.action == "record_income" && unitId == nil && unit.source?["type"] == .string("gift")
                            && (number(unit.source?["units"]) ?? 0) > 0)
                } else {
                    try require(unitId != nil && unit.existingTransactionId == unitId)
                }
            } else {
                try require(unitId != nil && proof["unitRowId"] == nil)
            }
            if action.action == "record_income" {
                guard let source = action.source, let amount = nonemptyNumber(source["amount"]) else { throw failure() }
                try require(
                    action.existingTransactionId == nil && source["type"] == .string("dividend")
                        && source["income_recognition_role"] == .string("included_in_units") && source["units"] == .null
                        && source["price_per_unit"] == .null
                        && (source["fx_rate_to_eur"] == nil || source["fx_rate_to_eur"] == .null) && amount >= 0
                        && date(source["date"]?.stringValue) && truthy(source["currency"])
                        && ["fees", "taxes"].allSatisfy { number(source[$0] ?? .number(0)) == 0 })
            } else {
                guard let id = action.existingTransactionId else { throw failure() }
                try require(
                    id != unitId && !incomeIds.contains(id)
                        && (action.source == nil || action.source?["type"] == .string("dividend"))
                        && (action.existing == nil
                            || (action.existing?["type"] == .string("dividend")
                                && (action.existing?["income_recognition_role"] == nil
                                    || action.existing?["income_recognition_role"] == .null
                                    || action.existing?["income_recognition_role"] == .string("included_in_units"))))
                )
                incomeIds.insert(id)
            }
        }
        try require(unitIds.isDisjoint(with: incomeIds))
    }
    static func cashActions(_ actions: [PortfolioImportReconciliationAction]) throws {
        var groups: [String: (batch: Int, file: String, members: Int, count: Int)] = [:]
        var events: Set<String> = []
        var existingIds: Set<Int> = []
        for action in actions {
            guard let proof = action.cashProof else { throw failure() }
            try require(
                ["cash", "duplicate", "settled"].contains(action.action) && action.incomeProof == nil
                    && action.dateProof == nil && action.transfer == nil && action.adjustment == nil
                    && action.source == nil && action.existing == nil && action.importedExisting == nil
                    && (action.corrections ?? []).isEmpty && action.importedTransactionId == nil
                    && action.originalBatchId == nil && action.policy != "prefer_source")
            let event = try string(proof["eventKey"])
            try require(!events.contains(event))
            events.insert(event)
            let components = try integer(proof["componentCount"])
            let values = action.cashValues
            let fee = action.cashFeeValues
            if action.action == "cash" {
                try require(
                    values != nil && action.existingTransactionId == nil && action.existingCashFeeTransactionId == nil)
            } else {
                guard let id = action.existingTransactionId else { throw failure() }
                try require(!existingIds.contains(id))
                existingIds.insert(id)
                if components == 2 {
                    guard let id = action.existingCashFeeTransactionId else { throw failure() }
                    try require(!existingIds.contains(id))
                    existingIds.insert(id)
                }
            }
            if components == 1 { try require(fee == nil && action.existingCashFeeTransactionId == nil) }
            if components == 2 {
                try require(proof["eventKind"] == .string("own_account_funding") && (values != nil) == (fee != nil))
                if let values, let fee {
                    try require(
                        (number(values["amount"]) ?? 0) < 0 && (number(fee["amount"]) ?? 0) < 0
                            && fee["isTransfer"] == .bool(false) && fee["accountId"] == values["accountId"]
                            && fee["date"] == values["date"] && fee["currency"] == values["currency"])
                }
            }
            if let values {
                let card = proof["eventKind"] == .string("card_expense")
                guard let amount = number(values["amount"]) else { throw failure() }
                try require(values["isTransfer"] == .bool(!card) && amount != 0 && (!card || amount < 0))
            }
            let key = try string(proof["groupKey"])
            let file = try string(proof["fileHash"])
            let members = try integer(proof["memberCount"], positive: true, safe: true)
            var group = groups[key] ?? (action.batchId, file, members, 0)
            try require(group.batch == action.batchId && group.file == file && group.members == members)
            group.count += 1
            groups[key] = group
        }
        try require(groups.values.allSatisfy { $0.count == $0.members })
    }
}
