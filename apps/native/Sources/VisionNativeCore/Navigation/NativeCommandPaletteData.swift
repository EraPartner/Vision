import Foundation

public enum NativeCommandPaletteAction: Equatable, Sendable {
    case navigate(NativeRoute)
    case newTransaction
    case theme(String)
    case settings
    case shortcuts
    case copy(String)
}

public struct NativeCommandPaletteAnswer: Equatable, Sendable {
    public enum Kind: String, Sendable { case fx, arithmetic }
    public let kind: Kind
    public let text: String
    public init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }
}

public struct NativeCommandPaletteEntry: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let symbol: String
    public let hint: String?
    public let action: NativeCommandPaletteAction
    public var quote: ResearchQuote? = nil
}

public struct NativeCommandPaletteGroup: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let entries: [NativeCommandPaletteEntry]
}

/// String-only helpers from lib/commandPalette.ts. Money parsing, calculation,
/// conversion and answer formatting are deliberately delegated to shared TypeScript.
public enum NativeCommandPaletteQueries {
    public static let recentsKey = "vision.palette.recents"

    public static func ticker(_ query: String) -> String? {
        if query.range(of: "^\\$[A-Za-z][A-Za-z0-9.-]{0,9}$", options: .regularExpression) != nil {
            return String(query.dropFirst()).uppercased()
        }
        guard query.range(of: "[A-Z]", options: .regularExpression) != nil,
            query.range(of: "^[A-Za-z]{2,5}(?:[.-][A-Za-z0-9]{1,4})?$", options: .regularExpression) != nil
        else { return nil }
        return query.uppercased()
    }

    public static func recents(_ raw: String?) -> [String] {
        guard let raw, let value = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)),
            let values = value.arrayValue
        else { return [] }
        return values.compactMap(\.stringValue)
    }

    public static func pushing(_ url: String, into recents: [String]) -> [String] {
        Array(([url] + recents.filter { $0 != url }).prefix(5))
    }

    /// cmdk's command-score match, including word/jump weighting and transpositions.
    /// Scores rank text only; this is unrelated to financial/statistical computation.
    public static func score(_ value: String, query: String) -> Double {
        let original = Array(value.utf16)
        let abbreviation = Array(query.utf16)
        func normalize(_ input: String) -> [UInt16] {
            Array(input.lowercased().replacingOccurrences(of: "[\\s-]", with: " ", options: .regularExpression).utf16)
        }
        let string = normalize(value)
        let search = normalize(query)
        let jumps = Set("\\/_+.#\"@[({&".utf16)
        func isSpace(_ code: UInt16?) -> Bool {
            guard let code, let scalar = UnicodeScalar(code) else { return false }
            return code == 45 || CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        func at(_ input: [UInt16], _ index: Int) -> UInt16? {
            input.indices.contains(index) ? input[index] : nil
        }
        var memo: [String: Double] = [:]
        func match(_ start: Int, _ depth: Int) -> Double {
            if depth == abbreviation.count { return start == original.count ? 1 : 0.99 }
            let key = "\(start),\(depth)"
            if let cached = memo[key] { return cached }
            var best = 0.0
            for position in start..<string.count where at(string, position) == at(search, depth) {
                var result = match(position + 1, depth + 1)
                if result > best {
                    if position == start {
                        result *= 1
                    } else if let previous = at(original, position - 1), jumps.contains(previous) {
                        result *= 0.8
                        if start > 0 {
                            let count = original[start..<(position - 1)].filter { jumps.contains($0) }.count
                            result *= pow(0.999, Double(count))
                        }
                    } else if isSpace(at(original, position - 1)) {
                        result *= 0.9
                        if start > 0 {
                            let count = original[start..<(position - 1)].filter { isSpace($0) }.count
                            result *= pow(0.999, Double(count))
                        }
                    } else {
                        result *= 0.17
                        if start > 0 { result *= pow(0.999, Double(position - start)) }
                    }
                    if at(original, position) != at(abbreviation, depth) { result *= 0.9999 }
                }
                if (result < 0.1 && at(string, position - 1) == at(search, depth + 1))
                    || (at(search, depth + 1) == at(search, depth)
                        && at(string, position - 1) != at(search, depth))
                {
                    result = max(result, match(position + 1, depth + 2) * 0.1)
                }
                best = max(best, result)
            }
            memo[key] = best
            return best
        }
        return match(0, 0)
    }
}
