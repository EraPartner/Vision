import Foundation

/// The route of `/recipients` (apps/frontend/src/pages/RecipientsPage.tsx), all written with
/// replace: `show_all` and `uncategorized` (`true` or absent), `search` (the gated server
/// search) and the `sort_key` / `sort_dir` pair, both dropped when either is invalid.
public enum RecipientsRoutes {
    public static let path = "/recipients"
    public static let showAllParameter = "show_all"
    public static let uncategorizedParameter = "uncategorized"
    public static let searchParameter = "search"
    public static let sortKeyParameter = "sort_key"
    public static let sortDirParameter = "sort_dir"
    /// `RECIPIENT_SORT_KEYS`.
    public static let sortKeys = ["name", "primary_bank_account", "default_category_name", "notes", "is_active"]
    /// `SERVER_SEARCH_MIN_LENGTH`.
    public static let searchMinimumLength = 3

    public static func showAll(in route: NativeRoute) -> Bool {
        route.value(showAllParameter) == "true"
    }

    public static func uncategorized(in route: NativeRoute) -> Bool {
        route.value(uncategorizedParameter) == "true"
    }

    /// `searchParams.get("search") ?? ""`.
    public static func search(in route: NativeRoute) -> String {
        route.value(searchParameter) ?? ""
    }

    /// The sort when both halves are valid.
    public static func sort(in route: NativeRoute) -> LocalTableSort? {
        guard let key = route.value(sortKeyParameter), sortKeys.contains(key) else { return nil }
        switch route.value(sortDirParameter) {
        case "asc": return LocalTableSort(key: key, ascending: true)
        case "desc": return LocalTableSort(key: key, ascending: false)
        default: return nil
        }
    }

    /// `handleSortChange`: both set for a valid sort, both removed otherwise; the other
    /// parameters stay.
    public static func writingSort(_ sort: LocalTableSort?, to route: NativeRoute) -> [URLQueryItem] {
        guard let sort, sortKeys.contains(sort.key) else {
            return route.removing(sortKeyParameter).removing(sortDirParameter).query
        }
        return route.setting(sortKeyParameter, to: sort.key)
            .setting(sortDirParameter, to: sort.ascending ? "asc" : "desc").query
    }

    /// `gateServerSearch`: the trimmed text from 3 characters, else `""`.
    public static func gate(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count >= searchMinimumLength ? trimmed : ""
    }

    /// The name link: `/transactions?recipient_id=<id>&filter_label=<name>`.
    public static func transactionsLink(_ payee: OpenAPI.Recipient) -> String {
        NativeRoute(
            path: TransactionsRoutes.path,
            query: [
                URLQueryItem(name: "recipient_id", value: String(payee.id)),
                URLQueryItem(name: "filter_label", value: payee.name),
            ]
        ).string
    }
}

/// The cells of the payees table as `VirtualDataTable` reads them for its column filters.
public enum PayeeColumns {
    public static let name = "name"
    public static let account = "primary_bank_account"
    public static let category = "default_category_name"
    public static let notes = "notes"
    public static let status = "is_active"

    /// The raw value of a column, as the table row holds it: the usual account reads
    /// `recipientsPage.none` when empty and the notes `""`.
    public static func value(_ payee: OpenAPI.Recipient, key: String, none: String) -> TableRawValue {
        switch key {
        case name: return .text(payee.name)
        case account:
            let value = payee.primaryBankAccount ?? ""
            return .text(value.isEmpty ? none : value)
        case category: return payee.defaultCategoryName.map(TableRawValue.text) ?? .none
        case notes: return .text(payee.notes ?? "")
        case status: return .bool(payee.isActive)
        default: return .none
        }
    }

    /// The category badge: the detail of `GENERAL:DETAIL` (or the whole name), in sentence
    /// case; `nil` for none.
    public static func categoryLabel(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        let parts = name.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let general = parts[0].trimmingCharacters(in: .whitespaces)
        let detail = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        let label = detail.isEmpty ? general : detail
        guard let first = label.first else { return label }
        return String(first) + label.dropFirst().lowercased()
    }
}

/// The payees table's rows are keyed by the payee id.
extension OpenAPI.Recipient: Identifiable {}
