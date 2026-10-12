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
