import Foundation
import Observation

/// A holding of the Classify holdings sheet with its direct classification (ADR-267).
public typealias ClassifiableHolding = OpenAPI.PortfolioExposureClassifications.ItemsItem

/// `GET`/`PUT /api/investments/exposure/classifications`.
public protocol PortfolioClassificationService: Sendable {
    func portfolioClassifications() async throws -> OpenAPI.PortfolioExposureClassifications
    func portfolioSaveClassifications(_ changes: PortfolioClassificationChanges) async throws
        -> OpenAPI.PortfolioExposureClassifications
}

extension APIClient: PortfolioClassificationService {
    public func portfolioClassifications() async throws -> OpenAPI.PortfolioExposureClassifications {
        try await send(OpenAPIOperations.GetPortfolioExposureClassifications())
    }
    public func portfolioSaveClassifications(_ changes: PortfolioClassificationChanges) async throws
        -> OpenAPI.PortfolioExposureClassifications
    {
        try await send(OpenAPIOperations.SavePortfolioExposureClassifications(body: changes.body))
    }
}

/// One row of the sheet as the user is editing it (`Draft`, classificationChanges.ts).
public struct PortfolioClassificationDraft: Equatable, Sendable {
    public var issuerName: String
    public var sector: String
    /// ISO 3166-1 alpha-2 code; empty for none.
    public var country: String

    public init(issuerName: String = "", sector: String = "", country: String = "") {
        self.issuerName = issuerName
        self.sector = sector
        self.country = country
    }
    /// `draftOf`.
    public init(_ holding: ClassifiableHolding) {
        self.init(
            issuerName: holding.classification?.issuerName ?? "", sector: holding.classification?.sector ?? "",
            country: holding.classification?.issuerCountryCode ?? "")
    }
    /// `sameDraft`: names and sectors compare trimmed.
    public func same(as other: Self) -> Bool {
        Self.trim(issuerName) == Self.trim(other.issuerName) && Self.trim(sector) == Self.trim(other.sector)
            && country == other.country
    }
    /// `isEmptyDraft`.
    public var isEmpty: Bool { Self.trim(issuerName).isEmpty && Self.trim(sector).isEmpty && country.isEmpty }
    static func trim(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The PUT body: rows to set as manual classifications and holdings to clear.
public struct PortfolioClassificationChanges: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public let investmentId: InvestmentID
        public let issuerName: String
        public let sector: String?
        public let issuerCountryCode: String?
    }
    public var set: [Row] = []
    public var clear: [InvestmentID] = []
    public var count: Int { self.set.count + clear.count }

    /// `classificationChanges`: a row with values is set (the issuer falls back to the holding
    /// name), an emptied row that had a classification is cleared, an untouched row is left out.
    public init(holdings: [ClassifiableHolding], drafts: [InvestmentID: PortfolioClassificationDraft]) {
        for holding in holdings {
            guard let draft = drafts[holding.investmentId], !draft.same(as: PortfolioClassificationDraft(holding))
            else { continue }
            if draft.isEmpty {
                if holding.classification != nil { clear.append(holding.investmentId) }
                continue
            }
            let issuer = PortfolioClassificationDraft.trim(draft.issuerName)
            let sector = PortfolioClassificationDraft.trim(draft.sector)
            self.set.append(
                Row(
                    investmentId: holding.investmentId, issuerName: issuer.isEmpty ? holding.name : issuer,
                    sector: sector.isEmpty ? nil : sector,
                    issuerCountryCode: draft.country.isEmpty ? nil : draft.country))
        }
    }

    var body: OpenAPI.PortfolioManualClassificationChanges {
        OpenAPI.PortfolioManualClassificationChanges(
            set: self.set.map {
                .init(
                    investmentId: $0.investmentId, issuerName: $0.issuerName, sector: $0.sector,
                    issuerCountryCode: $0.issuerCountryCode)
            },
            clear: clear.map(\.rawValue))
    }
}

/// `countryOptions` (CountryCombobox.tsx): ISO 3166-1 alpha-2 regions the system can name in
/// `locale`, sorted by name. Built from the system's region names so Vision ships no country
/// table; private-use and reserved codes are left out.
public enum PortfolioCountryOptions {
    public struct Option: Equatable, Sendable, Identifiable {
        public var id: String { code }
        public let code: String
        public let name: String
    }
    private static let excluded: Set<String> = {
        var codes: Set<String> = ["AA", "ZZ", "EU", "EZ", "UN"]
        for letter in "MNOPQRSTUVWXYZ" { codes.insert("Q\(letter)") }
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" { codes.insert("X\(letter)") }
        return codes
    }()
    public static func options(locale: Locale) -> [Option] {
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        var options: [Option] = []
        for first in letters {
            for second in letters {
                let code = "\(first)\(second)"
                guard !excluded.contains(code), let name = locale.localizedString(forRegionCode: code),
                    name != code
                else { continue }
                options.append(Option(code: code, name: name))
            }
        }
        return options.sorted { $0.name.compare($1.name, locale: locale) == .orderedAscending }
    }
}

/// The Classify holdings sheet (ClassifyHoldingsDialog.tsx): one holding from its row menu or
/// every holding from the exposure card, with search, multi-select and bulk apply.
@MainActor
@Observable
public final class PortfolioClassificationModel {
    /// GICS sector names offered next to the sectors already in use.
    public static let standardSectors = [
        "Communication Services", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials",
        "Health Care", "Industrials", "Information Technology", "Materials", "Real Estate", "Utilities",
    ]

    public private(set) var isPresented = false
    /// The holdings the sheet is limited to; `nil` for all.
    public private(set) var investmentIds: [InvestmentID]?
    public private(set) var data: OpenAPI.PortfolioExposureClassifications?
    /// `apiErrorToMessage` of the failed read or save.
    public private(set) var loadError: String?
    public private(set) var saveError: String?
    /// Humanizes failures; the editing model passes the app strings.
    public var strings: any Localizing = DictionaryStrings(language: .en, table: [:])
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public var drafts: [InvestmentID: PortfolioClassificationDraft] = [:]
    public var selected: Set<InvestmentID> = []
    public var search = ""
    public var bulkSector = ""
    public var bulkCountry = ""

    @ObservationIgnored private let service: any PortfolioClassificationService
    @ObservationIgnored private var revision = UUID()

    public init(service: any PortfolioClassificationService) {
        self.service = service
    }

    /// The row menu passes one holding; the exposure card passes none (all holdings).
    public func open(investmentIds: [InvestmentID]? = nil) async {
        reset()
        self.investmentIds = investmentIds
        isPresented = true
        await load()
    }
    /// Closing drops every edit, as the dialog's `open` effect does.
    public func close() {
        isPresented = false
        reset()
    }
    private func reset() {
        revision = UUID()
        drafts = [:]
        selected = []
        search = ""
        bulkSector = ""
        bulkCountry = ""
        saveError = nil
        isSaving = false
    }

    /// Imports change classifications; an open sheet reads them again.
    public func invalidate() async {
        guard isPresented else { return }
        await load()
    }

    private func load() async {
        let token = UUID()
        revision = token
        isLoading = true
        loadError = nil
        do {
            let value = try await service.portfolioClassifications()
            guard token == revision else { return }
            data = value
        } catch {
            guard token == revision else { return }
            loadError = PortfolioEditingModel.message(error, strings: strings)
        }
        isLoading = false
    }

    public var single: Bool { investmentIds?.count == 1 }
    public var holdings: [ClassifiableHolding] {
        let all = data?.items ?? []
        guard let investmentIds else { return all }
        return all.filter { investmentIds.contains($0.investmentId) }
    }
    /// Search matches the name, symbol and the holding's stored sector.
    public func visible(locale: Locale) -> [ClassifiableHolding] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: locale)
        guard !needle.isEmpty else { return holdings }
        return holdings.filter { holding in
            [holding.name, holding.symbol ?? "", PortfolioClassificationDraft(holding).sector]
                .joined(separator: " ").lowercased(with: locale).contains(needle)
        }
    }
    public func sectorSuggestions(locale: Locale) -> [String] {
        Array(Set((data?.sectors ?? []) + Self.standardSectors))
            .sorted { $0.compare($1, locale: locale) == .orderedAscending }
    }

    public var changes: PortfolioClassificationChanges {
        PortfolioClassificationChanges(holdings: holdings, drafts: drafts)
    }
    public var hasUnsavedChanges: Bool { isPresented && changes.count > 0 }

    public func draft(for holding: ClassifiableHolding) -> PortfolioClassificationDraft {
        drafts[holding.investmentId] ?? PortfolioClassificationDraft(holding)
    }
    public func isChanged(_ holding: ClassifiableHolding) -> Bool {
        !draft(for: holding).same(as: PortfolioClassificationDraft(holding))
    }
    public func update(_ holding: ClassifiableHolding, _ change: (inout PortfolioClassificationDraft) -> Void) {
        var draft = draft(for: holding)
        change(&draft)
        drafts[holding.investmentId] = draft
    }
    public func clear(_ holding: ClassifiableHolding) {
        drafts[holding.investmentId] = PortfolioClassificationDraft()
    }
    /// `applyToSelected`: the bulk sector and country fill every selected holding.
    public func applyToSelected() {
        let sector = PortfolioClassificationDraft.trim(bulkSector)
        for holding in holdings where selected.contains(holding.investmentId) {
            update(holding) { draft in
                if !sector.isEmpty { draft.sector = sector }
                if !bulkCountry.isEmpty { draft.country = bulkCountry }
            }
        }
    }
    public var canApplyToSelected: Bool {
        !PortfolioClassificationDraft.trim(bulkSector).isEmpty || !bulkCountry.isEmpty
    }
    public func allVisibleSelected(locale: Locale) -> Bool {
        let visible = visible(locale: locale)
        return !visible.isEmpty && visible.allSatisfy { selected.contains($0.investmentId) }
    }
    public func setAllVisibleSelected(_ checked: Bool, locale: Locale) {
        for holding in visible(locale: locale) {
            if checked { selected.insert(holding.investmentId) } else { selected.remove(holding.investmentId) }
        }
    }
    public func setSelected(_ holding: ClassifiableHolding, _ checked: Bool) {
        if checked { selected.insert(holding.investmentId) } else { selected.remove(holding.investmentId) }
    }

    /// Saves the changes; on success the response replaces the list and the sheet closes.
    /// Returns the number of saved changes, or `nil` when nothing was saved.
    public func save() async -> Int? {
        let changes = changes
        guard !isSaving, changes.count > 0 else { return nil }
        let token = revision
        isSaving = true
        saveError = nil
        defer { if token == revision { isSaving = false } }
        do {
            let value = try await service.portfolioSaveClassifications(changes)
            guard token == revision else { return nil }
            data = value
            close()
            return changes.count
        } catch {
            guard token == revision else { return nil }
            saveError = PortfolioEditingModel.message(error, strings: strings)
            return nil
        }
    }
}
