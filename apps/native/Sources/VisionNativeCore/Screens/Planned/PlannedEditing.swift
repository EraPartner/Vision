import Foundation

/// The calls behind the planned-payment sheet, Mark as paid, the match suggestions and
/// recurring detection (apps/frontend/src/lib/api/planned.ts, info.ts and settings.ts), so
/// tests can use a fake.
public protocol PlannedEditingService: Sendable {
    /// `createPlannedTransaction(mapToCreateAPI(payment))`.
    func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws -> OpenAPI.PlannedTransaction
    /// `updatePlannedTransaction(id, mapToUpdateAPI(updates))`.
    func updatePlannedPayment(id: Int, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction
    /// `executePlannedTransaction(id, { executed_transaction_id, execution_date })`.
    func executePlannedPayment(id: Int, transactionId: Int, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    /// `getPlannedMatchSuggestions()`: the rows of the `{ items, total }` body.
    func matchSuggestions() async throws -> [PlannedMatchSuggestion]
    /// `getRecurringPatterns()`: fail-soft, so only a contract mismatch throws.
    func recurringPatterns() async throws -> [PlannedRecurringPattern]
    /// `useLinkTransactionCandidates`: `getTransactions` with the dialog's filters.
    func linkCandidates(_ query: PlannedLinkQuery) async throws -> [OpenAPI.Transaction]
    /// `getSetting(key)`.
    func setting(key: String) async throws -> OpenAPI.Setting
    /// `saveSetting(key, value)` against the baseline the read produced.
    func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

/// A row of `GET /api/planned-transactions/match-suggestions`.
public typealias PlannedMatchSuggestion = OpenAPIOperations.GetPlannedMatchSuggestions.ResponseData.ItemsItem

extension APIClient: PlannedEditingService {
    public func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws
        -> OpenAPI.PlannedTransaction
    {
        try await send(OpenAPIOperations.CreatePlannedTransaction(body: body))
    }

    public func updatePlannedPayment(id: Int, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction {
        try await send(PlannedPaymentPatchRequest(id: id, patch: patch))
    }

    public func executePlannedPayment(id: Int, transactionId: Int, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    {
        try await send(
            OpenAPIOperations.ExecutePlannedTransaction(
                id: id,
                body: OpenAPIOperations.ExecutePlannedTransaction.Body(
                    executedTransactionId: transactionId, executionDate: executionDate)))
    }

    public func matchSuggestions() async throws -> [PlannedMatchSuggestion] {
        try await send(OpenAPIOperations.GetPlannedMatchSuggestions()).items
    }

    public func recurringPatterns() async throws -> [PlannedRecurringPattern] {
        let body: JSONValue
        do {
            body = try await send(OpenAPIOperations.GetRecurringPatterns())
        } catch let error as APIError {
            // Fail-soft: recurrence detection is optional enrichment; a contract mismatch is a
            // defect and surfaces.
            if case .contract = error { throw error }
            return []
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return []
        }
        return try PlannedRecurringPattern.list(from: body)
    }

    public func linkCandidates(_ query: PlannedLinkQuery) async throws -> [OpenAPI.Transaction] {
        try await send(query.operation).items
    }

    public func setting(key: String) async throws -> OpenAPI.Setting {
        try await send(OpenAPIOperations.GetSetting(key: key))
    }

    public func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(
            OpenAPIOperations.SaveSetting(key: key, body: OpenAPIOperations.SaveSetting.Body(value: value, expected: expected)))
    }
}

// MARK: The PATCH body

/// `PlannedTransactionUpdate` as `mapToUpdateAPI` builds it: an absent field is left alone.
/// The recurrence bounds are double optionals so the sheet can send an explicit `null`
/// (clear) as well as leave them out.
public struct PlannedPaymentPatch: Equatable, Sendable, Encodable {
    public var plannedDate: String?
    public var accountId: Int?
    public var recipientId: Int?
    public var memo: String?
    public var amount: Decimal?
    public var currency: String?
    public var categoryId: Int?
    public var comment: String?
    public var url: String?
    public var isRecurring: Bool?
    public var recurrencePattern: String?
    /// `.some(nil)` sends `null`.
    public var recurrenceEndDate: String??
    /// `.some(nil)` sends `null`.
    public var maxOccurrences: Int??
    public var isActive: Bool?
    public var isLoan: Bool?
    public var loanType: OpenAPI.PlannedLoanType?
    public var loanPrincipal: Decimal?
    public var loanAnnualInterestRate: Decimal?
    public var loanTermMonths: Int?
    public var loanStartDate: String?
    public var loanPaymentDay: Int?
    public var tags: [String]?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case plannedDate = "planned_date"
        case accountId = "account_id"
        case recipientId = "recipient_id"
        case memo
        case amount
        case currency
        case categoryId = "category_id"
        case comment
        case url
        case isRecurring = "is_recurring"
        case recurrencePattern = "recurrence_pattern"
        case recurrenceEndDate = "recurrence_end_date"
        case maxOccurrences = "max_occurrences"
        case isActive = "is_active"
        case isLoan = "is_loan"
        case loanType = "loan_type"
        case loanPrincipal = "loan_principal"
        case loanAnnualInterestRate = "loan_annual_interest_rate"
        case loanTermMonths = "loan_term_months"
        case loanStartDate = "loan_start_date"
        case loanPaymentDay = "loan_payment_day"
        case tags
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(plannedDate, forKey: .plannedDate)
        try container.encodeIfPresent(accountId, forKey: .accountId)
        try container.encodeIfPresent(recipientId, forKey: .recipientId)
        try container.encodeIfPresent(memo, forKey: .memo)
        try container.encodeIfPresent(amount, forKey: .amount)
        try container.encodeIfPresent(currency, forKey: .currency)
        try container.encodeIfPresent(categoryId, forKey: .categoryId)
        try container.encodeIfPresent(comment, forKey: .comment)
        try container.encodeIfPresent(url, forKey: .url)
        try container.encodeIfPresent(isRecurring, forKey: .isRecurring)
        try container.encodeIfPresent(recurrencePattern, forKey: .recurrencePattern)
        if let endDate = recurrenceEndDate {
            if let endDate {
                try container.encode(endDate, forKey: .recurrenceEndDate)
            } else {
                try container.encodeNil(forKey: .recurrenceEndDate)
            }
        }
        if let maximum = maxOccurrences {
            if let maximum {
                try container.encode(maximum, forKey: .maxOccurrences)
            } else {
                try container.encodeNil(forKey: .maxOccurrences)
            }
        }
        try container.encodeIfPresent(isActive, forKey: .isActive)
        try container.encodeIfPresent(isLoan, forKey: .isLoan)
        try container.encodeIfPresent(loanType, forKey: .loanType)
        try container.encodeIfPresent(loanPrincipal, forKey: .loanPrincipal)
        try container.encodeIfPresent(loanAnnualInterestRate, forKey: .loanAnnualInterestRate)
        try container.encodeIfPresent(loanTermMonths, forKey: .loanTermMonths)
        try container.encodeIfPresent(loanStartDate, forKey: .loanStartDate)
        try container.encodeIfPresent(loanPaymentDay, forKey: .loanPaymentDay)
        try container.encodeIfPresent(tags, forKey: .tags)
    }
}

/// `PATCH /api/planned-transactions/{id}` (operationId `updatePlannedTransaction`) with a body
/// that can carry explicit nulls, which the generated `Body` drops.
public struct PlannedPaymentPatchRequest: APIOperation {
    public typealias Response = OpenAPI.PlannedTransaction
    public static let operationId = OpenAPIOperations.UpdatePlannedTransaction.operationId
    public static let method = OpenAPIOperations.UpdatePlannedTransaction.method
    public static let pathTemplate = OpenAPIOperations.UpdatePlannedTransaction.pathTemplate

    public var id: Int
    public var patch: PlannedPaymentPatch

    public init(id: Int, patch: PlannedPaymentPatch) {
        self.id = id
        self.patch = patch
    }

    public var path: String { OpenAPIOperations.UpdatePlannedTransaction(id: id, body: .init()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}

// MARK: Recurring patterns

/// One detected pattern of `GET /api/info/recurring-patterns` (the fields
/// `RecurringDetectionPanel` reads). The operation's schema is untyped, so the envelope's
/// `data` is decoded here.
public struct PlannedRecurringPattern: Equatable, Sendable, Decodable, Identifiable {
    public struct AmountChange: Equatable, Sendable, Decodable {
        public let date: String
        public let previousAmount: Decimal
        public let newAmount: Decimal
        public let percentChange: Decimal
        /// `increased` or `decreased`.
        public let direction: String

        public init(date: String, previousAmount: Decimal, newAmount: Decimal, percentChange: Decimal, direction: String) {
            self.date = date
            self.previousAmount = previousAmount
            self.newAmount = newAmount
            self.percentChange = percentChange
            self.direction = direction
        }
    }

    public let recipientId: Int
    public let recipientName: String
    /// `income` or `expense`: a payee can yield one pattern per direction.
    public let direction: String
    public let detectedPattern: String
    public let intervalDays: Int
    public let occurrences: Int
    public let latestAmount: Decimal
    public let currency: String
    public let categoryId: Int?
    public let categoryName: String?
    public let accountId: Int?
    public let predictedNext: String
    public let amountChanges: [AmountChange]
    public let isAlreadyPlanned: Bool
    public let confidence: Decimal

    public var id: String { "\(recipientId)-\(direction)" }

    public init(
        recipientId: Int, recipientName: String, direction: String = "expense", detectedPattern: String = "monthly",
        intervalDays: Int = 30, occurrences: Int = 3, latestAmount: Decimal, currency: String = "EUR",
        categoryId: Int? = nil, categoryName: String? = nil, accountId: Int? = nil, predictedNext: String,
        amountChanges: [AmountChange] = [], isAlreadyPlanned: Bool = false, confidence: Decimal = 90
    ) {
        self.recipientId = recipientId
        self.recipientName = recipientName
        self.direction = direction
        self.detectedPattern = detectedPattern
        self.intervalDays = intervalDays
        self.occurrences = occurrences
        self.latestAmount = latestAmount
        self.currency = currency
        self.categoryId = categoryId
        self.categoryName = categoryName
        self.accountId = accountId
        self.predictedNext = predictedNext
        self.amountChanges = amountChanges
        self.isAlreadyPlanned = isAlreadyPlanned
        self.confidence = confidence
    }

    /// `{ patterns, total }` to the patterns; a body of another shape is a contract error.
    static func list(from body: JSONValue) throws -> [PlannedRecurringPattern] {
        struct Body: Decodable {
            let patterns: [PlannedRecurringPattern]
        }
        do {
            return try body.decode(Body.self).patterns
        } catch {
            throw APIError.contract(
                APIContractError(endpoint: "GET /api/info/recurring-patterns", issues: ["patterns: unexpected shape"]))
        }
    }

    /// `ConfidenceBadge`: ≥ 80 high, ≥ 60 medium, else low.
    public var confidenceLevel: ConfidenceLevel {
        if confidence >= 80 { return .high }
        if confidence >= 60 { return .medium }
        return .low
    }

    public enum ConfidenceLevel: String, Sendable {
        case high
        case medium
        case low

        public var labelKey: String { "recurring.confidence.\(rawValue)" }
    }

    /// `PATTERN_LABELS`: the six named patterns, else the raw pattern.
    public func patternLabel(_ strings: any Localizing) -> String {
        let named: Set<String> = ["weekly", "biweekly", "monthly", "quarterly", "yearly", "custom"]
        return named.contains(detectedPattern) ? strings.t("recurring.pattern.\(detectedPattern)") : detectedPattern
    }

    /// The last amount change, which the alert row shows.
    public var lastChange: AmountChange? { amountChanges.last }

    /// Track's body: the next predicted date, the payee, the auto-detected memo, the latest
    /// amount signed by direction, currency, category, account and the pattern (or "every N
    /// days").
    public func trackBody(memo: String) -> OpenAPI.PlannedTransactionCreate {
        let magnitude = latestAmount < 0 ? -latestAmount : latestAmount
        return OpenAPI.PlannedTransactionCreate(
            plannedDate: predictedNext,
            // `pattern.accountId!`: a pattern without an account sends 0, which the server
            // rejects like the web's missing field.
            accountId: accountId ?? 0, recipientId: recipientId, memo: memo,
            amount: direction == "income" ? magnitude : -magnitude, currency: currency, categoryId: categoryId,
            isRecurring: true,
            recurrencePattern: detectedPattern == "custom" ? "every \(intervalDays) days" : detectedPattern)
    }
}

// MARK: Link candidates

/// `LinkTransactionFilters` and the request `useLinkTransactionCandidates` makes from them.
public struct PlannedLinkQuery: Equatable, Sendable {
    public var startDate = ""
    public var endDate = ""
    public var bankAccount = ""
    public var recipientName = ""
    /// The payee's merge-cluster root, while the dialog searches by it.
    public var recipientId: Int?
    public var uncategorised = false
    public var active = true
    public var matchAmount = true
    public var amountTolerancePct: Decimal = 5
    /// The payment's payee name, the fallback when the payee field is empty.
    public var paymentRecipient: String?

    public init() {}

    /// `limit: 50`, the non-empty filters, the payee by cluster id, typed name or the
    /// payment's own payee, `uncategorised` only when on, and `active` always.
    public var operation: OpenAPIOperations.GetTransactions {
        var operation = OpenAPIOperations.GetTransactions(limit: 50)
        if !startDate.isEmpty { operation.startDate = startDate }
        if !endDate.isEmpty { operation.endDate = endDate }
        if !bankAccount.isEmpty { operation.bankAccount = bankAccount }
        if let recipientId {
            operation.recipientId = recipientId
        } else if !recipientName.isEmpty {
            operation.recipientName = recipientName
        } else if let paymentRecipient, !paymentRecipient.isEmpty {
            operation.recipientName = paymentRecipient
        }
        if uncategorised { operation.uncategorised = true }
        operation.active = active
        return operation
    }

    /// The fields the request depends on (the amount match is local).
    public var requestKey: PlannedLinkQuery {
        var key = self
        key.matchAmount = true
        key.amountTolerancePct = 0
        return key
    }
}
