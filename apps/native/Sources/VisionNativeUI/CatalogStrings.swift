import Foundation
import VisionNativeCore

/// The web app's `t()` over the generated String Catalog (`Resources/Localizable.xcstrings`,
/// built by scripts/native-strings.ts from i18n/source). A key the catalog lacks renders as
/// the key itself, like `t()`.
public struct CatalogStrings: Localizing {
    public static let table = "Localizable"

    public let language: NativeLanguage
    /// The compiled `<language>.lproj` of this module's bundle. A path rather than a
    /// `Bundle` keeps the type `Sendable`; `Bundle(path:)` returns the cached instance.
    private let localizationPath: String?

    public init(language: NativeLanguage) {
        self.language = language
        localizationPath = Bundle.module.path(forResource: language.rawValue, ofType: "lproj")
    }

    /// `true` when the catalog has text for `key` in this language.
    public func contains(_ key: String) -> Bool {
        let missing = "\u{1}missing\u{1}"
        return bundle.localizedString(forKey: key, value: missing, table: Self.table) != missing
    }

    public func t(_ key: String, _ variables: [String: String]) -> String {
        Placeholders.fill(bundle.localizedString(forKey: key, value: key, table: Self.table), variables)
    }

    private var bundle: Bundle {
        localizationPath.flatMap(Bundle.init(path:)) ?? Bundle.module
    }
}
