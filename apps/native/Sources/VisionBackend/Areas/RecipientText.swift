import Foundation

/// The text rules of the recipients area: `normalizeForMatching` (`lib/textNormalization.ts`),
/// the Unicode ILIKE of `recipientRepository.ts`, and the pattern escapes and prefix
/// suggestion of `recipientPatternService.ts`.
enum RecipientText {
    /// `normalizeForMatching`: upper case, `.` and `,` as spaces, single letters dropped
    /// unless every token is one, the tokens sorted (UTF-16 order) and joined by one space.
    static func normalizeForMatching(_ name: String) -> String {
        if name.isEmpty { return name }
        let upper = JavaScriptWhitespace.trim(name).uppercased()
            .replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: ",", with: " ")
        let tokens = splitOnWhitespace(upper)
        if tokens.isEmpty { return "" }
        if tokens.count == 1 { return tokens[0] }
        let substantial = tokens.filter { token in
            token.utf16.count > 1 || !(token.utf8.count == 1 && (65...90).contains(token.utf8.first ?? 0))
        }
        return sortedUTF16(substantial.isEmpty ? tokens : substantial).joined(separator: " ")
    }

    /// `split(/\s+/).filter(Boolean)`.
    static func splitOnWhitespace(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !current.isEmpty { tokens.append(String(current)) }
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        if !current.isEmpty { tokens.append(String(current)) }
        return tokens
    }

    /// `Array.prototype.sort()` of strings: UTF-16 code unit order.
    static func sortedUTF16(_ strings: [String]) -> [String] {
        strings.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    // MARK: - Unicode ILIKE

    /// Code points grouped by their lower-case form (`caseGroups`), the three sigmas as one
    /// letter.
    static let caseGroups: [String: [String]] = {
        var groups: [String: [String]] = [:]
        for value in UInt32(0)...0x10FFFF {
            if (0xD800...0xDFFF).contains(value) { continue }
            guard let scalar = Unicode.Scalar(value) else { continue }
            let character = String(scalar)
            let lower = scalar.properties.lowercaseMapping
            if lower == character { continue }
            groups[lower, default: []].append(character)
        }
        groups["σ"] = ["Σ", "ς"]
        groups["ς"] = ["Σ", "σ"]
        return groups
    }()

    /// `areEscape`: one code point as `\uXXXX` / `\UXXXXXXXX`.
    static func areEscape(_ text: String) -> String {
        let value = text.unicodeScalars.first?.value ?? 0
        let hex = String(value, radix: 16)
        if value <= 0xFFFF { return "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex }
        return "\\U" + String(repeating: "0", count: max(0, 8 - hex.count)) + hex
    }

    /// `caseInsensitiveChar`.
    static func caseInsensitiveChar(_ scalar: Unicode.Scalar) -> String {
        let lower = scalar.properties.lowercaseMapping
        let others = (caseGroups[lower] ?? []).filter { $0 != lower }
        let lowerScalars = Array(lower.unicodeScalars)
        if lowerScalars.count > 1 {
            let sequence = lowerScalars.map(caseInsensitiveChar).joined()
            return "(?:\(sequence)|\(others.map(areEscape).joined(separator: "|")))"
        }
        if others.isEmpty { return areEscape(lower) }
        return "[" + ([lower] + others).map(areEscape).joined() + "]"
    }

    /// `unicodeIlikeRegex`: the ARE matching what `value ILIKE likePattern` matched under
    /// PostgreSQL's Unicode case folding.
    static func unicodeIlikeRegex(_ likePattern: String) -> String {
        let chars = Array(likePattern.unicodeScalars)
        var parts: [String] = []
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if char == "%" {
                parts.append(".*")
            } else if char == "_" {
                parts.append(".")
            } else if char == "\\", index + 1 < chars.count {
                index += 1
                parts.append(caseInsensitiveChar(chars[index]))
            } else {
                parts.append(caseInsensitiveChar(char))
            }
            index += 1
        }
        let anchoredStart = parts.first != ".*"
        let anchoredEnd = parts.last != ".*" || parts.count == 1
        let start = anchoredStart ? 0 : 1
        let end = max(start, anchoredEnd ? parts.count : parts.count - 1)
        return (anchoredStart ? "^" : "") + parts[start..<end].joined() + (anchoredEnd ? "$" : "")
    }

    // MARK: - Patterns

    /// `[.*+?^${}()|[\]\\]` (with `*` and `?` when `escapeWildcards`) prefixed with `\`.
    static func escapeRegExp(_ text: String, escapeWildcards: Bool) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            switch scalar {
            case ".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\":
                out.append("\\")
                out.unicodeScalars.append(scalar)
            case "*":
                out += escapeWildcards ? "\\*" : ".*"
            case "?":
                out += escapeWildcards ? "\\?" : "."
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// `buildSqlRegexPattern` and the source of `buildPatternRegExp`.
    static func patternSource(_ pattern: String, kind: String) -> String {
        switch kind {
        case RecipientPatternKind.literalPrefix: return "^" + escapeRegExp(pattern, escapeWildcards: true)
        case RecipientPatternKind.glob: return "^" + escapeRegExp(pattern, escapeWildcards: false) + "$"
        default: return pattern
        }
    }

    static let stopPatterns: Set<String> = [
        "PAYMENT", "PAYMENT TO", "PAYMENT FROM", "TRANSFER", "TRANSFER TO", "TRANSFER FROM", "SENT TO",
        "RECEIVED FROM", "FROM", "TO",
    ]

    /// `longestCommonPrefix`: in UTF-16 units, then trailing `[\s,\-.']+` trimmed.
    static func longestCommonPrefix(_ strings: [String]) -> String {
        guard let first = strings.first else { return "" }
        var prefix = Array(first.utf16)
        for string in strings.dropFirst() {
            let units = Array(string.utf16)
            while !units.starts(with: prefix) {
                prefix.removeLast()
                if prefix.isEmpty { return "" }
            }
        }
        var scalars = Array(String(decoding: prefix, as: UTF16.self).unicodeScalars)
        while let last = scalars.last,
            JavaScriptWhitespace.contains(last) || last == "," || last == "-" || last == "." || last == "'"
        {
            scalars.removeLast()
        }
        return String(String.UnicodeScalarView(scalars))
    }

    struct Suggestion: Equatable {
        let pattern: String
        let confidence: String
    }

    /// `suggestPatternFromNames`: a literal prefix of 8 or more UTF-16 units that is not a
    /// stop phrase.
    static func suggestPattern(_ names: [String]) -> Suggestion? {
        guard names.count >= 2 else { return nil }
        let prefix = longestCommonPrefix(names.map { JavaScriptWhitespace.trim($0).uppercased() })
        let length = prefix.utf16.count
        if length < 8 { return nil }
        if stopPatterns.contains(JavaScriptWhitespace.trim(prefix)) { return nil }
        return Suggestion(pattern: prefix, confidence: length >= 16 ? "high" : "medium")
    }
}

/// The `pattern_kind` values.
enum RecipientPatternKind {
    static let literalPrefix = "literal_prefix"
    static let glob = "glob"
    static let regex = "regex"
    static let all = [literalPrefix, glob, regex]
}
