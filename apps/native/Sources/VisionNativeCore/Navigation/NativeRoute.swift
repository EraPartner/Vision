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
        var query: [URLQueryItem] = []
        if parts.count > 1 {
            var components = URLComponents()
            // `URLSearchParams` reads `+` as a space.
            components.percentEncodedQuery = String(parts[1]).replacingOccurrences(of: "+", with: "%20")
            guard let items = components.queryItems else { return nil }
            query = items
        }
        self.init(path: path, query: query)
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

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func escape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }
}

/// The screens Vision Native draws itself; every other route shows the web app.
public enum NativeScreen: String, CaseIterable, Sendable {
    case exchangeRates

    /// The route path it replaces.
    public var path: String {
        switch self {
        case .exchangeRates: return "/admin/exchange-rates"
        }
    }

    /// Behind `RequireAdmin` in apps/frontend/src/App.tsx.
    public var requiresAdmin: Bool {
        path == "/admin" || path.hasPrefix("/admin/")
    }

    public static func screen(forPath path: String) -> NativeScreen? {
        allCases.first { $0.path == path }
    }
}
