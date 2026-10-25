import Foundation

/// The shell's storage operations over `NativeRawStateStore`: typed local keys, the backup
/// snapshot and its restore, the legacy theme, the admin token, chart layouts and the
/// allowlisted per-device dismissals and import checkpoints. The shell keeps its admission,
/// generation and restore fences around these calls.
public struct NativeShellStorage: Sendable {
    public let store: NativeRawStateStore

    public init(store: NativeRawStateStore) {
        self.store = store
    }

    // MARK: Typed local keys

    public func value(for key: NativeRawStateStore.LocalKey) async -> String? {
        await store.value(for: key)
    }

    /// `nil` removes the key.
    public func setValue(_ value: String?, for key: NativeRawStateStore.LocalKey) async throws {
        try await store.setValue(value, for: key)
    }

    // MARK: Backup

    /// The JSON text of `{ keys }` over the backup registry, as the backup bundle carries it.
    public func backupStateJSON() async throws -> String {
        let snapshot = await store.backupSnapshot()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(snapshot), as: UTF8.self)
    }

    /// A restored backup's `Object.entries(state.keys)` stored as `String(value)`; omitted keys
    /// stay; `false` when the write fails. Only an object state has a `keys` property; an
    /// array's entries are its indices and a string's its characters, as in JavaScript.
    public func restore(_ state: JSONValue) async -> Bool {
        guard case .object(let fields) = state, let keys = fields["keys"] else { return true }
        var entries: [String: String] = [:]
        switch keys {
        case .object(let values): entries = values.mapValues(Self.jsString)
        case .array(let values):
            for (index, value) in values.enumerated() { entries[String(index)] = Self.jsString(value) }
        case .string(let text):
            for (index, unit) in text.utf16.enumerated() {
                entries[String(index)] = String(utf16CodeUnits: [unit], count: 1)
            }
        case .null, .bool, .int, .double: break
        }
        guard !entries.isEmpty else { return true }
        do {
            try await store.applyRestoredLocalValues(entries)
            return true
        } catch {
            return false
        }
    }

    /// The web app's theme keys, which only a restored backup can carry now; the settings
    /// model migrates them when the theme settings hold none.
    public func legacyTheme() async -> (mode: String?, variant: String?) {
        (await store.value(for: .theme), await store.value(for: .themeVariant))
    }

    // MARK: Admin token

    /// An empty token is no token.
    public func adminToken() async -> String? {
        guard let token = await store.sessionValue(for: .adminToken), !token.isEmpty else { return nil }
        return token
    }

    /// The trimmed token, or removal for a blank one.
    public func setAdminToken(_ token: String) async {
        let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
        await store.setSessionValue(value.isEmpty ? nil : value, for: .adminToken)
    }

    // MARK: Chart layouts

    public static let maximumChartLayoutBytes = 250_000

    /// The chart layout library's text, which must be UTF-8 and at most `maximumChartLayoutBytes`.
    public static func chartLayoutValue(_ data: Data) throws -> String {
        guard data.count <= maximumChartLayoutBytes, let text = String(data: data, encoding: .utf8) else {
            throw APIError.invalidRequest("chart-layout-storage")
        }
        return text
    }

    /// Writes when `value` is non-nil, then reads; a store failure throws rather than
    /// returning an empty library.
    public func chartLayouts(writing value: String?) async throws -> String? {
        do {
            if let value { try await store.setValue(value, for: .chartLayouts) }
            return await store.value(for: .chartLayouts)
        } catch {
            throw APIError.backendUnavailable
        }
    }

    // MARK: Per-device dismissals and import checkpoints

    static func localKey(_ key: String) -> NativeRawStateStore.LocalKey? {
        switch key {
        case "vision.home.dismissedAccountInactivity": return .accountInactivity
        case "dismissed_upcoming_planned_payments": return .upcomingDismissals
        case TaxDeductionsModel.dismissalStorageKey: return .deductionDismissals
        case "vision.analysis.sqlHistory": return .analysisHistory
        default: return nil
        }
    }

    static func sessionKey(_ key: String) -> NativeRawStateStore.SessionKey? {
        switch key {
        case "vision.portfolio-import.latest-session.v1": return .portfolioSession
        case "vision.portfolio-import.latest-review-settings.v1": return .portfolioReview
        default: return nil
        }
    }

    /// The stored value parsed as JSON after an optional write of the value's serialized text;
    /// a session write of `null` removes the entry. `nil` for a key outside the allowlist, a
    /// failed write or an unparsable value; an empty entry reads as `null`.
    public func webStorage(key: String, value: JSONValue?, session: Bool) async -> JSONValue? {
        let encoded = value.flatMap { try? String(data: $0.serialized(), encoding: .utf8) } ?? "null"
        do {
            let raw: String?
            if session {
                guard let sessionKey = Self.sessionKey(key) else { return nil }
                if let value { await store.setSessionValue(value == .null ? nil : encoded, for: sessionKey) }
                raw = await store.sessionValue(for: sessionKey)
            } else {
                guard let localKey = Self.localKey(key) else { return nil }
                if value != nil { try await store.setValue(encoded, for: localKey) }
                raw = await store.value(for: localKey)
            }
            let text = (raw?.isEmpty ?? true) ? "null" : raw!
            return try? JSONValue.parse(Data(text.utf8))
        } catch {
            return (try? JSONValue.parse(Data("null".utf8)))
        }
    }

    /// The dashboard's arrival flag, cleared on onboarding completion.
    public func clearDashboardArrival() async {
        await store.setSessionValue(nil, for: .dashboardArrival)
    }

    // MARK: JavaScript `String(value)`

    /// `String(value)` for a JSON value: strings verbatim, `null` as "null", numbers as
    /// JavaScript prints them, objects as "[object Object]", arrays joined with "," where
    /// `null` elements are empty.
    public static func jsString(_ value: JSONValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .int(let number): return String(number)
        case .double(let number): return jsNumber(number)
        case .string(let text): return text
        case .object: return "[object Object]"
        case .array(let items): return items.map { $0 == .null ? "" : jsString($0) }.joined(separator: ",")
        }
    }

    /// `Number.prototype.toString()` (ECMA-262 Number::toString, radix 10) over Swift's
    /// shortest round-trip digits.
    public static func jsNumber(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        let sign = value < 0 ? "-" : ""
        // Swift's description gives the shortest digits; take them apart into digits/exponent.
        let text = "\(abs(value))"
        let parts = text.lowercased().split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        var exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let pieces = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let integer = String(pieces[0])
        let fraction = pieces.count > 1 ? String(pieces[1]) : ""
        var digits = integer + fraction
        exponent += integer.count
        while digits.hasPrefix("0"), digits.count > 1 {
            digits.removeFirst()
            exponent -= 1
        }
        while digits.hasSuffix("0"), digits.count > 1 { digits.removeLast() }
        let k = digits.count
        let n = exponent
        if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 {
            let index = digits.index(digits.startIndex, offsetBy: n)
            return sign + digits[..<index] + "." + digits[index...]
        }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
        let power = n - 1
        let exponentText = (power >= 0 ? "+" : "-") + String(abs(power))
        if k == 1 { return sign + digits + "e" + exponentText }
        return sign + String(digits.first!) + "." + digits.dropFirst() + "e" + exponentText
    }
}
