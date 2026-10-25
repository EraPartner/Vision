import Foundation

/// Localized shell strings from the same `i18n/source/<lang>.json` the Electron shell ships
/// (as `packaging/electron/i18n`); the app bundle carries copies in `Resources/i18n/`.
public struct ShellStrings: Sendable, Equatable {
    public let language: NativeLanguage
    private let table: [String: String]

    public init(language: NativeLanguage, table: [String: String]) {
        self.language = language
        self.table = table
    }

    /// `resolveNativeLanguage`: the persisted `nativeLanguage`, else Dutch when the preferred
    /// system language is Dutch, else English.
    public static func resolveLanguage(requested: JSONValue?, preferredLanguages: [String]) -> NativeLanguage {
        if let language = requested?.stringValue.flatMap(NativeLanguage.init(rawValue:)) { return language }
        return preferredLanguages.first?.lowercased().hasPrefix("nl") == true ? .nl : .en
    }

    /// Flat `{ key: string }` JSON; non-string values are ignored.
    public static func parseTable(_ data: Data) -> [String: String]? {
        // lint:allow string-any-dict untyped JSONSerialization result, validated on the next line
        guard let fields = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return fields.compactMapValues { $0 as? String }
    }

    /// `loadI18nAsync`: the requested language, else English, else no strings (labels then
    /// fall back to their keys or the given fallback, like `t()`).
    public static func load(language: NativeLanguage, directory: String?) -> ShellStrings {
        func table(_ name: String) -> [String: String]? {
            guard let directory else { return nil }
            let path = PathUtilities.join(directory, "\(name).json")
            guard let data = FileManager.default.contents(atPath: path) else { return nil }
            return parseTable(data)
        }
        if let localized = table(language.rawValue) { return ShellStrings(language: language, table: localized) }
        return ShellStrings(language: language, table: table(NativeLanguage.en.rawValue) ?? [:])
    }

    /// `t(key, vars, fallback)`: the translation, else the fallback, else the key; `{name}`
    /// placeholders are replaced once each.
    public func t(_ key: String, _ variables: [String: String] = [:], fallback: String? = nil) -> String {
        var text = table[key].flatMap { $0.isEmpty ? nil : $0 } ?? fallback ?? key
        for (name, value) in variables {
            if let range = text.range(of: "{\(name)}") { text.replaceSubrange(range, with: value) }
        }
        return text
    }
}
