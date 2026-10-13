import Foundation

/// The routes of `/transactions` and `/owes` and the query parameters of `/transactions`
/// (apps/frontend/src/pages/TransactionsPage.tsx).
public enum TransactionsRoutes {
    public static let path = "/transactions"
    public static let owesPath = "/owes"
    /// `/owes` draws natively (`OwesModel`).
    public static let owesIsNative = true

    /// `new=1`: opens the Add transaction sheet, then is removed with replace.
    public static let newParameter = "new"
    /// Vision Native's stand-in for the web's `selectTransactionId` router state: the row to
    /// select and open in the inspector, removed with replace once read.
    public static let selectParameter = "id"
    public static let searchParameter = "search"
    public static let sortKeyParameter = "sort_key"
    public static let sortDirParameter = "sort_dir"
    public static let tagsParameter = "tags"

    /// The ⌘N, dock menu and `N` shortcut target (`/transactions?new=1`).
    public static let newTransactionRoute = "\(path)?\(newParameter)=1"

    /// `?transaction_id={id}`: one transaction.
    public static func transactionRoute(_ id: Int) -> String {
        "\(path)?transaction_id=\(id)"
    }

    /// `new=1` asks for the Add transaction sheet.
    public static func wantsNewTransaction(_ route: NativeRoute) -> Bool {
        route.value(newParameter) == "1"
    }

    /// The row the route asks to select, if a positive whole number.
    public static func selectedId(_ route: NativeRoute) -> Int? {
        route.value(selectParameter).flatMap(TransactionFilters.parseId)
    }

    /// The typed search the URL mirrors (`?search=`).
    public static func search(in route: NativeRoute) -> String {
        route.value(searchParameter) ?? ""
    }

    /// `sort_key` + `sort_dir`, honoured only together; a half-set pair reads as unsorted.
    public static func sort(in route: NativeRoute) -> LocalTableSort? {
        guard let direction = route.value(sortDirParameter), direction == "asc" || direction == "desc",
            let key = route.value(sortKeyParameter), !key.isEmpty
        else { return nil }
        return LocalTableSort(key: key, ascending: direction == "asc")
    }

    /// `handleSortChange`: the pair written, or both removed.
    public static func route(_ route: NativeRoute, sortedBy sort: LocalTableSort?) -> NativeRoute {
        guard let sort else { return route.removing(sortKeyParameter).removing(sortDirParameter) }
        return route.setting(sortKeyParameter, to: sort.key).setting(sortDirParameter, to: sort.ascending ? "asc" : "desc")
    }

    /// The mirrored search: written when not empty, removed otherwise.
    public static func route(_ route: NativeRoute, searching search: String) -> NativeRoute {
        search.isEmpty ? route.removing(searchParameter) : route.setting(searchParameter, to: search)
    }

    /// The banner's clear: only `sort_key` and `sort_dir` stay, and only as a pair.
    public static func clearingFilters(_ route: NativeRoute) -> NativeRoute {
        var query: [URLQueryItem] = []
        if let key = route.value(sortKeyParameter), let direction = route.value(sortDirParameter), !key.isEmpty,
            !direction.isEmpty
        {
            query = [
                URLQueryItem(name: sortKeyParameter, value: key), URLQueryItem(name: sortDirParameter, value: direction),
            ]
        }
        return NativeRoute(path: route.path, query: query)
    }

    /// Show all from a payee: a fresh filter set of `recipient_id` and `filter_label`.
    public static func showingAll(from recipientId: Int, name: String) -> NativeRoute {
        NativeRoute(
            path: path,
            query: [
                URLQueryItem(name: "recipient_id", value: String(recipientId)),
                URLQueryItem(name: "filter_label", value: name),
            ])
    }

    /// `handleAccountFilterChange`: `account_id` and `filter_label`, or both removed.
    public static func route(_ route: NativeRoute, account: (id: Int, label: String)?) -> NativeRoute {
        guard let account else { return route.removing("account_id").removing("filter_label") }
        return route.setting("account_id", to: String(account.id)).setting("filter_label", to: account.label)
    }

    /// `handleCategoryFilterChange`: `category_ids` always goes; `category_id` and
    /// `filter_label` are set or removed.
    public static func route(_ route: NativeRoute, category: (id: Int, label: String)?) -> NativeRoute {
        let base = route.removing("category_ids")
        guard let category else { return base.removing("category_id").removing("filter_label") }
        return base.setting("category_id", to: String(category.id)).setting("filter_label", to: category.label)
    }

    /// `handleDatePresetChange`.
    public static func route(
        _ route: NativeRoute, datePreset preset: TransactionDatePreset, today: PlannedDay, calendar: Calendar
    ) -> NativeRoute {
        guard let range = preset.range(today: today, calendar: calendar) else {
            return route.removing("start_date").removing("end_date")
        }
        return route.setting("start_date", to: range.start).setting("end_date", to: range.end)
    }

    /// `handleTypeChange`.
    public static func route(_ route: NativeRoute, type: TransactionTypeFilter?) -> NativeRoute {
        type.map { route.setting("transaction_type", to: $0.rawValue) } ?? route.removing("transaction_type")
    }

    /// `handleNeedsCategoryChange`.
    public static func route(_ route: NativeRoute, needsCategory: Bool) -> NativeRoute {
        needsCategory ? route.setting("uncategorised", to: "true") : route.removing("uncategorised")
    }

    /// `handleApplyQuickFilter`: the suggestion's parameters merge into the filter set; an
    /// empty value removes its key.
    public static func route(_ route: NativeRoute, applying patch: [QuickFilterParameter]) -> NativeRoute {
        patch.reduce(route) { next, parameter in
            guard let value = parameter.value, !value.isEmpty else { return next.removing(parameter.name) }
            return next.setting(parameter.name, to: value)
        }
    }
}

/// One URL parameter a search suggestion sets; `nil` removes it.
public struct QuickFilterParameter: Equatable, Sendable {
    public let name: String
    public let value: String?

    public init(_ name: String, _ value: String?) {
        self.name = name
        self.value = value
    }
}

/// `transaction_type`.
public enum TransactionTypeFilter: String, CaseIterable, Sendable {
    case income
    case expense

    /// `txPage.filter.type.{income,expense}`.
    public var labelKey: String { "txPage.filter.type.\(rawValue)" }
}

/// The Date chip's presets (`DatePreset` in transactionColumns.ts).
public enum TransactionDatePreset: String, CaseIterable, Sendable {
    case any
    case thisMonth
    case lastMonth
    case thisYear

    /// `txPage.filter.date.{preset}`.
    public var labelKey: String { "txPage.filter.date.\(rawValue)" }

    /// `datePresetRange`: inclusive `YYYY-MM-DD` bounds from the local day, `nil` for any date.
    public func range(today: PlannedDay, calendar: Calendar) -> (start: String, end: String)? {
        func day(_ year: Int, _ month: Int, _ day: Int) -> String {
            guard let date = PlannedDates.localDate(year: year, month: month, day: day, calendar: calendar) else {
                return ""
            }
            return PlannedDay(date, calendar: calendar).ymd
        }
        switch self {
        case .any:
            return nil
        case .thisMonth:
            return (day(today.year, today.month, 1), day(today.year, today.month + 1, 0))
        case .lastMonth:
            return (day(today.year, today.month - 1, 1), day(today.year, today.month, 0))
        case .thisYear:
            return (day(today.year, 1, 1), day(today.year, 12, 31))
        }
    }

    /// `datePresetFor`: the preset a range is, or `nil` for a custom range.
    public static func matching(start: String?, end: String?, today: PlannedDay, calendar: Calendar)
        -> TransactionDatePreset?
    {
        if start == nil && end == nil { return .any }
        for preset in [TransactionDatePreset.thisMonth, .lastMonth, .thisYear] {
            if let range = preset.range(today: today, calendar: calendar), range.start == start, range.end == end {
                return preset
            }
        }
        return nil
    }
}

/// The URL filters of `/transactions`, read like `TransactionsPage`: an id is a positive whole
/// number, a flag is the text `true`, an empty value is no filter.
public struct TransactionFilters: Equatable, Sendable {
    public var transactionId: Int?
    public var recipientId: Int?
    public var categoryId: Int?
    /// `category_ids`, a comma list; `nil` when absent or empty.
    public var categoryIds: [Int]?
    public var uncategorised = false
    public var filterLabel: String?
    public var startDate: String?
    public var endDate: String?
    public var accountId: Int?
    public var bankAccount: String?
    public var transactionType: TransactionTypeFilter?
    public var amountMin: Decimal?
    public var amountMax: Decimal?
    public var amountSigned = false
    /// `tags`, a comma list of slugs; `nil` when absent or empty.
    public var tags: [String]?

    public init() {}

    public init(route: NativeRoute) {
        func text(_ name: String) -> String? {
            guard let value = route.value(name), !value.isEmpty else { return nil }
            return value
        }
        transactionId = text("transaction_id").flatMap(Self.parseId)
        recipientId = text("recipient_id").flatMap(Self.parseId)
        categoryId = text("category_id").flatMap(Self.parseId)
        let ids = text("category_ids")?.split(separator: ",").compactMap { Self.parseId(String($0)) } ?? []
        categoryIds = ids.isEmpty ? nil : ids
        uncategorised = route.value("uncategorised") == "true"
        filterLabel = text("filter_label")
        startDate = text("start_date")
        endDate = text("end_date")
        accountId = text("account_id").flatMap(Self.parseId)
        bankAccount = text("bank_account")
        transactionType = route.value("transaction_type").flatMap(TransactionTypeFilter.init(rawValue:))
        amountMin = text("amount_min").flatMap(JSInteger.number)
        amountMax = text("amount_max").flatMap(JSInteger.number)
        amountSigned = route.value("amount_signed") == "true"
        let slugs = text("tags")?.split(separator: ",").map(String.init).filter { !$0.isEmpty } ?? []
        tags = slugs.isEmpty ? nil : slugs
    }

    /// A positive whole number (the backend's id rule); anything else is no filter.
    public static func parseId(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }), let id = Int(trimmed), id > 0,
            id <= Int(Int32.max)
        else { return nil }
        return id
    }

    public var hasAmountFilter: Bool { amountMin != nil || amountMax != nil }

    /// `hasMainFilter`: the banner's descriptor and its clear show.
    public var hasMainFilter: Bool {
        transactionId != nil || recipientId != nil || categoryId != nil || categoryIds != nil || startDate != nil
            || endDate != nil || transactionType != nil || accountId != nil || bankAccount != nil || hasAmountFilter
    }

    public var hasTagFilter: Bool { tags != nil }

    /// The banner shows for a main filter or a tag filter.
    public var showsBanner: Bool { hasMainFilter || hasTagFilter }

    /// The Date chip's preset, or `nil` for a custom range.
    public func datePreset(today: PlannedDay, calendar: Calendar) -> TransactionDatePreset? {
        TransactionDatePreset.matching(start: startDate, end: endDate, today: today, calendar: calendar)
    }

    /// `customDateLabel`: "start – end" in the app date format, `…` for an open side.
    public func customDateLabel(format: AppDateFormat) -> String? {
        guard startDate != nil || endDate != nil else { return nil }
        let start = startDate.map { VisionFormat.appDate($0, format: format) } ?? "…"
        let end = endDate.map { VisionFormat.appDate($0, format: format) } ?? "…"
        return "\(start) – \(end)"
    }

    /// `category_ids` as the API takes it.
    var categoryIdsParameter: String? {
        categoryIds.map { $0.map(String.init).joined(separator: ",") }
    }

    /// `tags` as the API takes it.
    var tagsParameter: String? {
        tags.map { $0.joined(separator: ",") }
    }
}

/// What the recipient lookup of the banner answered (`useRecipient(recipient_id)`).
public enum BannerRecipient: Equatable, Sendable {
    case loading
    case found(String)
    case failed
}

/// `FilterBanner`'s descriptor: the filter label, the scope filters (all of them unless the
/// label names the single one), the type, the date range and the amount bound, joined with
/// " · ".
public enum TransactionFilterDescriptor {
    public static func label(
        _ filters: TransactionFilters, recipient: BannerRecipient, settings: NativeAppSettings,
        strings: any Localizing
    ) -> String {
        var descriptors: [String] = []
        var scopes: [String] = []
        if let id = filters.transactionId { scopes.append(strings.t("filter.transactionId", ["id": String(id)])) }
        if let id = filters.recipientId {
            switch recipient {
            case .found(let name): scopes.append(name)
            case .failed: scopes.append(strings.t("filter.recipientUnknown"))
            case .loading: scopes.append(strings.t("filter.recipientId", ["id": String(id)]))
            }
        }
        if let id = filters.categoryId { scopes.append(strings.t("filter.categoryId", ["id": String(id)])) }
        if let ids = filters.categoryIds {
            scopes.append(strings.t("filter.categoryIds", ["count": String(ids.count)]))
        }
        if let id = filters.accountId { scopes.append(strings.t("filter.accountId", ["id": String(id)])) }
        if let name = filters.bankAccount { scopes.append(strings.t("filter.bankAccount", ["name": name])) }
        if let label = filters.filterLabel { descriptors.append(label) }
        if filters.filterLabel == nil || scopes.count != 1 { descriptors.append(contentsOf: scopes) }
        if let type = filters.transactionType {
            descriptors.append(strings.t(type == .income ? "filter.type.income" : "filter.type.expense"))
        }
        if filters.startDate != nil || filters.endDate != nil {
            let start = filters.startDate.map { VisionFormat.appDate($0, format: settings.dateFormat) } ?? "…"
            let end = filters.endDate.map { VisionFormat.appDate($0, format: settings.dateFormat) } ?? "…"
            descriptors.append("\(start) → \(end)")
        }
        if filters.hasAmountFilter { descriptors.append(amountLabel(filters, settings: settings)) }
        return descriptors.joined(separator: " · ")
    }

    /// `amountLabel`: `= x`, `x–y`, `≥ x` or `≤ y` with the default currency; signed bounds
    /// show `+` before a positive value.
    public static func amountLabel(_ filters: TransactionFilters, settings: NativeAppSettings) -> String {
        let currency = settings.defaultCurrency.isEmpty ? "EUR" : settings.defaultCurrency
        func format(_ value: Decimal) -> String {
            let text = value.formatted(
                Decimal.FormatStyle(locale: settings.numberFormat.locale).precision(.fractionLength(0...20)))
            return filters.amountSigned && value > 0 ? "+\(text)" : text
        }
        switch (filters.amountMin, filters.amountMax) {
        case (let low?, let high?):
            return low == high ? "= \(format(low)) \(currency)" : "\(format(low))–\(format(high)) \(currency)"
        case (let low?, nil):
            return "≥ \(format(low)) \(currency)"
        case (nil, let high?):
            return "≤ \(format(high)) \(currency)"
        case (nil, nil):
            return ""
        }
    }
}

/// The filter banner's Export CSV / Export JSON (`TransactionsExportButtons`): the URL filters
/// and the search, without the tag and Needs category filters, under
/// `transactions_<label-slug|filtered>_<today>.<csv|ndjson>`.
public struct TransactionExportQuery: Equatable, Sendable {
    public var filters: TransactionFilters
    public var search: String

    public init(filters: TransactionFilters, search: String) {
        self.filters = filters
        self.search = search
    }

    /// `buildFilename`.
    public func fileName(_ format: ExportFormat, today: PlannedDay) -> String {
        let slug = filters.filterLabel.map(Self.slugify) ?? ""
        let middle = slug.isEmpty ? "filtered" : slug
        let ext = format == .json ? "ndjson" : "csv"
        return "transactions_\(middle)_\(today.ymd).\(ext)"
    }

    /// `slugify`: lowercase, runs of anything but `a-z0-9` become `-`, no edge hyphens, at most
    /// 60 characters.
    static func slugify(_ label: String) -> String {
        var output = ""
        var pendingHyphen = false
        for character in label.lowercased() {
            if character.isASCII && (character.isLowercase || character.isNumber) {
                if pendingHyphen && !output.isEmpty { output.append("-") }
                pendingHyphen = false
                output.append(character)
            } else {
                pendingHyphen = true
            }
        }
        return String(output.prefix(60))
    }

    public var csv: OpenAPIOperations.ExportTransactionsCsv {
        OpenAPIOperations.ExportTransactionsCsv(
            startDate: filters.startDate, endDate: filters.endDate, accountId: filters.accountId,
            bankAccount: filters.bankAccount, categoryIds: filters.categoryIdsParameter,
            transactionId: filters.transactionId, recipientId: filters.recipientId, categoryId: filters.categoryId,
            search: search.isEmpty ? nil : search, transactionType: filters.transactionType?.rawValue,
            amountMin: filters.amountMin, amountMax: filters.amountMax, amountSigned: filters.amountSigned ? true : nil)
    }

    public var json: OpenAPIOperations.ExportTransactionsJson {
        OpenAPIOperations.ExportTransactionsJson(
            startDate: filters.startDate, endDate: filters.endDate, accountId: filters.accountId,
            bankAccount: filters.bankAccount, categoryIds: filters.categoryIdsParameter,
            transactionId: filters.transactionId, recipientId: filters.recipientId, categoryId: filters.categoryId,
            search: search.isEmpty ? nil : search, transactionType: filters.transactionType?.rawValue,
            amountMin: filters.amountMin, amountMax: filters.amountMax, amountSigned: filters.amountSigned ? true : nil)
    }
}

/// One query of the list (`transactionKeys.virtualList`): what a page request carries.
public struct TransactionListQuery: Equatable, Sendable {
    public var filters: TransactionFilters
    public var search: String
    public var sort: LocalTableSort?
    /// View › Show excluded (`showAll`): `active=false` lists excluded rows too.
    public var includeExcluded: Bool
    public var pageSize: Int

    public init(
        filters: TransactionFilters = TransactionFilters(), search: String = "", sort: LocalTableSort? = nil,
        includeExcluded: Bool = false, pageSize: Int = NativeAppSettings.defaults.defaultPageSize
    ) {
        self.filters = filters
        self.search = search
        self.sort = sort
        self.includeExcluded = includeExcluded
        self.pageSize = pageSize
    }

    /// `getTransactions({ limit, offset, active, …filters, sort_by, sort_dir, include_balance })`.
    public func operation(offset: Int) -> OpenAPIOperations.GetTransactions {
        OpenAPIOperations.GetTransactions(
            limit: pageSize, offset: offset, startDate: filters.startDate, endDate: filters.endDate,
            accountId: filters.accountId, bankAccount: filters.bankAccount, categoryId: filters.categoryId,
            recipientId: filters.recipientId, search: search.isEmpty ? nil : search, sortBy: sort?.key,
            sortDir: sort.map { $0.ascending ? "asc" : "desc" }, tags: filters.tagsParameter,
            transactionId: filters.transactionId, categoryIds: filters.categoryIdsParameter, active: !includeExcluded,
            includeBalance: true, transactionType: filters.transactionType?.rawValue, amountMin: filters.amountMin,
            amountMax: filters.amountMax, amountSigned: filters.amountSigned ? true : nil,
            uncategorised: filters.uncategorised ? true : nil)
    }
}
