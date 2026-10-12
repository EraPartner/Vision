import Foundation

/// The `t(key, vars)` of the web app for native screens. `VisionNativeUI.CatalogStrings`
/// reads the generated String Catalog; tests use a dictionary.
public protocol Localizing: Sendable {
    var language: NativeLanguage { get }
    /// The text for `key` with its `{name}` placeholders filled in; the key itself when
    /// the catalog has no text.
    func t(_ key: String, _ variables: [String: String]) -> String
}

extension Localizing {
    public func t(_ key: String) -> String { t(key, [:]) }

    /// `tc(key, count, vars)` (LanguageHydration): `key.<category>` for the CLDR plural
    /// category of `count`, then `key.other`, then `key`; `{count}` is always filled, and a
    /// `count` among `variables` wins, as in `{ count, ...vars }`.
    public func tc(_ key: String, _ count: Int, _ variables: [String: String] = [:]) -> String {
        let filled = ["count": String(count)].merging(variables) { _, given in given }
        for candidate in ["\(key).\(PluralCategory.of(count, language: language).rawValue)", "\(key).other"] {
            // A key the table lacks comes back as itself (it holds no placeholders).
            let text = t(candidate, filled)
            if text != candidate { return text }
        }
        return t(key, filled)
    }
}

/// The CLDR plural category `Intl.PluralRules(language).select(count)` returns for an
/// integer. English and Dutch have the same cardinal rule: `one` for 1, `other` otherwise.
public enum PluralCategory: String, Sendable {
    case one
    case other

    public static func of(_ count: Int, language: NativeLanguage) -> PluralCategory {
        switch language {
        case .en, .nl: return count == 1 ? .one : .other
        }
    }
}

public enum Placeholders {
    /// `t()`'s interpolation (LanguageHydration): every `{name}` is replaced.
    public static func fill(_ text: String, _ variables: [String: String]) -> String {
        var result = text
        for name in variables.keys.sorted() {
            guard let value = variables[name] else { continue }
            result = result.replacingOccurrences(of: "{\(name)}", with: value)
        }
        return result
    }
}

/// A fixed table, for tests and previews.
public struct DictionaryStrings: Localizing {
    public let language: NativeLanguage
    private let table: [String: String]

    public init(language: NativeLanguage, table: [String: String]) {
        self.language = language
        self.table = table
    }

    public func t(_ key: String, _ variables: [String: String]) -> String {
        Placeholders.fill(table[key] ?? key, variables)
    }
}
