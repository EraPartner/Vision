import Foundation

/// A route of the web app's router: a path and its query, as `pathname + search`.
public struct NativeRoute: Equatable, Sendable {
    public static let home = NativeRoute(path: "/", query: [])
    /// `shell:route-changed` messages above this size are refused.
    public static let maximumLength = 2048

    public let path: String
    public let query: [URLQueryItem]

    public init(path: String, query: [URLQueryItem] = []) {
        self.path = path
        self.query = query
    }

    /// An app-relative route: one leading `/` (not `//`), no fragment, backslash or
    /// control character, and at most `maximumLength` bytes.
    public static func isValid(_ raw: String) -> Bool {
        guard raw.hasPrefix("/"), !raw.hasPrefix("//"), raw.utf8.count <= maximumLength else { return false }
        return !raw.unicodeScalars.contains { scalar in
            scalar.value < 0x20 || scalar.value == 0x7F || scalar == "\\" || scalar == "#"
        }
    }

    /// Parses `pathname + search`; `nil` for anything `isValid` refuses.
    public init?(_ raw: String) {
        guard Self.isValid(raw) else { return nil }
        let parts = raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(parts.first ?? "/")
        let query = parts.count > 1 ? Self.parseQuery(String(parts[1])) : []
        self.init(path: path, query: query)
    }

    /// `new URLSearchParams(search)`: pairs split on `&`, then on the first `=`; `+` is a
    /// space, and a malformed percent-escape stays as written instead of failing.
    static func parseQuery(_ search: String) -> [URLQueryItem] {
        search.split(separator: "&", omittingEmptySubsequences: true).map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = decode(parts[0])
            let value = parts.count > 1 ? decode(parts[1]) : ""
            return URLQueryItem(name: name, value: value)
        }
    }

    private static func decode(_ raw: Substring) -> String {
        let spaced = raw.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    /// `pathname + search`, with query values escaped like `URLSearchParams`.
    public var string: String {
        guard !query.isEmpty else { return path }
        let search = query.map { item in
            let name = Self.escape(item.name)
            return item.value.map { "\(name)=\(Self.escape($0))" } ?? name
        }
        return "\(path)?\(search.joined(separator: "&"))"
    }

    /// `searchParams.get(name)`: the first value.
    public func value(_ name: String) -> String? {
        query.first { $0.name == name }?.value
    }

    /// `next.set(name, value)`: replaces every value of `name` in place of the first,
    /// keeping the other parameters.
    public func setting(_ name: String, to value: String) -> NativeRoute {
        var items: [URLQueryItem] = []
        var replaced = false
        for item in query {
            if item.name == name {
                if !replaced { items.append(URLQueryItem(name: name, value: value)) }
                replaced = true
            } else {
                items.append(item)
            }
        }
        if !replaced { items.append(URLQueryItem(name: name, value: value)) }
        return NativeRoute(path: path, query: items)
    }

    /// `next.delete(name)`: removes every value of `name`, keeping the other parameters.
    public func removing(_ name: String) -> NativeRoute {
        NativeRoute(path: path, query: query.filter { $0.name != name })
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func escape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }
}

/// The screens Vision Native draws itself; every other route shows the web app.
public enum NativeScreen: Equatable, Hashable, Sendable {
    /// `/`, Home (phase 3g).
    case home
    /// `/statistics`, Insights (phase 3g).
    case statistics
    case adminOverview
    case databaseMaintenance
    /// `/admin/db/:table`, with the decoded table name.
    case tableEditor(table: String)
    case providerHealth
    case endpointLiveness
    case exchangeRates
    /// `/planned`, the first screen outside the admin section (phase 3c).
    case plannedPayments
    /// `/import`, Import & export (phase 3d).
    case importExport
    /// `/import/:batchId/review`, Review import (phase 3d part B; `ImportRoutes.reviewIsNative`).
    case importReview(batchId: Int)
    /// `/transactions` (phase 3e).
    case transactions
    /// `/owes`, Who owes you.
    case owes
    /// `/accounts`, the accounts hub (phase 3f).
    case accounts
    /// `/accounts/:id`, one account's ledger; `0` for an id that is not a positive whole number.
    case accountDetail(id: Int)
    /// `/categories`, the category tree (phase 3f part B).
    case categories
    /// `/recipients`, the payees table (phase 3f part B).
    case recipients

    /// The screens at a fixed path.
    public static let fixedScreens: [NativeScreen] = [
        .home,
        .statistics,
        .adminOverview, .databaseMaintenance, .providerHealth, .endpointLiveness, .exchangeRates, .plannedPayments,
        .importExport, .transactions, .accounts, .categories, .recipients,
    ]

    /// The route path it replaces.
    public var path: String {
        switch self {
        case .home: return InsightsRoutes.home
        case .statistics: return InsightsRoutes.statistics
        case .adminOverview: return "/admin"
        case .databaseMaintenance: return TableEditorRoute.maintenancePath
        case .tableEditor(let table): return TableEditorRoute.path(for: table)
        case .providerHealth: return "/admin/providers"
        case .endpointLiveness: return "/admin/endpoints"
        case .exchangeRates: return "/admin/exchange-rates"
        case .plannedPayments: return PlannedPaymentsRoute.path
        case .importExport: return ImportRoutes.path
        case .importReview(let batchId): return ImportRoutes.reviewPath(batchId)
        case .transactions: return TransactionsRoutes.path
        case .owes: return TransactionsRoutes.owesPath
        case .accounts: return AccountsRoutes.path
        case .accountDetail(let id): return AccountsRoutes.detailPath(id)
        case .categories: return CategoriesRoutes.path
        case .recipients: return RecipientsRoutes.path
        }
    }

    /// Behind `RequireAdmin` in apps/frontend/src/App.tsx.
    public var requiresAdmin: Bool {
        path == "/admin" || path.hasPrefix("/admin/")
    }

    public static func screen(forPath path: String) -> NativeScreen? {
        if let screen = fixedScreens.first(where: { $0.path == path }) { return screen }
        if TransactionsRoutes.owesIsNative && path == TransactionsRoutes.owesPath { return .owes }
        if let id = AccountsRoutes.detailId(forPath: path) { return .accountDetail(id: id) }
        if ImportRoutes.reviewIsNative, let batchId = ImportRoutes.reviewBatchId(forPath: path) {
            return .importReview(batchId: batchId)
        }
        return TableEditorRoute.table(forPath: path).map { NativeScreen.tableEditor(table: $0) }
    }
}
