import Foundation
import VisionNativeCore

/// The whitespace of JavaScript's `String.prototype.trim` and of `\s` in a regular
/// expression: WhiteSpace and LineTerminator.
enum JavaScriptWhitespace {
    static func contains(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// `String.prototype.trim`.
    static func trim(_ text: String) -> String {
        let scalars = text.unicodeScalars
        guard let first = scalars.firstIndex(where: { !contains($0) }),
            let last = scalars.lastIndex(where: { !contains($0) })
        else { return "" }
        return String(scalars[first...last])
    }
}

/// `express.json()`'s `req.body`: `nil` (undefined) without a body, else the parsed JSON.
/// Like body-parser's strict mode, only an object or an array is accepted.
enum RequestBody {
    /// body-parser's own message is the JavaScript engine's, which the client never shows;
    /// the status and code are the error handler's for a forwarded 400.
    static let malformed = BackendHTTPError.validation("Malformed JSON request body")

    static func parse(_ data: Data?) throws -> JSONValue? {
        guard let data, !data.isEmpty else { return nil }
        let first = data.first { ![0x20, 0x09, 0x0A, 0x0D].contains($0) }
        guard first == UInt8(ascii: "{") || first == UInt8(ascii: "[") else { throw malformed }
        do {
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw malformed
        }
    }
}

/// zod 4's issue messages, joined the way `parseInput` (`lib/zodInput.ts`) joins them.
struct InputIssues {
    private(set) var messages: [String] = []

    /// zod's name for the type of a received value.
    static func typeName(_ value: JSONValue?) -> String {
        switch value {
        case nil: return "undefined"
        case .null?: return "null"
        case .bool?: return "boolean"
        case .int?, .double?: return "number"
        case .string?: return "string"
        case .array?: return "array"
        case .object?: return "object"
        }
    }

    static func expected(_ type: String, received value: JSONValue?) -> String {
        "Invalid input: expected \(type), received \(typeName(value))"
    }

    /// `path: message`, or the bare message at the root.
    mutating func add(_ path: String?, _ message: String) {
        messages.append(path.map { "\($0): \(message)" } ?? message)
    }

    /// Throws the 400 `parseInput` throws when any issue was found.
    func check() throws {
        if !messages.isEmpty { throw BackendHTTPError.validation(messages.joined(separator: "; ")) }
    }
}

/// A `z.object` input: unknown keys are dropped, each declared field is checked.
struct ObjectInput {
    let fields: [String: JSONValue]

    /// The object, or nil after a root issue.
    static func parse(_ value: JSONValue?, issues: inout InputIssues) -> ObjectInput? {
        guard case .object(let fields)? = value else {
            issues.add(nil, InputIssues.expected("object", received: value))
            return nil
        }
        return ObjectInput(fields: fields)
    }

    /// `z.string().optional()`.
    func optionalString(_ key: String, issues: inout InputIssues) -> String? {
        switch fields[key] {
        case nil: return nil
        case .string(let value)?: return value
        case let other:
            issues.add(key, InputIssues.expected("string", received: other))
            return nil
        }
    }

    /// `z.string().nullable().optional()`: absent and null are both nil.
    func nullableString(_ key: String, issues: inout InputIssues) -> String? {
        if case .null? = fields[key] { return nil }
        return optionalString(key, issues: &issues)
    }
}

/// A number as JavaScript's `parseInt` yields it: an integral double, possibly beyond
/// `Int64`, which SQLite then refuses where an integer is required.
struct JavaScriptInteger: Equatable, Sendable {
    let value: Double

    /// Bound as SQLite would receive the JavaScript number.
    var sqlValue: SQLValue {
        if let exact = Int64(exactly: value) { return .integer(exact) }
        return .real(value)
    }

    /// Written as `JSON.stringify` writes it.
    var json: JSONValue {
        if let exact = Int(exactly: value) { return .int(exact) }
        return .double(value)
    }

    /// `parseInt(String(raw), 10)`; nil for NaN.
    static func parse(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        var scalars = Substring(raw).unicodeScalars.drop { JavaScriptWhitespace.contains($0) }
        var negative = false
        if let sign = scalars.first, sign == "-" || sign == "+" {
            negative = sign == "-"
            scalars = scalars.dropFirst()
        }
        let digits = String(String.UnicodeScalarView(scalars.prefix { (48...57).contains($0.value) }))
        guard !digits.isEmpty, let magnitude = Double(digits) else { return nil }
        return negative ? -magnitude : magnitude
    }

    /// `parseIntClamped` of `lib/pagination.ts`.
    static func clamped(_ raw: String?, min: Double = 1, max: Double? = nil, fallback: Double) -> Self {
        guard let parsed = parse(raw), parsed.isFinite, parsed >= min else { return Self(value: fallback) }
        if let max { return Self(value: Swift.min(parsed, max)) }
        return Self(value: parsed)
    }
}

/// `{ limit, offset }` of `lib/pagination.ts`.
struct PageParams: Equatable, Sendable {
    let limit: JavaScriptInteger
    let offset: JavaScriptInteger

    /// `parseOptionalPagination`: nil when neither limit nor offset is given (an empty
    /// value counts as absent), else `parsePagination` with the cap as the limit fallback.
    static func optional(limit: String?, offset: String?, maxLimit: Double, defaultLimit: Double? = nil) -> Self? {
        func supplied(_ value: String?) -> Bool { value.map { !$0.isEmpty } ?? false }
        guard supplied(limit) || supplied(offset) else { return nil }
        return Self(
            limit: .clamped(limit, min: 1, max: maxLimit, fallback: defaultLimit ?? maxLimit),
            offset: .clamped(offset, min: 0, fallback: 0))
    }
}

/// Query parameters as the shared route helpers read them.
enum QueryInput {
    /// `parseBooleanQueryParam` of `lib/httpParams.ts`.
    static func boolean(_ raw: String?, default defaultValue: Bool) -> Bool {
        guard let raw, !raw.isEmpty else { return defaultValue }
        switch JavaScriptWhitespace.trim(raw).lowercased() {
        case "true", "1": return true
        case "false", "0": return false
        default: return defaultValue
        }
    }

    /// `activeOrAllQuery`: `all` is no filter (nil); anything else the flag, default true.
    static func activeOrAll(_ raw: String?) -> Bool? {
        raw == "all" ? nil : boolean(raw, default: true)
    }
}

/// `listBody` of `lib/pagination.ts`: `{ items, total }`, with `limit` and `offset` when the
/// request paginated.
func listBody(_ items: [JSONValue], total: Int, page: PageParams?) -> [String: JSONValue] {
    var body: [String: JSONValue] = ["items": .array(items), "total": .int(total)]
    if let page {
        body["limit"] = page.limit.json
        body["offset"] = page.offset.json
    }
    return body
}

/// `slugify` of `@vision/shared-utils`: lowercase, trim, whitespace runs to `-`, only
/// `[a-z0-9-]`, dash runs collapsed, one leading and one trailing dash removed.
func slugify(_ input: String) -> String {
    var out = String.UnicodeScalarView()
    var inWhitespace = false
    for scalar in JavaScriptWhitespace.trim(input.lowercased()).unicodeScalars {
        if JavaScriptWhitespace.contains(scalar) {
            if !inWhitespace { out.append("-") }
            inWhitespace = true
            continue
        }
        inWhitespace = false
        switch scalar {
        case "a"..."z", "0"..."9", "-": out.append(scalar)
        default: continue
        }
    }
    var slug = String(out)
    // `-+` collapses after the strip, so dashes that met across a removed character are one.
    while slug.contains("--") { slug = slug.replacingOccurrences(of: "--", with: "-") }
    if slug.hasPrefix("-") { slug.removeFirst() }
    if slug.hasSuffix("-") { slug.removeLast() }
    return slug
}

/// Ids as `lib/validation.ts` checks them.
enum RequestID {
    /// `validateId`: a number, or a string of ASCII digits, that is an integer from 1 to
    /// 2147483647.
    static func valid(_ value: JSValue) -> Double? {
        let number: Double
        switch value {
        case .number(let raw): number = raw
        case .string(let text) where !text.isEmpty && text.utf8.allSatisfy({ (48...57).contains($0) }):
            number = JavaScriptNumber.fromString(text)
        default: return nil
        }
        guard number.isFinite, number.rounded(.towardZero) == number, number >= 1, number <= 2_147_483_647 else {
            return nil
        }
        return number
    }

    /// `parseInput(z.object({ id: idSchema() }), req.params)`: the id, else the 400
    /// `id: must be a positive integer`.
    static func pathParameter(_ request: InProcessRequest) throws -> Int {
        guard let raw = request.pathParameters["id"], let id = valid(.string(raw)) else {
            throw BackendHTTPError.validation("id: must be a positive integer")
        }
        return Int(id)
    }
}
