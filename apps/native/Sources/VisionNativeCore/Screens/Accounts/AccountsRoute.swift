import Foundation

/// The routes of `/accounts` and `/accounts/:id` (apps/frontend/src/pages/AccountsPage.tsx and
/// AccountDetailPage.tsx). The hub reads no query parameters, so the retired
/// `/accounts?account=<id>` form opens the hub. The detail reads `since`.
///
/// Phase 3f part B adds `/categories` and `/recipients` (`NativeScreen` gains their cases then);
/// until then both stay web pages.
public enum AccountsRoutes {
    public static let path = "/accounts"
    /// `?since=YYYY-MM-DD`: the Reconcile dialog's "Show transactions since {date}" exit.
    public static let sinceParameter = "since"

    /// `/accounts/:id`.
    public static func detailPath(_ id: AccountID) -> String {
        "\(path)/\(id)"
    }

    /// The `:id` segment of `/accounts/:id`: a positive whole number, or `0` for any other
    /// single segment (the page then shows Not found, as `validId` is false). `nil` when the
    /// path is not the detail route.
    public static func detailId(forPath candidate: String) -> AccountID? {
        let prefix = path + "/"
        guard candidate.hasPrefix(prefix) else { return nil }
        let segment = String(candidate.dropFirst(prefix.count))
        guard !segment.isEmpty, !segment.contains("/") else { return nil }
        let decoded = segment.removingPercentEncoding ?? segment
        return TransactionFilters.parseId(decoded) ?? AccountID(0)
    }

    /// `since` when it matches `YYYY-MM-DD`, else `nil`.
    public static func since(in route: NativeRoute) -> String? {
        guard let raw = route.value(sinceParameter), AccountDates.isYmd(raw) else { return nil }
        return raw
    }

    /// `/accounts/:id?since=<date>`.
    public static func sinceRoute(_ id: AccountID, since: String) -> String {
        NativeRoute(path: detailPath(id), query: [URLQueryItem(name: sinceParameter, value: since)]).string
    }

    /// `/transactions?account_id=<id>&filter_label=<label>` (View transactions).
    public static func transactionsLink(_ account: OpenAPI.Account) -> String {
        NativeRoute(
            path: TransactionsRoutes.path,
            query: [
                URLQueryItem(name: "account_id", value: String(account.id.rawValue)),
                URLQueryItem(name: "filter_label", value: AccountKinds.label(account)),
            ]
        ).string
    }
}

/// `YYYY-MM-DD` helpers: the app's YMD convention, compared as strings and through one UTC
/// calendar so a day never shifts across midnight or DST.
public enum AccountDates {
    /// `/^\d{4}-\d{2}-\d{2}$/`.
    public static func isYmd(_ text: String) -> Bool {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return false }
        return parts.allSatisfy { part in part.allSatisfy { $0.isASCII && $0.isNumber } }
    }

    /// `daysBetweenYmd`: whole calendar days from `from` to `to`.
    public static func daysBetween(_ from: String, _ to: String) -> Int? {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        func date(_ ymd: String) -> Date? {
            let parts = ymd.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        guard let start = date(from), let end = date(to) else { return nil }
        return Int((end.timeIntervalSince(start) / 86_400).rounded())
    }
}

/// `AccountType` (checking, savings, brokerage, crypto_exchange, wallet, pension, liability)
/// and the type helpers of groupAccounts.ts.
public enum AccountKind: CaseIterable, Sendable {
    case checking
    case savings
    case brokerage
    case cryptoExchange
    case wallet
    case pension
    case liability

    /// The known kind of a wire type; `nil` for a type this client does not know.
    public init?(_ type: OpenAPI.Account.AccountType) {
        switch type {
        case .checking: self = .checking
        case .savings: self = .savings
        case .brokerage: self = .brokerage
        case .cryptoExchange: self = .cryptoExchange
        case .wallet: self = .wallet
        case .pension: self = .pension
        case .liability: self = .liability
        case .unknown: return nil
        }
    }

    /// The wire type of this kind.
    public var type: OpenAPI.Account.AccountType {
        switch self {
        case .checking: return .checking
        case .savings: return .savings
        case .brokerage: return .brokerage
        case .cryptoExchange: return .cryptoExchange
        case .wallet: return .wallet
        case .pension: return .pension
        case .liability: return .liability
        }
    }

    /// `accounts.type.<type>`.
    public var labelKey: String { "accounts.type.\(type.rawValue)" }

    /// `TYPE_ICON` with the Lucide icons mapped like the sidebar (scripts/native-navigation.ts).
    public var symbol: String {
        switch self {
        case .checking: return "building.columns"
        case .savings: return "banknote"
        case .brokerage: return "chart.line.uptrend.xyaxis"
        case .cryptoExchange: return "bitcoinsign.circle"
        case .wallet: return "wallet.pass"
        case .pension: return "checkmark.shield"
        case .liability: return "creditcard"
        }
    }

    /// `isPortfolioType`: brokerage, crypto exchange and wallet.
    public var isPortfolio: Bool { self == .brokerage || self == .cryptoExchange || self == .wallet }

    /// `isHoldingsOnlyPortfolioType`: crypto exchange and wallet.
    public var isHoldingsOnly: Bool { self == .cryptoExchange || self == .wallet }
}

/// Helpers over the wire account.
public enum AccountKinds {
    /// `accountLabel`: the display name, else the name.
    public static func label(_ account: OpenAPI.Account) -> String {
        if let name = account.displayName, !name.isEmpty { return name }
        return account.name
    }

    public static func kind(_ account: OpenAPI.Account) -> AccountKind? {
        AccountKind(account.type)
    }

    public static func isPortfolio(_ account: OpenAPI.Account) -> Bool {
        kind(account)?.isPortfolio ?? false
    }

    public static func isHoldingsOnly(_ account: OpenAPI.Account) -> Bool {
        kind(account)?.isHoldingsOnly ?? false
    }

    /// `!holdingsOnly && has_transactions !== false`: View transactions and the ledger show.
    public static func canViewTransactions(_ account: OpenAPI.Account) -> Bool {
        !isHoldingsOnly(account) && account.hasTransactions != false
    }

    /// `activeBrokerAccounts`: active portfolio-type accounts.
    public static func activeBrokers(_ accounts: [OpenAPI.Account]) -> [OpenAPI.Account] {
        accounts.filter { $0.isActive && isPortfolio($0) }
    }
}

/// `AccountGroupId`: the hub's groups in their fixed order.
public enum AccountGroupID: String, CaseIterable, Sendable {
    case cash
    case portfolio
    case liabilities
    case archived

    /// `accounts.group.<id>`.
    public var labelKey: String { "accounts.group.\(rawValue)" }
}

/// One group of the hub.
public struct AccountGroup: Equatable, Sendable, Identifiable {
    public let id: AccountGroupID
    public let accounts: [OpenAPI.Account]

    public init(id: AccountGroupID, accounts: [OpenAPI.Account]) {
        self.id = id
        self.accounts = accounts
    }
}

/// A sum in the display currency, computed on the server (`GET /api/accounts/totals`,
/// ADR-216). `incomplete` when `unconverted_count` is above zero: a balance partition has no
/// stored rate and was left out, never counted 1:1.
public struct AccountTotal: Equatable, Sendable {
    public let amount: Decimal
    public let incomplete: Bool

    public init(amount: Decimal, incomplete: Bool) {
        self.amount = amount
        self.incomplete = incomplete
    }
}

/// groupAccounts.ts: grouping and ordering only; the subtotals come from the server.
public enum AccountGrouping {
    /// `accountGroupId`: archived wins over the type.
    public static func groupId(_ account: OpenAPI.Account) -> AccountGroupID {
        if !account.isActive { return .archived }
        if account.type == .liability { return .liabilities }
        if AccountKinds.isPortfolio(account) { return .portfolio }
        return .cash
    }

    /// `groupAccounts`: the four groups in order, each sorted by label (locale-aware,
    /// case- and accent-insensitive, numeric) with the id as the tie-breaker; empty groups
    /// are left out.
    public static func groups(_ accounts: [OpenAPI.Account], locale: Locale) -> [AccountGroup] {
        AccountGroupID.allCases.compactMap { id in
            let members = accounts.filter { groupId($0) == id }.sorted { lhs, rhs in
                let order = AccountKinds.label(lhs).compare(
                    AccountKinds.label(rhs), options: [.caseInsensitive, .diacriticInsensitive, .numeric],
                    range: nil, locale: locale)
                if order != .orderedSame { return order == .orderedAscending }
                return lhs.id < rhs.id
            }
            return members.isEmpty ? nil : AccountGroup(id: id, accounts: members)
        }
    }
}

/// One row of `byAccount` in `GET /api/info/portfolio-summary`: its `position` row carries
/// the account's holdings value (`getBrokerAccountMetrics`).
public struct PortfolioAccountRow: Equatable, Sendable, Decodable {
    public let accountId: AccountID?
    public let contributionKind: OpenAPI.PortfolioSummaryByAccountItem.ContributionKind
    public let currentValue: Decimal

    public init(
        accountId: AccountID?, contributionKind: OpenAPI.PortfolioSummaryByAccountItem.ContributionKind,
        currentValue: Decimal
    ) {
        self.accountId = accountId
        self.contributionKind = contributionKind
        self.currentValue = currentValue
    }

    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case contributionKind = "contribution_kind"
        case currentValue
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try container.decodeIfPresent(AccountID.self, forKey: .accountId)
        contributionKind =
            try container.decodeIfPresent(
                OpenAPI.PortfolioSummaryByAccountItem.ContributionKind.self, forKey: .contributionKind)
            ?? .init(rawValue: "")
        currentValue = try container.decodeIfPresent(Decimal.self, forKey: .currentValue) ?? 0
    }
}

/// One row of `accountTotals` in `GET /api/info/portfolio-summary`: the server's profit and
/// loss of an account over every contribution kind (ADR-216).
public struct PortfolioAccountTotalsRow: Equatable, Sendable, Decodable {
    public let accountId: AccountID?
    public let oversold: Bool
    public let gainLoss: Decimal

    public init(accountId: AccountID?, oversold: Bool, gainLoss: Decimal) {
        self.accountId = accountId
        self.oversold = oversold
        self.gainLoss = gainLoss
    }

    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case oversold
        case gainLoss
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try container.decodeIfPresent(AccountID.self, forKey: .accountId)
        oversold = try container.decodeIfPresent(Bool.self, forKey: .oversold) ?? false
        gainLoss = try container.decodeIfPresent(Decimal.self, forKey: .gainLoss) ?? 0
    }
}

/// The two parts of the portfolio summary the accounts screens read.
public struct AccountPortfolioSummary: Equatable, Sendable {
    public let byAccount: [PortfolioAccountRow]
    public let accountTotals: [PortfolioAccountTotalsRow]

    public init(byAccount: [PortfolioAccountRow], accountTotals: [PortfolioAccountTotalsRow]) {
        self.byAccount = byAccount
        self.accountTotals = accountTotals
    }
}

/// `BrokerAccountMetrics`.
public struct BrokerAccountMetrics: Equatable, Sendable {
    public let holdingsValue: Decimal
    public let gainLoss: Decimal
    public let oversold: Bool
    public let hasPosition: Bool

    public init(holdingsValue: Decimal, gainLoss: Decimal, oversold: Bool, hasPosition: Bool) {
        self.holdingsValue = holdingsValue
        self.gainLoss = gainLoss
        self.oversold = oversold
        self.hasPosition = hasPosition
    }

    /// `getBrokerAccountMetrics`: the account's `position` row of `byAccount` carries the
    /// holdings value and its `accountTotals` row the profit and loss and the oversold flag,
    /// both computed on the server; `nil` without a summary.
    public static func of(_ summary: AccountPortfolioSummary?, accountId: AccountID) -> BrokerAccountMetrics? {
        guard let summary else { return nil }
        let position = summary.byAccount.first {
            $0.accountId == accountId && $0.contributionKind == .position
        }
        let totals = summary.accountTotals.first { $0.accountId == accountId }
        return BrokerAccountMetrics(
            holdingsValue: position?.currentValue ?? 0, gainLoss: totals?.gainLoss ?? 0,
            oversold: totals?.oversold ?? false, hasPosition: position != nil)
    }
}

/// The drift chip (driftBadge.ts).
public struct AccountDrift: Equatable, Sendable {
    /// "{amount} off your statement", with " · statement of {date}" when a date exists.
    public let label: String
    /// The statement is older than `staleDays`: warning tone instead of destructive.
    public let stale: Bool
    /// `accounts.driftTooltip` or `accounts.driftStaleTooltip`.
    public let tooltipKey: String
    public let statementDate: String?

    /// `STALE_STATEMENT_DAYS`.
    public static let staleDays = 45

    public init(label: String, stale: Bool, tooltipKey: String, statementDate: String?) {
        self.label = label
        self.stale = stale
        self.tooltipKey = tooltipKey
        self.statementDate = statementDate
    }

    /// `statementYmd`: the statement date of the reconcilable currency, when it reads as a day.
    public static func statementYmd(_ account: OpenAPI.Account) -> String? {
        let currency = account.reconcilableCurrency ?? account.currency
        return account.statementBalances?.first(where: { $0.currency == currency })?.balanceDate.description
    }

    /// `isStatementStale`.
    public static func isStale(_ ymd: String?, today: String) -> Bool {
        guard let ymd, let days = AccountDates.daysBetween(ymd, today) else { return false }
        return days > staleDays
    }

    /// `useDriftBadge`: `nil` without a non-zero drift.
    public static func of(
        _ account: OpenAPI.Account, today: String, settings: NativeAppSettings, strings: any Localizing
    ) -> AccountDrift? {
        guard let drift = account.drift, drift != 0 else { return nil }
        let amount = VisionFormat.currency(
            drift, code: (account.reconcilableCurrency ?? account.currency),
            locale: settings.numberFormat.locale, fractionDigits: settings.showDecimalPlaces, signed: true)
        let date = statementYmd(account)
        let stale = isStale(date, today: today)
        let base = strings.t("accounts.driftBadge", ["amount": amount])
        let label = date.map { day in
            "\(base) · \(strings.t("accounts.driftBadgeStatement", ["date": VisionFormat.appDate(day, format: settings.dateFormat)]))"
        } ?? base
        return AccountDrift(
            label: label, stale: stale, tooltipKey: stale ? "accounts.driftStaleTooltip" : "accounts.driftTooltip",
            statementDate: date)
    }
}

/// balanceProvenance.ts.
public enum AccountProvenance {
    /// "Statement of {date} plus {count} entries since" or "Sum of {count} entries"; `nil`
    /// without `post_anchor_count`.
    public static func text(_ account: OpenAPI.Account, settings: NativeAppSettings, strings: any Localizing)
        -> String?
    {
        guard let count = account.postAnchorCount else { return nil }
        if let anchor = account.anchorDate {
            return strings.tc(
                "accounts.provenance.anchored", count,
                ["date": VisionFormat.appDate(anchor, format: settings.dateFormat)])
        }
        return strings.tc("accounts.provenance.sum", count)
    }
}

/// One ledger row of `/accounts/:id` (`GET /api/transactions?include_balance=true`).
public struct AccountLedgerRow: Equatable, Sendable, Identifiable {
    public let id: TransactionID
    /// `YYYY-MM-DD`.
    public let date: String
    public let recipientName: String?
    public let memo: String?
    public let categoryName: String?
    public let amount: Decimal
    /// `currency ?? "EUR"`.
    public let currency: CurrencyCode
    /// The server's `running_balance` window.
    public let runningBalance: Decimal?
    public let balance: Decimal?

    public init(
        id: TransactionID, date: String, recipientName: String? = nil, memo: String? = nil, categoryName: String? = nil,
        amount: Decimal, currency: CurrencyCode = LedgerCurrency.eur, runningBalance: Decimal? = nil, balance: Decimal? = nil
    ) {
        self.id = id
        self.date = date
        self.recipientName = recipientName
        self.memo = memo
        self.categoryName = categoryName
        self.amount = amount
        self.currency = currency
        self.runningBalance = runningBalance
        self.balance = balance
    }

    public init(_ wire: OpenAPI.Transaction) {
        self.init(
            id: wire.id, date: wire.transactionDate.description, recipientName: wire.recipientName,
            memo: wire.memo, categoryName: wire.categoryName, amount: wire.amount,
            currency: wire.currency ?? LedgerCurrency.eur, runningBalance: wire.runningBalance,
            balance: wire.balance)
    }

    /// The Description cell: the payee, else the memo; `nil` for neither (`accounts.detail.unlabelled`).
    public var title: String? {
        if let name = recipientName, !name.isEmpty { return name }
        if let memo, !memo.isEmpty { return memo }
        return nil
    }

    /// The memo as the second line, only under a payee.
    public var subtitle: String? {
        guard let name = recipientName, !name.isEmpty, let memo, !memo.isEmpty else { return nil }
        return memo
    }
}

/// One page of the ledger.
public struct AccountLedgerPage: Equatable, Sendable {
    public let rows: [AccountLedgerRow]
    public let total: Int

    public init(rows: [AccountLedgerRow], total: Int) {
        self.rows = rows
        self.total = total
    }
}

/// One row of the Upcoming planned transactions card.
public struct AccountPlannedRow: Equatable, Sendable, Identifiable {
    public let id: PlannedTransactionID
    public let date: String
    public let recipientName: String?
    public let memo: String?
    public let amount: Decimal
    public let currency: CurrencyCode?

    public init(
        id: PlannedTransactionID, date: String, recipientName: String? = nil, memo: String? = nil, amount: Decimal,
        currency: CurrencyCode? = nil
    ) {
        self.id = id
        self.date = date
        self.recipientName = recipientName
        self.memo = memo
        self.amount = amount
        self.currency = currency
    }

    public init(_ wire: OpenAPI.PlannedTransaction) {
        self.init(
            id: wire.id, date: wire.plannedDate.description, recipientName: wire.recipientName, memo: wire.memo, amount: wire.amount,
            currency: wire.currency)
    }

    /// The payee, else the memo; `nil` for neither.
    public var title: String? {
        if let name = recipientName, !name.isEmpty { return name }
        if let memo, !memo.isEmpty { return memo }
        return nil
    }
}

/// `GET /api/planned-transactions?account_id&active=true&is_executed=false&limit=5000`.
public struct AccountPlannedPage: Equatable, Sendable {
    public let rows: [AccountPlannedRow]
    public let total: Int

    public init(rows: [AccountPlannedRow], total: Int) {
        self.rows = rows
        self.total = total
    }
}

/// The sparkline's trend (`SPARK_COLOR_*`).
public enum AccountTrend: Equatable, Sendable {
    case up
    case down
    case flat
}
