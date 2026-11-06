import Foundation

/// PostgreSQL jsonb text semantics for SQLite: a port of
/// `apps/node-backend/src/database/sqlite/jsonb.ts` (ADR-263, ADR-270).
///
/// jsonb columns hold PostgreSQL's canonical jsonb output, so equal documents are equal
/// text: the last duplicate key wins, keys order by UTF-8 length then bytes, separators are
/// `", "` and `": "`, numbers print as `numeric` (1.50 stays 1.50, 1e2 is 100), and strings
/// escape `"`, `\`, \b \f \n \r \t and other control characters. Invalid JSON raises 22P02,
/// a `\u0000` escape 22P05 and a number outside the numeric range 22003.
public indirect enum JsonbValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(ExactDecimal)
    case string(String)
    case array([JsonbValue])
    /// Entries in canonical key order, duplicates removed.
    case object([(key: String, value: JsonbValue)])

    public static func == (lhs: JsonbValue, rhs: JsonbValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.number(let a), .number(let b)): return a == b
        case (.string(let a), .string(let b)): return a == b
        case (.array(let a), .array(let b)): return a == b
        case (.object(let a), .object(let b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.key == $1.key && $0.value == $1.value }
        default: return false
        }
    }

    var isContainer: Bool {
        switch self {
        case .array, .object: return true
        default: return false
        }
    }
}

public enum SQLJsonb {
    private static func invalid(_ detail: String) -> SQLStateError {
        SQLStateError("invalid input syntax for type json: \(detail)", code: "22P02")
    }

    /// jsonb key order: shorter UTF-8 first, then bytewise.
    public static func compareKeys(_ a: String, _ b: String) -> Int {
        if a == b { return 0 }
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        if x.count != y.count { return x.count < y.count ? -1 : 1 }
        for index in 0..<x.count where x[index] != y[index] { return x[index] < y[index] ? -1 : 1 }
        return 0
    }

    /// Nesting limit, so a hostile document cannot exhaust the stack.
    static let maxDepth = 6400

    /// The parser walks UTF-16 code units, as the JavaScript original does.
    private struct Parser {
        let text: [UInt16]
        var pos = 0

        init(_ text: String) { self.text = Array(text.utf16) }

        func at(_ k: Int) -> UInt16? { k < text.count ? text[k] : nil }

        mutating func parseDocument() throws -> JsonbValue {
            skipSpace()
            let value = try parseValue(0)
            skipSpace()
            if pos < text.count { throw invalid("unexpected text at offset \(pos)") }
            return value
        }

        mutating func skipSpace() {
            while let c = at(pos), c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { pos += 1 }
        }

        mutating func parseValue(_ depth: Int) throws -> JsonbValue {
            if depth > maxDepth { throw SQLStateError("jsonb nesting is too deep", code: "54001") }
            switch at(pos) {
            case 0x7B: return try parseObject(depth)  // {
            case 0x5B: return try parseArray(depth)  // [
            case 0x22: return .string(try parseString())  // "
            case 0x74: return try literal("true", .bool(true))
            case 0x66: return try literal("false", .bool(false))
            case 0x6E: return try literal("null", .null)
            default: return try parseNumber()
            }
        }

        static func isWordUnit(_ c: UInt16?, allowDot: Bool = false) -> Bool {
            guard let c else { return false }
            return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
                || (allowDot && c == 0x2E)
        }

        mutating func literal(_ word: String, _ value: JsonbValue) throws -> JsonbValue {
            let units = Array(word.utf16)
            guard pos + units.count <= text.count, Array(text[pos..<(pos + units.count)]) == units else {
                throw invalid("unexpected token at offset \(pos)")
            }
            pos += units.count
            // A literal must not run into letters or digits ("truex", "nullnull").
            if Self.isWordUnit(at(pos)) { throw invalid("unexpected token at offset \(pos)") }
            return value
        }

        /// `-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?` anchored at `pos`.
        mutating func parseNumber() throws -> JsonbValue {
            func isDigit(_ c: UInt16?) -> Bool { c.map { $0 >= 0x30 && $0 <= 0x39 } ?? false }
            let start = pos
            var j = pos
            if at(j) == 0x2D { j += 1 }
            if at(j) == 0x30 {
                j += 1
            } else if let c = at(j), c >= 0x31 && c <= 0x39 {
                while isDigit(at(j)) { j += 1 }
            } else {
                throw invalid("unexpected token at offset \(pos)")
            }
            if at(j) == 0x2E, isDigit(at(j + 1)) {
                j += 1
                while isDigit(at(j)) { j += 1 }
            }
            if at(j) == 0x65 || at(j) == 0x45 {
                var k = j + 1
                if at(k) == 0x2B || at(k) == 0x2D { k += 1 }
                if isDigit(at(k)) {
                    while isDigit(at(k)) { k += 1 }
                    j = k
                }
            }
            pos = j
            if Self.isWordUnit(at(pos), allowDot: true) { throw invalid("unexpected token at offset \(pos)") }
            let literal = String(decoding: text[start..<j], as: UTF16.self)
            return .number(try ExactDecimal.parse(literal))
        }

        mutating func hex4() throws -> UInt16 {
            guard pos + 4 <= text.count else {
                throw invalid(#""\u" must be followed by four hexadecimal digits"#)
            }
            let digits = String(decoding: text[pos..<(pos + 4)], as: UTF16.self)
            guard digits.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }),
                let value = UInt16(digits, radix: 16)
            else { throw invalid(#""\u" must be followed by four hexadecimal digits"#) }
            pos += 4
            return value
        }

        mutating func parseString() throws -> String {
            pos += 1  // opening quote
            var out: [UInt16] = []
            while true {
                guard let c = at(pos) else { throw invalid("unterminated string") }
                if c == 0x22 {
                    pos += 1
                    return String(decoding: out, as: UTF16.self)
                }
                if c < 0x20 { throw invalid("control character in string") }
                if c != 0x5C {
                    out.append(c)
                    pos += 1
                    continue
                }
                let e = at(pos + 1)
                pos += 2
                switch e {
                case 0x22: out.append(0x22)
                case 0x5C: out.append(0x5C)
                case 0x2F: out.append(0x2F)
                case 0x62: out.append(0x08)
                case 0x66: out.append(0x0C)
                case 0x6E: out.append(0x0A)
                case 0x72: out.append(0x0D)
                case 0x74: out.append(0x09)
                case 0x75:
                    let code = try hex4()
                    if code == 0 { throw SQLStateError("unsupported Unicode escape sequence", code: "22P05") }
                    if code >= 0xD800 && code <= 0xDBFF {
                        if at(pos) != 0x5C || at(pos + 1) != 0x75 {
                            throw invalid("Unicode high surrogate must not follow a high surrogate")
                        }
                        pos += 2
                        let low = try hex4()
                        if low < 0xDC00 || low > 0xDFFF {
                            throw invalid("Unicode low surrogate must follow a high surrogate")
                        }
                        out.append(code)
                        out.append(low)
                    } else if code >= 0xDC00 && code <= 0xDFFF {
                        throw invalid("Unicode low surrogate must follow a high surrogate")
                    } else {
                        out.append(code)
                    }
                default:
                    throw invalid("invalid escape sequence")
                }
            }
        }

        mutating func parseArray(_ depth: Int) throws -> JsonbValue {
            pos += 1
            var items: [JsonbValue] = []
            skipSpace()
            if at(pos) == 0x5D {
                pos += 1
                return .array(items)
            }
            while true {
                skipSpace()
                items.append(try parseValue(depth + 1))
                skipSpace()
                let c = at(pos)
                pos += 1
                if c == 0x5D { return .array(items) }
                if c != 0x2C { throw invalid(#"expected "," or "]" at offset \#(pos - 1)"#) }
            }
        }

        mutating func parseObject(_ depth: Int) throws -> JsonbValue {
            pos += 1
            var values: [String: JsonbValue] = [:]
            skipSpace()
            if at(pos) == 0x7D {
                pos += 1
                return .object([])
            }
            while true {
                skipSpace()
                if at(pos) != 0x22 { throw invalid("expected string at offset \(pos)") }
                let key = try parseString()
                skipSpace()
                if at(pos) != 0x3A { throw invalid(#"expected ":" at offset \#(pos)"#) }
                pos += 1
                skipSpace()
                // The last duplicate wins, as in jsonb.
                values[key] = try parseValue(depth + 1)
                skipSpace()
                let c = at(pos)
                pos += 1
                if c == 0x7D { break }
                if c != 0x2C { throw invalid(#"expected "," or "}" at offset \#(pos - 1)"#) }
            }
            let entries = values.map { (key: $0.key, value: $0.value) }.sorted { compareKeys($0.key, $1.key) < 0 }
            return .object(entries)
        }
    }

    /// JSON text as a jsonb value with exact numbers and canonical key order.
    public static func parse(_ text: String) throws -> JsonbValue {
        var parser = Parser(text)
        return try parser.parseDocument()
    }

    /// PostgreSQL's escape_json().
    public static func quote(_ text: String) -> String {
        var out: [UInt16] = [0x22]
        for c in text.utf16 {
            if c >= 0x20 && c != 0x22 && c != 0x5C {
                out.append(c)
                continue
            }
            let escaped: String
            switch c {
            case 0x22: escaped = #"\""#
            case 0x5C: escaped = #"\\"#
            case 0x08: escaped = #"\b"#
            case 0x0C: escaped = #"\f"#
            case 0x0A: escaped = #"\n"#
            case 0x0D: escaped = #"\r"#
            case 0x09: escaped = #"\t"#
            default:
                let hex = String(c, radix: 16)
                escaped = #"\u"# + String(repeating: "0", count: 4 - hex.count) + hex
            }
            out.append(contentsOf: escaped.utf16)
        }
        out.append(0x22)
        return String(decoding: out, as: UTF16.self)
    }

    /// jsonb_out(): the canonical text of a jsonb value.
    public static func format(_ value: JsonbValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return number.description
        case .string(let text): return quote(text)
        case .array(let items): return "[" + items.map(format).joined(separator: ", ") + "]"
        case .object(let entries):
            return "{" + entries.map { quote($0.key) + ": " + format($0.value) }.joined(separator: ", ") + "}"
        }
    }

    /// `x::jsonb::text`.
    public static func canonicalText(_ text: String) throws -> String { format(try parse(text)) }

    public static func isCanonicalText(_ text: String) -> Bool { (try? canonicalText(text)) == text }

    private static func scalarEqual(_ a: JsonbValue, _ b: JsonbValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.number(let x), .number(let y)): return ExactDecimal.compare(x, y) == 0
        case (.string(let x), .string(let y)): return x == y
        default: return false
        }
    }

    private static func sameKind(_ a: JsonbValue, _ b: JsonbValue) -> Bool {
        switch (a, b) {
        case (.array, .array), (.object, .object): return true
        default: return false
        }
    }

    /// JsonbDeepContains() below the top level.
    private static func deepContains(_ a: JsonbValue, _ b: JsonbValue) -> Bool {
        switch a {
        case .object(let have):
            guard case .object(let want) = b else { return false }
            for entry in want {
                guard let found = have.first(where: { $0.key == entry.key })?.value else { return false }
                if entry.value.isContainer {
                    if !sameKind(found, entry.value) || !deepContains(found, entry.value) { return false }
                } else if !scalarEqual(found, entry.value) {
                    return false
                }
            }
            return true
        case .array(let have):
            guard case .array(let want) = b else { return false }
            return want.allSatisfy { item in
                item.isContainer
                    ? have.contains { sameKind($0, item) && deepContains($0, item) }
                    : have.contains { !$0.isContainer && scalarEqual($0, item) }
            }
        default:
            return !b.isContainer && scalarEqual(a, b)
        }
    }

    /// `a @> b`. At the top level an array also contains a bare scalar it holds.
    public static func contains(_ a: JsonbValue, _ b: JsonbValue) -> Bool {
        if case .array(let items) = a, !b.isContainer {
            return items.contains { !$0.isContainer && scalarEqual($0, b) }
        }
        return deepContains(a, b)
    }

    public static func contains(_ a: String, _ b: String) throws -> Bool {
        contains(try parse(a), try parse(b))
    }
}
