import Foundation

/// A validated router location which preserves the original query spelling. `NativeRoute`
/// remains the decoded screen input; reserializing it must not rewrite saved deep links.
public struct NativeNavigationLocation: Equatable, Sendable {
    public static let home = NativeNavigationLocation("/")!
    public let raw: String
    public let route: NativeRoute

    public init?(_ raw: String) {
        guard let route = NativeRoute(raw) else { return nil }
        self.raw = raw
        let search = raw.firstIndex(of: "?").map { raw[raw.index(after: $0)...] } ?? ""
        self.route = NativeRoute(
            path: route.path,
            query: search.split(separator: "&", omittingEmptySubsequences: true).map { pair in
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                return URLQueryItem(name: Self.decode(parts[0]), value: parts.count > 1 ? Self.decode(parts[1]) : "")
            })
    }

    public var path: String { route.path }

    /// React's retired-page redirect passes `location.search` through unchanged.
    public func replacingPath(_ path: String) -> NativeNavigationLocation? {
        let search = raw.firstIndex(of: "?").map { String(raw[$0...]) } ?? ""
        return NativeNavigationLocation(path + search)
    }

    /// Deliberate query edits follow URLSearchParams, including duplicate deletion and
    /// form serialization. Navigation itself never uses this serializer.
    public func setting(_ name: String, to value: String?) -> NativeNavigationLocation? {
        let next = value.map { route.setting(name, to: $0) } ?? route.removing(name)
        return replacingQuery(next.query)
    }

    public func replacingQuery(_ query: [URLQueryItem]) -> NativeNavigationLocation? {
        let search = query.map { Self.escape($0.name) + "=" + Self.escape($0.value ?? "") }.joined(separator: "&")
        return NativeNavigationLocation(path + (search.isEmpty ? "" : "?" + search))
    }

    private static func escape(_ value: String) -> String {
        value.utf8.map { byte in
            switch byte {
            case 0x20: return "+"
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2A, 0x2D, 0x2E, 0x5F:
                return String(UnicodeScalar(byte))
            default: return String(format: "%%%02X", byte)
            }
        }.joined()
    }

    /// URLSearchParams decodes valid percent bytes independently of malformed escapes,
    /// then replaces invalid UTF-8 rather than rejecting the whole parameter.
    private static func decode(_ value: Substring) -> String {
        let bytes = Array(value.utf8)
        var decoded: [UInt8] = []
        var index = 0
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 0x25, index + 2 < bytes.count,
                let high = hex(bytes[index + 1]), let low = hex(bytes[index + 2])
            {
                decoded.append(high * 16 + low)
                index += 3
            } else {
                decoded.append(byte == 0x2B ? 0x20 : byte)
                index += 1
            }
        }
        return String(decoding: decoded, as: UTF8.self)
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 0x30...0x39: return byte - 0x30
        case 0x41...0x46: return byte - 0x41 + 10
        case 0x61...0x66: return byte - 0x61 + 10
        default: return nil
        }
    }
}
