import Foundation

/// The API calls of `/accounts` and `/accounts/:id` (apps/frontend/src/lib/api/accounts.ts,
/// transactions.ts, plannedTransactions.ts and portfolio.ts), so tests can use a fake.
public protocol AccountsService: Sendable {
    /// `getAccounts({ active })`: `"all"` for the hub and the detail, `"true"` for the broker
    /// destinations of Close account and Transfer lots.
    func accounts(active: String) async throws -> [OpenAPI.Account]
    /// `getPortfolioSummary({ currency })`: its `byAccount` and `accountTotals` rows
    /// (`getBrokerAccountMetrics`).
    func portfolioAccountRows(currency: CurrencyCode) async throws -> AccountPortfolioSummary
    /// `getAccountTotals(currency)`: converted balances, group subtotals and Net cash,
    /// computed on the server (ADR-216).
    func accountTotals(currency: CurrencyCode) async throws -> OpenAPI.AccountTotals
    /// `getTransactions({ account_id, limit, offset, sort_by: "date", sort_dir: "desc",
    /// include_balance: true })`: one ledger page.
    func ledger(accountId: AccountID, offset: Int, limit: Int) async throws -> AccountLedgerPage
    /// `getPlannedTransactions({ account_id, active: true, is_executed: false, limit: 5000 })`.
    func plannedRows(accountId: AccountID) async throws -> AccountPlannedPage
    /// `createAccount(data)`: the new account's id.
    func createAccount(_ body: OpenAPI.AccountCreate) async throws -> AccountID
    /// `updateAccount(id, data)` with explicit nulls.
    func updateAccount(id: AccountID, patch: AccountPatch) async throws
    /// `deleteAccount(id)`.
    func deleteAccount(id: AccountID) async throws
    /// `setOpeningBalance(id, { balance, date, currency })`: the server's `warning`, if any.
    func setOpeningBalance(id: AccountID, balance: Decimal, date: String, currency: CurrencyCode) async throws -> String?
    /// `setStatementBalance(id, currency, { balance, date })`.
    func setStatementBalance(id: AccountID, currency: CurrencyCode, balance: Decimal, date: String) async throws
    /// `reconcileAccount(id, mode, currency)`.
    func reconcile(id: AccountID, mode: ReconcileMode, currency: CurrencyCode) async throws
    /// `previewMerge(sourceId, targetId)`.
    func mergePreview(sourceId: AccountID, targetId: AccountID) async throws -> AccountMergePreview
    /// `mergeAccounts(targetId, sourceIds)`: the moved counts.
    func merge(targetId: AccountID, sourceIds: [AccountID]) async throws -> AccountMergeCounts
    /// `closeAccount(id, balanceHandling)`.
    func closeAccount(id: AccountID, balanceHandling: CloseBalanceHandling) async throws
    /// `getAccountPortfolioLotRetagPreview(id)`.
    func lotPreview(accountId: AccountID) async throws -> AccountLotPreview
    /// `bulkRetagPortfolioTransactions({ transaction_ids, from_account_id, to_account_id,
    /// idempotency_key })`: `to_account_id: null` moves the lots to Unassigned.
    func retagLots(_ request: LotRetagRequest) async throws -> LotRetagReceipt
}

/// `ReconcileMode`.
public enum ReconcileMode: String, Sendable, CaseIterable {
    case accept
    case adjustment
}

/// `AccountCloseBalanceHandling`: `adjustment` zeroes the residual, `preserve` keeps it.
public enum CloseBalanceHandling: String, Sendable {
    case preserve
    case adjustment
}

/// `AccountMergePreview`, with the server's optional fields read leniently.
public struct AccountMergePreview: Equatable, Sendable {
    public let into: AccountID
    public let source: AccountID
    public let transactions: Int
    public let planned: Int
    public let projectedBalance: Decimal
    public let projectedBalanceCurrency: CurrencyCode?
    public let balanceParts: [OpenAPI.Account.BalancePartsItem]
    public let projectedBalanceIncomplete: Bool
    public let unconvertedCurrencies: [CurrencyCode]
    public let stampsInterleaved: Bool

    public init(
        into: AccountID, source: AccountID, transactions: Int, planned: Int, projectedBalance: Decimal,
        projectedBalanceCurrency: CurrencyCode? = nil, balanceParts: [OpenAPI.Account.BalancePartsItem] = [],
        projectedBalanceIncomplete: Bool = false, unconvertedCurrencies: [CurrencyCode] = [], stampsInterleaved: Bool = false
    ) {
        self.into = into
        self.source = source
        self.transactions = transactions
        self.planned = planned
        self.projectedBalance = projectedBalance
        self.projectedBalanceCurrency = projectedBalanceCurrency
        self.balanceParts = balanceParts
        self.projectedBalanceIncomplete = projectedBalanceIncomplete
        self.unconvertedCurrencies = unconvertedCurrencies
        self.stampsInterleaved = stampsInterleaved
    }

    /// The parts `projectedBalance` leaves out.
    public var excludedParts: [OpenAPI.Account.BalancePartsItem] {
        balanceParts.filter { unconvertedCurrencies.contains($0.currency) }
    }
}

/// `AccountMergeResult.reassigned`: what the receipt toast reports.
public struct AccountMergeCounts: Equatable, Sendable {
    public let transactions: Int
    public let planned: Int

    public init(transactions: Int, planned: Int) {
        self.transactions = transactions
        self.planned = planned
    }
}

/// `AccountPortfolioLotRetagPreview`.
public struct AccountLotPreview: Equatable, Sendable {
    public let accountId: AccountID
    public let eligibleCount: Int
    public let transactionIds: [TransactionID]
    public let limit: Int

    public init(accountId: AccountID, eligibleCount: Int, transactionIds: [TransactionID], limit: Int) {
        self.accountId = accountId
        self.eligibleCount = eligibleCount
        self.transactionIds = transactionIds
        self.limit = limit
    }

    /// `eligible_count > limit`.
    public var isOverLimit: Bool { eligibleCount > limit }

    /// The whole selection is in hand: under the limit and every id listed.
    public var isComplete: Bool { !isOverLimit && transactionIds.count == eligibleCount }
}

/// `PortfolioBrokerRetagRequest`.
public struct LotRetagRequest: Equatable, Sendable, Encodable {
    public let transactionIds: [TransactionID]
    public let fromAccountId: AccountID
    /// `nil` sends `null`: Unassigned.
    public let toAccountId: AccountID?
    public let idempotencyKey: String

    public init(transactionIds: [TransactionID], fromAccountId: AccountID, toAccountId: AccountID?, idempotencyKey: String) {
        self.transactionIds = transactionIds
        self.fromAccountId = fromAccountId
        self.toAccountId = toAccountId
        self.idempotencyKey = idempotencyKey
    }

    enum CodingKeys: String, CodingKey {
        case transactionIds = "transaction_ids"
        case fromAccountId = "from_account_id"
        case toAccountId = "to_account_id"
        case idempotencyKey = "idempotency_key"
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transactionIds, forKey: .transactionIds)
        try container.encode(fromAccountId, forKey: .fromAccountId)
        if let toAccountId {
            try container.encode(toAccountId, forKey: .toAccountId)
        } else {
            try container.encodeNil(forKey: .toAccountId)
        }
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
    }
}

/// The receipt card of Transfer lots and the moved count of Close account.
public struct LotRetagReceipt: Equatable, Sendable {
    /// `retagMovedCount`: a replayed request moved nothing now, so it reports the selected count.
    public let movedCount: Int

    public init(movedCount: Int) {
        self.movedCount = movedCount
    }
}

extension OpenAPI.PortfolioBrokerRetagReceipt {
    /// `retagMovedCount` in `apps/frontend/src/lib/api/portfolio.ts`.
    public var movedCount: Int { replayed ? selectedCount : changedCount }
}

extension APIClient: AccountsService {
    public func accounts(active: String) async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: active)).items
    }

    public func portfolioAccountRows(currency: CurrencyCode) async throws -> AccountPortfolioSummary {
        let data = try await send(PortfolioAccountRowsRequest(currency: currency))
        return AccountPortfolioSummary(byAccount: data.byAccount, accountTotals: data.accountTotals)
    }

    public func accountTotals(currency: CurrencyCode) async throws -> OpenAPI.AccountTotals {
        try await send(OpenAPIOperations.GetAccountTotals(currency: currency))
    }

    public func ledger(accountId: AccountID, offset: Int, limit: Int) async throws -> AccountLedgerPage {
        let list = try await send(
            OpenAPIOperations.GetTransactions(
                limit: limit, offset: offset, accountId: accountId, sortBy: "date", sortDir: "desc",
                includeBalance: true))
        return AccountLedgerPage(rows: list.items.map(AccountLedgerRow.init), total: list.total)
    }

    public func plannedRows(accountId: AccountID) async throws -> AccountPlannedPage {
        let list = try await send(
            OpenAPIOperations.GetPlannedTransactions(limit: 5000, accountId: accountId, isExecuted: false, active: true))
        return AccountPlannedPage(rows: list.items.map(AccountPlannedRow.init), total: list.total)
    }

    public func createAccount(_ body: OpenAPI.AccountCreate) async throws -> AccountID {
        try await send(OpenAPIOperations.CreateAccount(body: body)).id
    }

    public func updateAccount(id: AccountID, patch: AccountPatch) async throws {
        _ = try await send(AccountPatchRequest(id: id, patch: patch))
    }

    public func deleteAccount(id: AccountID) async throws {
        _ = try await send(OpenAPIOperations.DeleteAccount(id: id))
    }

    public func setOpeningBalance(id: AccountID, balance: Decimal, date: String, currency: CurrencyCode) async throws -> String? {
        let answer = try await send(
            OpenAPIOperations.SetAccountOpeningBalance(
                id: id, body: .init(balance: balance, date: CalendarDay(validating: date), currency: currency)))
        return answer.objectValue?["warning"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func setStatementBalance(id: AccountID, currency: CurrencyCode, balance: Decimal, date: String) async throws {
        _ = try await send(
            OpenAPIOperations.SetAccountStatementBalance(
                id: id, currency: currency, body: .init(balance: balance, date: CalendarDay(validating: date))))
    }

    public func reconcile(id: AccountID, mode: ReconcileMode, currency: CurrencyCode) async throws {
        _ = try await send(OpenAPIOperations.ReconcileAccount(id: id, body: .init(mode: .init(rawValue: mode.rawValue), currency: currency)))
    }

    public func mergePreview(sourceId: AccountID, targetId: AccountID) async throws -> AccountMergePreview {
        let data = try await send(OpenAPIOperations.PreviewAccountMerge(id: sourceId, into: targetId.rawValue))
        return AccountMergePreview(
            into: data.into.map(AccountID.init(rawValue:)) ?? targetId,
            source: data.source.map(AccountID.init(rawValue:)) ?? sourceId,
            transactions: data.reassigned?.transactions ?? 0, planned: data.reassigned?.planned ?? 0,
            projectedBalance: data.projectedBalance ?? 0, projectedBalanceCurrency: data.projectedBalanceCurrency,
            balanceParts: (data.balanceParts ?? []).map { part in
                OpenAPI.Account.BalancePartsItem(currency: part.currency, balance: part.balance)
            },
            projectedBalanceIncomplete: data.projectedBalanceIncomplete ?? false,
            unconvertedCurrencies: data.unconvertedCurrencies ?? [], stampsInterleaved: data.stampsInterleaved ?? false)
    }

    public func merge(targetId: AccountID, sourceIds: [AccountID]) async throws -> AccountMergeCounts {
        let answer = try await send(OpenAPIOperations.MergeAccounts(id: targetId, body: .init(sourceIds: sourceIds)))
        let reassigned = answer.objectValue?["reassigned"]?.objectValue
        return AccountMergeCounts(
            transactions: reassigned?["transactions"].flatMap(Self.wholeNumber) ?? 0,
            planned: reassigned?["planned"].flatMap(Self.wholeNumber) ?? 0)
    }

    public func closeAccount(id: AccountID, balanceHandling: CloseBalanceHandling) async throws {
        _ = try await send(OpenAPIOperations.CloseAccount(id: id, body: .init(balanceHandling: .init(rawValue: balanceHandling.rawValue))))
    }

    public func lotPreview(accountId: AccountID) async throws -> AccountLotPreview {
        let data = try await send(OpenAPIOperations.PreviewAccountPortfolioLots(id: accountId))
        return AccountLotPreview(
            accountId: data.accountId, eligibleCount: data.eligibleCount, transactionIds: data.transactionIds,
            limit: data.limit)
    }

    public func retagLots(_ request: LotRetagRequest) async throws -> LotRetagReceipt {
        let receipt = try await send(LotRetagOperation(request: request))
        return LotRetagReceipt(movedCount: receipt.movedCount)
    }
}

// MARK: - Hand-written requests

/// `AccountUpdate` as the Edit sheet and Reopen send it (`toAccountPayload(values,
/// "update")`): an absent field is left alone, and an emptied display name or institution
/// is sent as `null` so the server clears it, which the generated body cannot express.
public struct AccountPatch: Equatable, Sendable, Encodable {
    public var name: String?
    /// `.some(nil)` sends `null`.
    public var displayName: String??
    /// `.some(nil)` sends `null`.
    public var institution: String??
    public var currency: CurrencyCode?
    public var type: OpenAPI.AccountUpdate.AccountUpdateType?
    public var owner: OpenAPI.AccountUpdate.Owner?
    public var liquidityClass: OpenAPI.AccountUpdate.LiquidityClass?
    public var taxWrapper: OpenAPI.AccountUpdate.TaxWrapper?
    public var spendable: Bool?
    public var inNetWorth: Bool?
    public var multiCurrencyCash: Bool?
    public var hasCashSleeve: Bool?
    public var isActive: Bool?

    public init() {}

    /// Reopen: `{ is_active: true }`.
    public static var reopen: AccountPatch {
        var patch = AccountPatch()
        patch.isActive = true
        return patch
    }

    enum CodingKeys: String, CodingKey {
        case name
        case displayName = "display_name"
        case institution
        case currency
        case type
        case owner
        case liquidityClass = "liquidity_class"
        case taxWrapper = "tax_wrapper"
        case spendable
        case inNetWorth = "in_net_worth"
        case multiCurrencyCash = "multi_currency_cash"
        case hasCashSleeve = "has_cash_sleeve"
        case isActive = "is_active"
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try Self.encode(displayName, forKey: .displayName, in: &container)
        try Self.encode(institution, forKey: .institution, in: &container)
        try container.encodeIfPresent(currency, forKey: .currency)
        try container.encodeIfPresent(type, forKey: .type)
        try container.encodeIfPresent(owner, forKey: .owner)
        try container.encodeIfPresent(liquidityClass, forKey: .liquidityClass)
        try container.encodeIfPresent(taxWrapper, forKey: .taxWrapper)
        try container.encodeIfPresent(spendable, forKey: .spendable)
        try container.encodeIfPresent(inNetWorth, forKey: .inNetWorth)
        try container.encodeIfPresent(multiCurrencyCash, forKey: .multiCurrencyCash)
        try container.encodeIfPresent(hasCashSleeve, forKey: .hasCashSleeve)
        try container.encodeIfPresent(isActive, forKey: .isActive)
    }

    /// Absent: nothing; `.some(nil)`: `null`; a value: the value.
    private static func encode(
        _ value: String??, forKey key: CodingKeys, in container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        guard let value else { return }
        if let value {
            try container.encode(value, forKey: key)
        } else {
            try container.encodeNil(forKey: key)
        }
    }
}

/// `PATCH /api/accounts/{id}` (operationId `updateAccount`) with `AccountPatch`. The answer
/// is not read (the web refetches the list), so any body is accepted.
public struct AccountPatchRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.UpdateAccount.operationId
    public static let method = OpenAPIOperations.UpdateAccount.method
    public static let pathTemplate = OpenAPIOperations.UpdateAccount.pathTemplate

    public let id: AccountID
    public let patch: AccountPatch

    public init(id: AccountID, patch: AccountPatch) {
        self.id = id
        self.patch = patch
    }

    public var path: String { OpenAPIOperations.UpdateAccount(id: id, body: OpenAPI.AccountUpdate()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}

/// `PUT /api/investments/transactions/broker` (operationId `bulkRetagPortfolioTransactions`):
/// the generated body drops a `nil` `to_account_id`, but the field is required and `null`
/// means Unassigned.
public struct LotRetagOperation: APIOperation {
    public typealias Response = OpenAPI.PortfolioBrokerRetagReceipt
    public static let operationId = OpenAPIOperations.BulkRetagPortfolioTransactions.operationId
    public static let method = OpenAPIOperations.BulkRetagPortfolioTransactions.method
    public static let pathTemplate = OpenAPIOperations.BulkRetagPortfolioTransactions.pathTemplate

    public let request: LotRetagRequest

    public init(request: LotRetagRequest) {
        self.request = request
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(request)
    }
}

/// `GET /api/info/portfolio-summary?currency=` (operationId `getPortfolioSummary`): the spec
/// types its response as the whole envelope (`allOf`), which the generator takes for the
/// `data`, so this request reads the one part the accounts screens need.
public struct PortfolioAccountRowsRequest: APIOperation {
    public static let operationId = OpenAPIOperations.GetPortfolioSummary.operationId
    public static let method = OpenAPIOperations.GetPortfolioSummary.method
    public static let pathTemplate = OpenAPIOperations.GetPortfolioSummary.pathTemplate

    /// `data.byAccount` and `data.accountTotals`; absent reads as no rows.
    public struct Response: Decodable, Equatable, Sendable {
        public let byAccount: [PortfolioAccountRow]
        public let accountTotals: [PortfolioAccountTotalsRow]

        enum CodingKeys: String, CodingKey {
            case byAccount, accountTotals
        }

        public init(byAccount: [PortfolioAccountRow], accountTotals: [PortfolioAccountTotalsRow] = []) {
            self.byAccount = byAccount
            self.accountTotals = accountTotals
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            byAccount = try container.decodeIfPresent([PortfolioAccountRow].self, forKey: .byAccount) ?? []
            accountTotals =
                try container.decodeIfPresent([PortfolioAccountTotalsRow].self, forKey: .accountTotals) ?? []
        }
    }

    public let currency: CurrencyCode

    public init(currency: CurrencyCode) {
        self.currency = currency
    }

    public var path: String { Self.pathTemplate }

    public var queryItems: [URLQueryItem] {
        OpenAPIOperations.GetPortfolioSummary(currency: currency).queryItems
    }
}
