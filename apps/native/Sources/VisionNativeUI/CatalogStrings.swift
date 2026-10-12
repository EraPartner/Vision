import Foundation
import VisionNativeCore

/// The web app's `t()` over the generated String Catalog (`Resources/Localizable.xcstrings`,
/// built by scripts/native-strings.ts from i18n/source). A key the catalog lacks renders as
/// the key itself, like `t()`.
///
/// The catalog is read as JSON rather than through `Bundle.localizedString`: `swift test`
/// copies an `.xcstrings` file verbatim instead of compiling it into `<language>.lproj`,
/// so Package.swift declares it with `.copy` and both build paths see the same file.
public struct CatalogStrings: Localizing {
    public let language: NativeLanguage
    private let table: [String: String]

    public init(language: NativeLanguage) {
        self.language = language
        table = Self.catalog.tables[language] ?? [:]
    }

    /// `true` when the catalog has text for `key` in this language.
    public func contains(_ key: String) -> Bool {
        table[key] != nil
    }

    public func t(_ key: String, _ variables: [String: String]) -> String {
        Placeholders.fill(table[key] ?? key, variables)
    }

    static let catalog = Catalog.load()
}

/// The subset of the String Catalog file format the generator writes.
struct Catalog: Sendable {
    let tables: [NativeLanguage: [String: String]]

    private struct File: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable { let value: String }
                let stringUnit: Unit
            }
            let localizations: [String: Localization]
        }
        let strings: [String: Entry]
    }

    static func load() -> Catalog {
        guard let url = Bundle.module.url(forResource: "Localizable", withExtension: "xcstrings"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else { return Catalog(tables: [:]) }
        var tables: [NativeLanguage: [String: String]] = [:]
        for (key, entry) in file.strings {
            for (code, localization) in entry.localizations {
                guard let language = NativeLanguage(rawValue: code) else { continue }
                tables[language, default: [:]][key] = localization.stringUnit.value
            }
        }
        return Catalog(tables: tables)
    }
}
