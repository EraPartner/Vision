import Foundation

/// The calls behind the planned-payment sheet, Mark as paid, the match suggestions and
/// recurring detection (apps/frontend/src/lib/api/planned.ts, info.ts and settings.ts), so
/// tests can use a fake.
public protocol PlannedEditingService: Sendable {
    /// `createPlannedTransaction(mapToCreateAPI(payment))`.
    func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws -> OpenAPI.PlannedTransaction
    /// `updatePlannedTransaction(id, mapToUpdateAPI(updates))`.
    func updatePlannedPayment(id: PlannedTransactionID, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction
    /// Track: `createPlannedTransaction` with the detected pattern's body.
    func trackPlannedPayment(_ body: PlannedTrackBody) async throws -> OpenAPI.PlannedTransaction
    /// `executePlannedTransaction(id, { executed_transaction_id, execution_date })`.
    func executePlannedPayment(id: PlannedTransactionID, transactionId: TransactionID, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    /// `getPlannedMatchSuggestions()`: the rows of the `{ items, total }` body.
    func matchSuggestions() async throws -> [PlannedMatchSuggestion]
    /// `getRecurringPatterns()`: fail-soft, so only a contract mismatch throws.
    func recurringPatterns() async throws -> [PlannedRecurringPattern]
    /// `useLinkTransactionCandidates`: `getTransactions` with the dialog's filters.
    func linkCandidates(_ query: PlannedLinkQuery) async throws -> [OpenAPI.Transaction]
    /// `getSetting(key)`.
    func setting(key: SettingKey) async throws -> OpenAPI.Setting
    /// `saveSetting(key, value)` against the baseline the read produced.
    func saveSetting(key: SettingKey, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

/// A row of `GET /api/planned-transactions/match-suggestions`.
public typealias PlannedMatchSuggestion = OpenAPIOperations.GetPlannedMatchSuggestions.ResponseData.ItemsItem

extension APIClient: PlannedEditingService {
    public func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws
        -> OpenAPI.PlannedTransaction
    {
        try await send(OpenAPIOperations.CreatePlannedTransaction(body: body))
    }

    public func updatePlannedPayment(id: PlannedTransactionID, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction {
        try await send(PlannedPaymentPatchRequest(id: id, patch: patch))
    }

    public func trackPlannedPayment(_ body: PlannedTrackBody) async throws -> OpenAPI.PlannedTransaction {
        try await send(PlannedTrackRequest(body: body))
    }

    public func executePlannedPayment(id: PlannedTransactionID, transactionId: TransactionID, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    {
        try await send(
            OpenAPIOperations.ExecutePlannedTransaction(
                id: id,
                body: OpenAPIOperations.ExecutePlannedTransaction.Body(
                    executedTransactionId: transactionId,
                    executionDate: executionDate.map { try CalendarDay(validating: $0) })))
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

    public func setting(key: SettingKey) async throws -> OpenAPI.Setting {
        try await send(OpenAPIOperations.GetSetting(key: key))
    }

    public func saveSetting(key: SettingKey, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(
            OpenAPIOperations.SaveSetting(
                key: key,
                body: OpenAPIOperations.SaveSetting.Body(
                    value: value, expected: try OpenAPI.SettingBaseline(json: expected))))
    }
}

// MARK: The PATCH body

/// `PlannedTransactionUpdate` as `mapToUpdateAPI` builds it: an absent field is left alone.
/// The recurrence bounds are double optionals so the sheet can send an explicit `null`
/// (clear) as well as leave them out.
public struct PlannedPaymentPatch: Equatable, Sendable, Encodable {
    public var plannedDate: String?
    public var accountId: AccountID?
    public var recipientId: RecipientID?
    public var memo: String?
    public var amount: Decimal?
    public var currency: CurrencyCode?
    public var categoryId: CategoryID?
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

    public var id: PlannedTransactionID
    public var patch: PlannedPaymentPatch

    public init(id: PlannedTransactionID, patch: PlannedPaymentPatch) {
        self.id = id
        self.patch = patch
    }

    public var path: String { OpenAPIOperations.UpdatePlannedTransaction(id: id, body: .init()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}

/// Track's `POST` body (`createPlannedTransaction` of a detected pattern). Unlike the
/// generated `PlannedTransactionCreate`, `account_id` is left out when the pattern has no
/// account, like the web's `pattern.account_id!` (`undefined`); the server then answers its
/// missing-field 400.
public struct PlannedTrackBody: Equatable, Sendable, Encodable {
    public let plannedDate: String
    public let accountId: AccountID?
    public let recipientId: RecipientID
    public let memo: String
    public let amount: Decimal
    public let currency: CurrencyCode
    public let categoryId: CategoryID?
    public let recurrencePattern: String
    /// Always `true`: Track creates a recurring payment.
    public var isRecurring: Bool { true }

    public init(
        plannedDate: String, accountId: AccountID?, recipientId: RecipientID, memo: String, amount: Decimal,
        currency: CurrencyCode, categoryId: CategoryID?, recurrencePattern: String
    ) {
        self.plannedDate = plannedDate
        self.accountId = accountId
        self.recipientId = recipientId
        self.memo = memo
        self.amount = amount
        self.currency = currency
        self.categoryId = categoryId
        self.recurrencePattern = recurrencePattern
    }

    enum CodingKeys: String, CodingKey {
        case plannedDate = "planned_date"
        case accountId = "account_id"
        case recipientId = "recipient_id"
        case memo
        case amount
        case currency
        case categoryId = "category_id"
        case isRecurring = "is_recurring"
        case recurrencePattern = "recurrence_pattern"
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(plannedDate, forKey: .plannedDate)
        try container.encodeIfPresent(accountId, forKey: .accountId)
        try container.encode(recipientId, forKey: .recipientId)
        try container.encode(memo, forKey: .memo)
        try container.encode(amount, forKey: .amount)
        try container.encode(currency, forKey: .currency)
        try container.encodeIfPresent(categoryId, forKey: .categoryId)
        try container.encode(isRecurring, forKey: .isRecurring)
        try container.encode(recurrencePattern, forKey: .recurrencePattern)
    }
}

/// `POST /api/planned-transactions` (operationId `createPlannedTransaction`) with Track's body.
public struct PlannedTrackRequest: APIOperation {
    public typealias Response = OpenAPI.PlannedTransaction
    public static let operationId = OpenAPIOperations.CreatePlannedTransaction.operationId
    public static let method = OpenAPIOperations.CreatePlannedTransaction.method
    public static let pathTemplate = OpenAPIOperations.CreatePlannedTransaction.pathTemplate

    public var body: PlannedTrackBody

    public init(body: PlannedTrackBody) {
        self.body = body
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(body)
    }
}

// MARK: Recurring patterns

/// `direction` of a detected pattern: `income` or `expense`; another value is kept as sent.
public enum PlannedPatternDirection: Codable, Hashable, Sendable, RawRepresentable {
    case income
    case expense
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "income": self = .income
        case "expense": self = .expense
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .income: return "income"
        case .expense: return "expense"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `direction` of an amount change: `increased` or `decreased`; another value is kept as sent.
public enum PlannedChangeDirection: Codable, Hashable, Sendable, RawRepresentable {
    case increased
    case decreased
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "increased": self = .increased
        case "decreased": self = .decreased
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .increased: return "increased"
        case .decreased: return "decreased"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// One detected pattern of `GET /api/info/recurring-patterns` (the fields
/// `RecurringDetectionPanel` reads). The operation's schema is untyped, so the envelope's
/// `data` is decoded here.
public struct PlannedRecurringPattern: Equatable, Sendable, Decodable, Identifiable {
    public struct AmountChange: Equatable, Sendable, Decodable {
        public let date: String
        public let previousAmount: Decimal
        public let newAmount: Decimal
        public let percentChange: Decimal
        public let direction: PlannedChangeDirection

        public init(
            date: String, previousAmount: Decimal, newAmount: Decimal, percentChange: Decimal,
            direction: PlannedChangeDirection
        ) {
            self.date = date
            self.previousAmount = previousAmount
            self.newAmount = newAmount
            self.percentChange = percentChange
            self.direction = direction
        }
    }

    public let recipientId: RecipientID
    public let recipientName: String
    /// A payee can yield one pattern per direction.
    public let direction: PlannedPatternDirection
    public let detectedPattern: String
    public let intervalDays: Int
    public let occurrences: Int
    public let latestAmount: Decimal
    public let currency: CurrencyCode
    public let categoryId: CategoryID?
    public let categoryName: String?
    public let accountId: AccountID?
    public let predictedNext: String
    public let amountChanges: [AmountChange]
    public let isAlreadyPlanned: Bool
    public let confidence: Decimal

    public var id: String { "\(recipientId.rawValue)-\(direction.rawValue)" }

    public init(
        recipientId: RecipientID, recipientName: String, direction: PlannedPatternDirection = .expense,
        detectedPattern: String = "monthly", intervalDays: Int = 30, occurrences: Int = 3, latestAmount: Decimal,
        currency: CurrencyCode = LedgerCurrency.eur, categoryId: CategoryID? = nil, categoryName: String? = nil,
        accountId: AccountID? = nil, predictedNext: String,
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
    public func trackBody(memo: String) -> PlannedTrackBody {
        let magnitude = latestAmount < 0 ? -latestAmount : latestAmount
        return PlannedTrackBody(
            plannedDate: predictedNext, accountId: accountId, recipientId: recipientId, memo: memo,
            amount: direction == .income ? magnitude : -magnitude, currency: currency, categoryId: categoryId,
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
    public var recipientId: RecipientID?
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
        operation.startDate = CalendarDay(startDate)
        operation.endDate = CalendarDay(endDate)
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
