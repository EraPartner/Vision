import Foundation

/// The localized fallbacks a row shows for a missing category or payee (`TableTransaction`'s
/// `t("txPage.field.uncategorized")` and `t("txPage.field.unknown")`).
public struct TransactionLabels: Equatable, Sendable {
    public let uncategorized: String
    public let unknown: String

    public init(uncategorized: String, unknown: String) {
        self.uncategorized = uncategorized
        self.unknown = unknown
    }

    public init(strings: any Localizing) {
        self.init(uncategorized: strings.t("txPage.field.uncategorized"), unknown: strings.t("txPage.field.unknown"))
    }
}

/// One loaded transaction of `/transactions` (`TableTransaction` with the wire fields Undo
/// and Duplicate need). Patches from the inspector and the row editors land here.
public struct TransactionRow: Equatable, Sendable, Identifiable {
    public let id: TransactionID
    /// `transaction_date`, `YYYY-MM-DD`.
    public var date: String
    public var memo: String?
    public var recipientId: RecipientID?
    public var recipientName: String?
    public var categoryId: CategoryID?
    public var categoryName: String?
    public var accountId: AccountID?
    /// `bank_account`: the account's canonical name.
    public var bank: String?
    public var amount: Decimal
    public var currency: CurrencyCode?
    /// The import-stamped statement balance (ADR-094), read-only.
    public var balance: Decimal?
    public var runningBalance: Decimal?
    public var comment: String?
    /// `is_active ?? true`: an excluded row is struck through.
    public var isActive: Bool
    public var tags: [OpenAPI.TransactionTagRef]
    /// `transfer_peer_id`: the paired leg, once linked as an internal transfer.
    public var transferPeerId: TransactionID?
    /// `transfer_source`: how the row became (or stays) a transfer; protected classifications
    /// (opening, adjustment, brokerage) are never relinked by hand.
    public var transferSource: String?

    public init(_ wire: OpenAPI.Transaction) {
        id = wire.id
        date = wire.transactionDate.description
        memo = wire.memo
        recipientId = wire.recipientId
        recipientName = wire.recipientName
        categoryId = wire.categoryId
        categoryName = wire.categoryName
        accountId = wire.accountId
        bank = wire.bankAccount
        amount = wire.amount
        currency = wire.currency
        balance = wire.balance
        runningBalance = wire.runningBalance
        comment = wire.comment
        isActive = wire.isActive ?? true
        tags = wire.tags ?? []
        transferPeerId = wire.transferPeerId
        transferSource = wire.transferSource
    }

    /// `applyTransactionLocalPatch` with the server's answer to a PATCH. The running balance
    /// belongs to the list query and stays.
    public mutating func merge(_ wire: OpenAPI.Transaction) {
        date = wire.transactionDate.description
        memo = wire.memo
        recipientId = wire.recipientId
        recipientName = wire.recipientName
        categoryId = wire.categoryId
        categoryName = wire.categoryName
        accountId = wire.accountId
        bank = wire.bankAccount
        amount = wire.amount
        currency = wire.currency
        balance = wire.balance
        comment = wire.comment
        if let active = wire.isActive { isActive = active }
        if let tags = wire.tags { self.tags = tags }
        transferPeerId = wire.transferPeerId
        transferSource = wire.transferSource
    }

    /// The date part of `transaction_date`.
    public var day: String {
        date.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? date
    }

    /// `tx.currency ?? "EUR"`, as the backend's running-balance window assumes.
    public var displayCurrency: CurrencyCode {
        currency ?? LedgerCurrency.eur
    }

    public func category(_ labels: TransactionLabels) -> String {
        guard let categoryName, !categoryName.isEmpty else { return labels.uncategorized }
        return categoryName
    }

    public func recipient(_ labels: TransactionLabels) -> String {
        guard let recipientName, !recipientName.isEmpty else { return labels.unknown }
        return recipientName
    }

    /// No category: the cell shows `txPage.needsCategory` with a dashed dot.
    public func isUncategorised(_ labels: TransactionLabels) -> Bool {
        categoryId == nil || category(labels) == labels.uncategorized
    }

    /// The Account cell: the account's display name, else the bank string.
    public func accountLabel(_ names: [AccountID: String]) -> String {
        if let accountId, let name = names[accountId], !name.isEmpty { return name }
        return bank ?? ""
    }

    /// Duplicate needs a payee, a date and an account (the create contract).
    public var canDuplicate: Bool {
        recipientId != nil && !date.isEmpty && !(bank ?? "").isEmpty
    }

    /// What the delete alert names: the memo, else the payee.
    public func deleteDescription(_ labels: TransactionLabels) -> String {
        if let memo, !memo.isEmpty { return memo }
        return recipient(labels)
    }

    /// `handleDuplicate`: a copy without the balance, confirmed as an intentional duplicate.
    public var duplicateBody: OpenAPI.TransactionCreate? {
        guard let recipientId, let accountId, let transactionDate = CalendarDay(day) else { return nil }
        return OpenAPI.TransactionCreate(
            transactionDate: transactionDate, accountId: accountId, recipientId: recipientId, memo: memo,
            amount: amount, currency: displayCurrency, categoryId: categoryId, comment: comment,
            tags: tags.isEmpty ? nil : tags.map(\.slug), allowDuplicate: true)
    }

    /// The delete Undo's `createTransaction`: every field of the deleted row, balance
    /// included; `nil` when the row cannot be recreated (no payee, date or account).
    public var restoreBody: OpenAPI.TransactionCreate? {
        guard let recipientId, let accountId, let transactionDate = CalendarDay(day) else { return nil }
        return OpenAPI.TransactionCreate(
            transactionDate: transactionDate, accountId: accountId, recipientId: recipientId, memo: memo,
            amount: amount, currency: currency, balance: balance, categoryId: categoryId, comment: comment,
            tags: tags.map(\.slug))
    }

    /// `getRowLabel`: "date, payee, amount" for the row's accessibility names.
    public func accessibilityLabel(_ labels: TransactionLabels, settings: NativeAppSettings) -> String {
        let amountText = VisionFormat.currency(
            amount, code: displayCurrency, locale: settings.numberFormat.locale,
            fractionDigits: settings.showDecimalPlaces)
        return accessibilityLabel(
            labels, dateText: VisionFormat.appDate(date, format: settings.dateFormat), amountText: amountText)
    }

    /// The same label from a date and an amount the caller already formatted (the row view
    /// formats them once for its cells and the label).
    public func accessibilityLabel(_ labels: TransactionLabels, dateText: String, amountText: String) -> String {
        [dateText, recipient(labels), amountText]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }

    /// `row[col.key]`, the value the client column filters read.
    public func rawValue(_ key: String, labels: TransactionLabels) -> TableRawValue {
        switch TransactionColumn(rawValue: key) {
        case .date: return .text(date)
        case .recipient: return .text(recipient(labels))
        case .category: return .text(category(labels))
        case .bank: return .text(bank ?? "")
        case .tags: return .text(tags.map(\.slug).joined(separator: ","))
        case .currency: return .text(displayCurrency.rawValue)
        case .amount: return .number(amount)
        case .runningBalance: return runningBalance.map { .number($0) } ?? .none
        case .isActive: return .bool(isActive)
        case nil: return .none
        }
    }
}

/// The table's columns after the select box (`TransactionsTable`), in order. The optional
/// ones show from the View menu.
public enum TransactionColumn: String, CaseIterable, Sendable {
    case date
    case recipient
    case category
    case bank
    case tags
    case currency
    case amount
    case runningBalance
    case isActive = "is_active"

    public var headerKey: String {
        switch self {
        case .date: return "txPage.col.date"
        case .recipient: return "txPage.col.recipient"
        case .category: return "txPage.col.category"
        case .bank: return "txPage.col.account"
        case .tags: return "txPage.col.tags"
        case .currency: return "txPage.col.currency"
        case .amount: return "txPage.col.amount"
        case .runningBalance: return "txPage.col.runningBalance"
        case .isActive: return "txPage.col.status"
        }
    }

    /// The View menu column it belongs to, if it can be hidden.
    public var optional: OptionalTransactionColumn? {
        switch self {
        case .tags: return .tags
        case .currency: return .currency
        case .runningBalance: return .runningBalance
        case .isActive: return .isActive
        default: return nil
        }
    }

    /// Tags and Running balance neither sort nor filter.
    public var sortable: Bool { self != .tags && self != .runningBalance }
    public var filterable: Bool { sortable }

    /// `defaultWidth`; the category column takes the remaining width from its minimum.
    public var width: Double {
        switch self {
        case .date: return 128
        case .recipient: return 280
        case .category: return 240
        case .bank: return 220
        case .tags: return 160
        case .currency: return 76
        case .amount: return 120
        case .runningBalance: return 130
        case .isActive: return 145
        }
    }

    public var minWidth: Double {
        switch self {
        case .date: return 104
        case .recipient: return 180
        case .category: return 240
        case .bank: return 160
        case .tags: return 120
        case .currency: return 68
        case .amount: return 90
        case .runningBalance: return 100
        case .isActive: return 130
        }
    }

    /// The columns shown for the View menu's choices.
    public static func shown(_ visibility: TransactionColumnVisibility) -> [TransactionColumn] {
        allCases.filter { column in column.optional.map { visibility.isVisible($0) } ?? true }
    }

    /// Widths for `columns` that fit `available` points next to `chrome` (select box, Edit
    /// column, padding). The category column takes the remaining width from its minimum; the
    /// other columns keep a `resized` width, else give up the shortfall from their default
    /// toward their minimum in proportion, as the web table's columns shrink with the page.
    public static func fittedWidths(
        _ columns: [TransactionColumn], resized: [String: Double], available: Double, chrome: Double
    ) -> [String: Double] {
        var result: [String: Double] = [:]
        var used = chrome
        var slack = 0.0
        for column in columns {
            if column == .category {
                used += resized[column.rawValue] ?? column.minWidth
            } else if let width = resized[column.rawValue] {
                used += width
            } else {
                used += column.width
                slack += column.width - column.minWidth
            }
        }
        let shortfall = max(0, used - available)
        let keep = slack > 0 ? max(0, 1 - shortfall / slack) : 1
        for column in columns {
            if column == .category {
                result[column.rawValue] = resized[column.rawValue] ?? column.width
            } else if let width = resized[column.rawValue] {
                result[column.rawValue] = width
            } else {
                result[column.rawValue] = column.minWidth + (column.width - column.minWidth) * keep
            }
        }
        return result
    }
}

/// `OPTIONAL_TRANSACTION_COLUMNS`: hidden by default.
public enum OptionalTransactionColumn: String, CaseIterable, Sendable {
    case tags
    case currency
    case runningBalance
    case isActive = "is_active"

    public var labelKey: String {
        switch self {
        case .tags: return "txPage.col.tags"
        case .currency: return "txPage.col.currency"
        case .runningBalance: return "txPage.col.runningBalance"
        case .isActive: return "txPage.col.status"
        }
    }
}

/// The View menu's column choices, stored per user under `widget_visibility`'s
/// `transactionsColumns` page key like `useWidgetVisibility`.
public struct TransactionColumnVisibility: Equatable, Sendable {
    public static let settingKey = SettingKey.widgetVisibility
    public static let pageKey = "transactionsColumns"

    /// The page's stored choices; a column without one uses its default (hidden).
    public var stored: [String: Bool]

    public init(stored: [String: Bool] = [:]) {
        self.stored = stored
    }

    public func isVisible(_ column: OptionalTransactionColumn) -> Bool {
        stored[column.rawValue] ?? false
    }

    /// The page's map from the whole setting.
    public static func read(_ setting: JSONValue?) -> TransactionColumnVisibility {
        var stored: [String: Bool] = [:]
        for (key, value) in setting?.objectValue?[pageKey]?.objectValue ?? [:] {
            if let flag = value.boolValue { stored[key] = flag }
        }
        return TransactionColumnVisibility(stored: stored)
    }

    /// The whole setting with this page's map written (or removed by Reset columns), the
    /// other pages' choices kept.
    public func written(into setting: JSONValue?) -> JSONValue {
        var object = setting?.objectValue ?? [:]
        if stored.isEmpty {
            object[Self.pageKey] = nil
        } else {
            object[Self.pageKey] = .object(stored.mapValues { JSONValue.bool($0) })
        }
        return .object(object)
    }
}

/// `categoryColorIndex`: the chart token (0 to 7) of a category's root, by a stable string
/// hash, so a category keeps its hue on every screen; `nil` without a root (muted).
public enum CategoryColor {
    public static let tokenCount = 8

    public static func index(_ category: String) -> Int? {
        let root = (category.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init)
            ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !root.isEmpty else { return nil }
        var hash: Int32 = 0
        for unit in root.utf16 {
            hash = hash &* 31 &+ Int32(unit)
        }
        return Int(hash.magnitude % UInt32(tokenCount))
    }
}
