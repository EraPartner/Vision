import Foundation
import VisionNativeCore

/// The web app's `t()` over the generated string tables (`Resources/Strings/<language>.json`,
/// built by scripts/native-strings.ts from i18n/source). A key the table lacks renders as
/// the key itself, like `t()`.
///
/// Each language is its own flat `{ key: text }` file, read on first use of that language
/// only: the app never parses or keeps the other language.
public struct CatalogStrings: Localizing {
    public let language: NativeLanguage
    private let table: [String: String]

    public init(language: NativeLanguage) {
        self.language = language
        table = Catalog.table(language)
    }

    /// `true` when the table has text for `key` in this language.
    public func contains(_ key: String) -> Bool {
        table[key] != nil
    }

    public func t(_ key: String, _ variables: [String: String]) -> String {
        Placeholders.fill(table[key] ?? key, variables)
    }
}

/// The generated tables, each loaded once on first use.
enum Catalog {
    private static let english = load(.en)
    private static let dutch = load(.nl)

    static func table(_ language: NativeLanguage) -> [String: String] {
        switch language {
        case .en: english
        case .nl: dutch
        }
    }

    static func load(_ language: NativeLanguage) -> [String: String] {
        guard
            let url = Bundle.module.url(forResource: language.rawValue, withExtension: "json", subdirectory: "Strings"),
            let data = try? Data(contentsOf: url),
            let table = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return table
    }
}
