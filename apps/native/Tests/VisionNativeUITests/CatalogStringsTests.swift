import Foundation
import Testing
import VisionNativeCore
@testable import VisionNativeUI

/// The generated String Catalog against its sources: apps/native/i18n-keys.txt and
/// i18n/source/{en,nl}.json.
@Suite struct CatalogStringsTests {
    static let nativeDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let repositoryRoot = nativeDirectory.deletingLastPathComponent().deletingLastPathComponent()

    /// `parseListFile`: one key per line, `#` starts a comment.
    static func listedKeys() throws -> [String] {
        let text = try String(contentsOf: nativeDirectory.appendingPathComponent("i18n-keys.txt"), encoding: .utf8)
        return text.split(whereSeparator: \.isNewline).compactMap { line in
            let key = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return key.isEmpty ? nil : key
        }
    }

    static func source(_ language: NativeLanguage) throws -> [String: String] {
        let url = repositoryRoot.appendingPathComponent("i18n/source/\(language.rawValue).json")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        return try #require((object as? [String: Any])?.compactMapValues { $0 as? String })
    }

    @Test(arguments: NativeLanguage.allCases)
    func everyListedKeyResolvesToItsSourceText(_ language: NativeLanguage) throws {
        let keys = try Self.listedKeys()
        #expect(keys.count > 40)
        let table = try Self.source(language)
        let strings = CatalogStrings(language: language)
        for key in keys {
            #expect(strings.contains(key), "\(language.rawValue): \(key) is missing from the catalog")
            #expect(strings.t(key) == table[key], "\(language.rawValue): \(key)")
        }
    }

    @Test func everyNativeKeyIsListed() throws {
        let keys = Set(try Self.listedKeys())
        var used = Set(NavigationRegistry.allItems.map(\.titleKey))
        used.formUnion(NavigationRegistry.sections.compactMap(\.labelKey))
        used.formUnion([NavigationRegistry.adminSection.labelKey].compactMap { $0 })
        used.formUnion([NavigationRegistry.settingsTitleKey, "nav.primary", "common.error", "common.retry"])
        used.formUnion(ExchangeRatesTab.allCases.map(\.titleKey))
        used.formUnion(AuditHistoryModel.EntryBadge.allKeys)
        used.formUnion(["admin.audit.verified", "admin.audit.partial", "admin.audit.legacy", "admin.providers.never"])
        #expect(used.subtracting(keys).isEmpty, "\(used.subtracting(keys).sorted())")
    }

    @Test func pluralKeysFollowTheCount() {
        let en = CatalogStrings(language: .en)
        let nl = CatalogStrings(language: .nl)
        #expect(en.tc("dbEditor.pendingCount", 1) == "1 pending change")
        #expect(en.tc("dbEditor.pendingCount", 3) == "3 pending changes")
        #expect(nl.tc("dbEditor.pendingCount", 1) == "1 openstaande wijziging")
        #expect(nl.tc("dbEditor.pendingCount", 2) == "2 openstaande wijzigingen")
        #expect(en.tc("dbEditor.rowsOnPage", 0) == "0 rows on this page")
        #expect(nl.tc("dbEditor.rowsOnPage", 1) == "1 rij op deze pagina")
        #expect(nl.tc("dbEditor.rowsOnPage", 100) == "100 rijen op deze pagina")
    }

    @Test func dutchDiffersFromEnglishAndPlaceholdersAreFilled() {
        let en = CatalogStrings(language: .en)
        let nl = CatalogStrings(language: .nl)
        #expect(en.t("exchangeRates.title") != nl.t("exchangeRates.title"))
        let filled = en.t("exchangeRates.fetchedAt", ["date": "09/10/2026 15:05"])
        #expect(filled.contains("09/10/2026 15:05") && !filled.contains("{date}"))
        #expect(en.t("no.such.key") == "no.such.key")
        #expect(!en.contains("no.such.key"))
    }
}
