import Foundation

/// Text functions with PostgreSQL semantics for Vision's C-locale database: a port of
/// `apps/node-backend/src/database/sqlite/text.ts` (ADR-263, ADR-270). LIKE/ILIKE, POSIX
/// regular expressions, pg_trgm similarity and C-collation ordering. Case folding and "is
/// this a letter" tests are ASCII-only, as in PostgreSQL's C locale.
public enum SQLText {
    static func asciiLower(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            scalar.value >= 65 && scalar.value <= 90 ? Unicode.Scalar(scalar.value + 32) ?? scalar : scalar
        }))
    }

    static func asciiUpper(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            scalar.value >= 97 && scalar.value <= 122 ? Unicode.Scalar(scalar.value - 32) ?? scalar : scalar
        }))
    }

    // MARK: LIKE

    /// like_escape(): rewrite a pattern with a custom escape character (none when empty) into
    /// one that escapes with `\`.
    static func likeEscape(_ pattern: String, _ escape: String) throws -> [Unicode.Scalar] {
        let source = Array(pattern.unicodeScalars)
        if escape == "\\" { return source }
        let esc = Array(escape.unicodeScalars)
        if esc.count > 1 { throw SQLStateError("invalid escape string", code: "22025") }
        var out: [Unicode.Scalar] = []
        guard let marker = esc.first else {
            for c in source {
                if c == "\\" { out.append("\\") }
                out.append(c)
            }
            return out
        }
        var afterEscape = false
        for c in source {
            if c == marker && !afterEscape {
                out.append("\\")
                afterEscape = true
            } else if c == "\\" {
                if !afterEscape { out.append("\\") }
                out.append("\\")
                afterEscape = false
            } else {
                out.append(c)
                afterEscape = false
            }
        }
        return out
    }

    private enum LikeResult {
        case matched
        case notMatched
        case abort
    }

    private static func endsWithEscape() -> SQLStateError {
        SQLStateError("LIKE pattern must not end with escape character", code: "22025")
    }

    /// MatchText() of like_match.c over code points.
    private static func matchText(
        _ t: [Unicode.Scalar], _ startT: Int, _ p: [Unicode.Scalar], _ startP: Int
    ) throws -> LikeResult {
        var ti = startT
        var pi = startP
        if p.count - pi == 1 && p[pi] == "%" { return .matched }
        while ti < t.count && pi < p.count {
            let pc = p[pi]
            if pc == "\\" {
                pi += 1
                if pi >= p.count { throw endsWithEscape() }
                if p[pi] != t[ti] { return .notMatched }
            } else if pc == "%" {
                pi += 1
                while pi < p.count {
                    if p[pi] == "%" {
                        pi += 1
                    } else if p[pi] == "_" {
                        if ti >= t.count { return .abort }
                        ti += 1
                        pi += 1
                    } else {
                        break
                    }
                }
                if pi >= p.count { return .matched }
                let first: Unicode.Scalar
                if p[pi] == "\\" {
                    if p.count - pi < 2 { throw endsWithEscape() }
                    first = p[pi + 1]
                } else {
                    first = p[pi]
                }
                while ti < t.count {
                    if t[ti] == first {
                        let matched = try matchText(t, ti, p, pi)
                        if matched != .notMatched { return matched }
                    }
                    ti += 1
                }
                return .abort
            } else if pc == "_" {
                ti += 1
                pi += 1
                continue
            } else if pc != t[ti] {
                return .notMatched
            }
            ti += 1
            pi += 1
        }
        if ti < t.count { return .notMatched }
        while pi < p.count && p[pi] == "%" { pi += 1 }
        return pi >= p.count ? .matched : .abort
    }

    /// `value LIKE pattern [ESCAPE escape]` (case-sensitive).
    public static func like(_ value: String, _ pattern: String, escape: String = "\\") throws -> Bool {
        try matchText(Array(value.unicodeScalars), 0, likeEscape(pattern, escape), 0) == .matched
    }

    /// `value ILIKE pattern [ESCAPE escape]` in the C locale: escape first, then ASCII lower().
    public static func ilike(_ value: String, _ pattern: String, escape: String = "\\") throws -> Bool {
        let p = Array(asciiLower(String(String.UnicodeScalarView(try likeEscape(pattern, escape)))).unicodeScalars)
        return try matchText(Array(asciiLower(value).unicodeScalars), 0, p, 0) == .matched
    }

    // MARK: Regular expressions

    private static let posixClasses: [String: String] = [
        "alpha": "A-Za-z", "digit": "0-9", "alnum": "A-Za-z0-9", "word": "A-Za-z0-9_", "upper": "A-Z",
        "lower": "a-z", "space": #"\x{20}\t\n\x{0B}\f\r"#, "blank": #"\x{20}\t"#,
        "punct": #"\x{21}-\x{2F}\x{3A}-\x{40}\x{5B}-\x{60}\x{7B}-\x{7E}"#, "xdigit": "0-9A-Fa-f",
        "cntrl": #"\x{00}-\x{1F}\x{7F}"#, "print": #"\x{20}-\x{7E}"#, "graph": #"\x{21}-\x{7E}"#,
    ]
    private static let space = #"\x{20}\t\n\x{0B}\f\r"#
    private static let wordClass = "[A-Za-z0-9_]"

    private static func regexError(_ pattern: String, _ detail: String) -> SQLStateError {
        SQLStateError("invalid regular expression: \(detail) in \"\(pattern)\"", code: "2201B")
    }

    private static func isAsciiLetter(_ c: Unicode.Scalar) -> Bool {
        (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
    }

    private static func otherCase(_ c: Unicode.Scalar) -> Unicode.Scalar {
        if c >= "a" && c <= "z" { return Unicode.Scalar(c.value - 32) ?? c }
        if c >= "A" && c <= "Z" { return Unicode.Scalar(c.value + 32) ?? c }
        return c
    }

    /// An ICU-escaped code point, safe inside and outside a character class.
    private static func literal(_ c: Unicode.Scalar) -> String {
        let isPlain = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_"
            || c.value >= 0x80
        return isPlain ? String(c) : "\\x{\(String(c.value, radix: 16))}"
    }

    private struct Escape {
        var pattern: String
        var next: Int
        var literal: Unicode.Scalar?
    }

    /// The ICU form of an ARE escape `\x` outside or inside brackets.
    private static func translateEscape(
        _ pattern: String, _ chars: [Unicode.Scalar], _ i: Int, inBracket: Bool
    ) throws -> Escape {
        guard i + 1 < chars.count else { throw regexError(pattern, "trailing backslash") }
        let e = chars[i + 1]
        func lit(_ c: Unicode.Scalar) -> Escape { Escape(pattern: literal(c), next: i + 2, literal: c) }
        switch e {
        case "d": return Escape(pattern: inBracket ? "0-9" : "[0-9]", next: i + 2)
        case "w": return Escape(pattern: inBracket ? "A-Za-z0-9_" : wordClass, next: i + 2)
        case "s": return Escape(pattern: inBracket ? space : "[\(space)]", next: i + 2)
        case "D", "W", "S":
            if inBracket { throw regexError(pattern, "\\\(e) inside a bracket expression") }
            let body = e == "D" ? "0-9" : (e == "W" ? "A-Za-z0-9_" : space)
            return Escape(pattern: "[^\(body)]", next: i + 2)
        case "n": return lit("\n")
        case "t": return lit("\t")
        case "r": return lit("\r")
        case "f": return lit("\u{0C}")
        case "v": return lit("\u{0B}")
        case "a": return lit("\u{07}")
        case "b": return lit("\u{08}")
        case "e": return lit("\u{1B}")
        case "x", "u", "U":
            let maximum = e == "u" ? 4 : 8
            var j = i + 2
            var hex = ""
            while hex.count < maximum, j < chars.count, chars[j].properties.isASCIIHexDigit {
                hex.unicodeScalars.append(chars[j])
                j += 1
            }
            if hex.isEmpty || (e == "u" && hex.count != 4) || (e == "U" && hex.count != 8) {
                throw regexError(pattern, "invalid \\\(e) escape")
            }
            guard let value = UInt32(hex, radix: 16), let c = Unicode.Scalar(value) else {
                throw regexError(pattern, "invalid \\\(e) escape")
            }
            return Escape(pattern: literal(c), next: j, literal: c)
        default:
            break
        }
        if !inBracket {
            let before = "(?<=\(wordClass))"
            let after = "(?=\(wordClass))"
            let notBefore = "(?<!\(wordClass))"
            let notAfter = "(?!\(wordClass))"
            switch e {
            // JavaScript's ASCII \b and \B, spelled out because ICU's are Unicode-aware.
            case "y": return Escape(pattern: "(?:\(before)\(notAfter)|\(notBefore)\(after))", next: i + 2)
            case "Y": return Escape(pattern: "(?:\(before)\(after)|\(notBefore)\(notAfter))", next: i + 2)
            case "m": return Escape(pattern: "\(notBefore)\(after)", next: i + 2)
            case "M": return Escape(pattern: "\(before)\(notAfter)", next: i + 2)
            case "A": return Escape(pattern: #"\A"#, next: i + 2)
            case "Z": return Escape(pattern: #"\z"#, next: i + 2)
            default: break
            }
            if e >= "1" && e <= "9" {
                var j = i + 1
                var digits = ""
                while j < chars.count, chars[j] >= "0", chars[j] <= "9" {
                    digits.unicodeScalars.append(chars[j])
                    j += 1
                }
                return Escape(pattern: "\\\(digits)", next: j)
            }
        }
        if isAsciiLetter(e) || (e >= "0" && e <= "9") { throw regexError(pattern, "invalid escape \\\(e)") }
        return lit(e)
    }

    /// Translates a PostgreSQL ARE into ICU syntax: POSIX classes and `\d \s \w` become ASCII
    /// classes, `.` matches a newline, `\y \Y \m \M \A \Z` map to boundaries, and
    /// case-insensitive matching folds ASCII letters only (each letter becomes `[xX]`).
    static func translateRegex(_ pattern: String, insensitive: Bool) throws -> String {
        let chars = Array(pattern.unicodeScalars)
        var ci = insensitive
        var i = 0
        if chars.count > 1, chars[0] == "(", chars[1] == "?" {
            var j = 2
            var flags: [Unicode.Scalar] = []
            while j < chars.count, chars[j] >= "a", chars[j] <= "z" {
                flags.append(chars[j])
                j += 1
            }
            if j < chars.count, chars[j] == ")", !flags.isEmpty {
                for flag in flags {
                    if flag == "i" {
                        ci = true
                    } else if flag == "c" {
                        ci = false
                    } else {
                        throw regexError(pattern, "unsupported embedded option \(flag)")
                    }
                }
                i = j + 1
            }
        }
        var out = ""
        while i < chars.count {
            let c = chars[i]
            if c == "\\" {
                let escape = try translateEscape(pattern, chars, i, inBracket: false)
                if let letter = escape.literal, ci, isAsciiLetter(letter) {
                    out += "[\(letter)\(otherCase(letter))]"
                } else {
                    out += escape.pattern
                }
                i = escape.next
            } else if c == "[" {
                let bracket = try translateBracket(pattern, chars, i, ci: ci)
                out += bracket.pattern
                i = bracket.next
            } else if ci && isAsciiLetter(c) {
                out += "[\(c)\(otherCase(c))]"
                i += 1
            } else if c == "{" {
                // A bound such as {2,4} is copied; any other brace is literal.
                let end = chars[i...].firstIndex(of: "}")
                let bound = end.map { String(String.UnicodeScalarView(chars[i...$0])) } ?? ""
                if let end, bound.range(of: #"^\{[0-9]+(,[0-9]*)?\}$"#, options: .regularExpression) != nil {
                    out += bound
                    i = end + 1
                } else {
                    out += #"\{"#
                    i += 1
                }
            } else if c == "}" || c == "]" {
                out += "\\\(c)"
                i += 1
            } else if c == "(" && i + 1 < chars.count && chars[i + 1] == "?" {
                let kind: String
                if i + 2 < chars.count, chars[i + 2] == "<" {
                    kind = "<" + (i + 3 < chars.count ? String(chars[i + 3]) : "")
                } else {
                    kind = i + 2 < chars.count ? String(chars[i + 2]) : ""
                }
                guard [":", "=", "!", "<=", "<!"].contains(kind) else {
                    throw regexError(pattern, "unsupported (? group")
                }
                out += "(?\(kind)"
                i += 2 + kind.unicodeScalars.count
            } else if c == "$" {
                // JavaScript's `$` without the m flag: the end of input only.
                out += #"\z"#
                i += 1
            } else if c == "#" || c == "&" || c == "~" || c == "-" || c == "/" || c == " " {
                out += literal(c)
                i += 1
            } else {
                out.unicodeScalars.append(c)
                i += 1
            }
        }
        return out
    }

    private static func translateBracket(
        _ pattern: String, _ chars: [Unicode.Scalar], _ start: Int, ci: Bool
    ) throws -> (pattern: String, next: Int) {
        var i = start + 1
        var negate = false
        if i < chars.count, chars[i] == "^" {
            negate = true
            i += 1
        }
        var items: [String] = []
        var letters: [Unicode.Scalar] = []
        var first = true
        func addLetterCases(_ lo: Unicode.Scalar, _ hi: Unicode.Scalar) {
            guard ci else { return }
            var code = lo.value
            while code <= hi.value && code < 128 {
                if let c = Unicode.Scalar(code), isAsciiLetter(c), !letters.contains(otherCase(c)) {
                    letters.append(otherCase(c))
                }
                code += 1
            }
        }
        /// One bracket element: a literal character, or nil for a class expansion.
        func readElement() throws -> Unicode.Scalar? {
            guard i < chars.count else { throw regexError(pattern, "unterminated bracket expression") }
            let c = chars[i]
            if c == "[", i + 1 < chars.count, chars[i + 1] == ":" {
                guard let end = chars[(i + 2)...].firstIndex(of: ":"), end + 1 < chars.count, chars[end + 1] == "]"
                else { throw regexError(pattern, "invalid character class") }
                var name = String(String.UnicodeScalarView(chars[(i + 2)..<end]))
                if ci && (name == "upper" || name == "lower") { name = "alpha" }
                guard let body = posixClasses[name] else {
                    throw regexError(pattern, "invalid character class \(name)")
                }
                items.append(body)
                i = end + 2
                return nil
            }
            if c == "[", i + 1 < chars.count, chars[i + 1] == "." || chars[i + 1] == "=" {
                let mark = chars[i + 1]
                guard let end = chars[(i + 2)...].firstIndex(of: mark), end + 1 < chars.count, chars[end + 1] == "]",
                    end == i + 3
                else { throw regexError(pattern, "unsupported collating element") }
                i = end + 2
                return chars[i - 3]
            }
            if c == "\\" {
                let escape = try translateEscape(pattern, chars, i, inBracket: true)
                i = escape.next
                if let literal = escape.literal { return literal }
                items.append(escape.pattern)
                return nil
            }
            i += 1
            return c
        }
        while true {
            guard i < chars.count else { throw regexError(pattern, "unterminated bracket expression") }
            if chars[i] == "]" && !first {
                i += 1
                break
            }
            first = false
            guard let lo = try readElement() else { continue }
            if i < chars.count, chars[i] == "-", i + 1 < chars.count, chars[i + 1] != "]" {
                i += 1
                guard let hi = try readElement() else { throw regexError(pattern, "invalid range end") }
                if lo.value > hi.value { throw regexError(pattern, "invalid character range") }
                items.append("\(literal(lo))-\(literal(hi))")
                addLetterCases(lo, hi)
            } else {
                items.append(literal(lo))
                addLetterCases(lo, lo)
            }
        }
        items.append(contentsOf: letters.map { String($0) })
        return ("[\(negate ? "^" : "")\(items.joined())]", i)
    }

    private static let regexCache = RegexCache()

    /// `value ~ pattern`, or `~*` when `insensitive`, in the C locale. An invalid pattern
    /// raises SQLSTATE 2201B.
    public static func regexpMatch(_ pattern: String, _ value: String, insensitive: Bool = false) throws -> Bool {
        let key = "\(insensitive ? "i" : "s"):\(pattern)"
        let expression: NSRegularExpression
        if let cached = regexCache.get(key) {
            expression = cached
        } else {
            let source = try translateRegex(pattern, insensitive: insensitive)
            do {
                expression = try NSRegularExpression(pattern: source, options: [.dotMatchesLineSeparators])
            } catch {
                throw regexError(pattern, error.localizedDescription)
            }
            regexCache.set(key, expression)
        }
        return expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    // MARK: Ordering

    /// Code-point order: UTF-8 byte order, PostgreSQL's C collation and SQLite's BINARY.
    public static func compareCodePoints(_ a: String, _ b: String) -> Int {
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        for index in 0..<min(x.count, y.count) where x[index] != y[index] {
            return x[index] < y[index] ? -1 : 1
        }
        return x.count == y.count ? 0 : (x.count < y.count ? -1 : 1)
    }

    // MARK: pg_trgm

    private static func isWordCharacter(_ c: Unicode.Scalar) -> Bool {
        (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z")
    }

    /// pg_trgm's trigram set of a string.
    public static func trigrams(_ input: String) -> Set<String> {
        var out = Set<String>()
        var word: [Unicode.Scalar] = []
        func flush() {
            guard !word.isEmpty else { return }
            let padded: [Unicode.Scalar] = [" ", " "] + word + [" "]
            for index in 0...(padded.count - 3) {
                out.insert(String(String.UnicodeScalarView(padded[index..<(index + 3)])))
            }
            word = []
        }
        for c in asciiLower(input).unicodeScalars {
            if isWordCharacter(c) { word.append(c) } else { flush() }
        }
        flush()
        return out
    }

    /// `show_trgm(s)`: the trigrams in PostgreSQL's byte order.
    public static func showTrgm(_ input: String) -> [String] {
        trigrams(input).sorted { compareCodePoints($0, $1) < 0 }
    }

    /// The shortest decimal that reads back as the same float4 (float4out).
    static func float4Value(_ x: Double) -> Double {
        let f = Float(x)
        if f == 0 || !f.isFinite { return Double(f) }
        for digits in 1...9 {
            let candidate = Double(String(format: "%.\(digits)g", Double(f))) ?? Double(f)
            if Float(candidate) == f { return candidate }
        }
        return Double(f)
    }

    /// `similarity(a, b)`: shared trigrams over the union, as a float4.
    public static func similarity(_ a: String, _ b: String) -> Double {
        let ta = trigrams(a)
        let tb = trigrams(b)
        if ta.isEmpty || tb.isEmpty { return 0 }
        let common = ta.intersection(tb).count
        return float4Value(Double(common) / Double(ta.count + tb.count - common))
    }
}

/// A bounded cache of compiled patterns, cleared when it grows past 2000 like the original.
// lint:allow unchecked-sendable every access holds the lock
private final class RegexCache: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: NSRegularExpression] = [:]

    func get(_ key: String) -> NSRegularExpression? {
        lock.withLock { entries[key] }
    }

    func set(_ key: String, _ value: NSRegularExpression) {
        lock.withLock {
            if entries.count > 2000 { entries.removeAll() }
            entries[key] = value
        }
    }
}
