import Foundation
import Testing

@testable import VisionNativeCore

private typealias Classification = ClassifiableHolding.Classification

private func holding(
    _ id: Int, _ name: String, symbol: String? = nil, sector: String? = nil, country: String? = nil,
    issuer: String? = nil, origin: Classification.Origin = .import
) -> ClassifiableHolding {
    let classification =
        issuer.map {
            Classification(
                issuerId: "issuer-\(id)", issuerName: $0, sector: sector, issuerCountryCode: country, origin: origin,
                sourceLabel: "synthetic", updatedAt: Instant(date: Date(timeIntervalSince1970: 1_793_000_000)))
        }
    return ClassifiableHolding(
        investmentId: InvestmentID(id), name: name, symbol: symbol, assetClass: "stock", hasFundDocument: false,
        classification: classification)
}

/// ADR-267 (classificationChanges.test): which rows the sheet sets, clears or leaves out.
@Suite("Classify holdings changes")
struct PortfolioClassificationChangesTests {
    @Test func setsEditedRowsClearsEmptiedOnesAndSkipsUntouchedOrUnchanged() {
        let holdings = [
            holding(1, "Alpha", sector: "Energy", country: "BE", issuer: "Alpha NV"),
            holding(2, "Beta"),
            holding(3, "Gamma", sector: "Utilities", issuer: "Gamma SA"),
            holding(4, "Delta", sector: "Materials", issuer: "Delta AG"),
        ]
        let drafts: [InvestmentID: PortfolioClassificationDraft] = [
            // Whitespace-only edits are no change.
            1: .init(issuerName: " Alpha NV ", sector: "Energy ", country: "BE"),
            // A new classification without an issuer falls back to the holding name.
            2: .init(issuerName: "  ", sector: " Financials ", country: ""),
            3: .init(),
            4: .init(issuerName: "Delta AG", sector: "Materials", country: "DE"),
        ]
        let changes = PortfolioClassificationChanges(holdings: holdings, drafts: drafts)
        #expect(
            changes.set == [
                .init(investmentId: 2, issuerName: "Beta", sector: "Financials", issuerCountryCode: nil),
                .init(investmentId: 4, issuerName: "Delta AG", sector: "Materials", issuerCountryCode: "DE"),
            ])
        #expect(changes.clear == [3])
        #expect(changes.count == 3)
        // An emptied row that never had a classification is no change.
        let none = PortfolioClassificationChanges(holdings: [holding(5, "Epsilon")], drafts: [5: .init()])
        #expect(none.count == 0)
    }

    @Test func theRequestBodyCarriesInvestmentIdsAndOmitsEmptyFields() throws {
        let changes = PortfolioClassificationChanges(
            holdings: [holding(2, "Beta"), holding(3, "Gamma", issuer: "Gamma SA")],
            drafts: [2: .init(country: "NL"), 3: .init()])
        let json = try JSONValue.parse(try APIBody.encode(changes.body))
        #expect(json["set"]?.arrayValue?.first?["investmentId"] == .int(2))
        #expect(json["set"]?.arrayValue?.first?["issuerName"] == .string("Beta"))
        #expect(json["set"]?.arrayValue?.first?["issuerCountryCode"] == .string("NL"))
        #expect(json["set"]?.arrayValue?.first?["sector"] == nil)
        #expect(json["clear"] == .array([.int(3)]))
    }

    @Test func countryOptionsAreNamedRegionsWithoutPrivateUseCodes() {
        let options = PortfolioCountryOptions.options(locale: Locale(identifier: "en_US"))
        let codes = Set(options.map(\.code))
        #expect(codes.contains("BE") && codes.contains("US"))
        #expect(codes.isDisjoint(with: ["AA", "QM", "XA", "ZZ", "EU", "UN"]))
        #expect(options.first { $0.code == "BE" }?.name == "Belgium")
        let locale = Locale(identifier: "en_US")
        #expect(options.map(\.name) == options.map(\.name).sorted { $0.compare($1, locale: locale) == .orderedAscending })
    }
}

@MainActor
@Suite("Classify holdings sheet")
struct PortfolioClassificationModelTests {
    @Test func theRowMenuLimitsTheSheetToOneHoldingAndSaveSendsOnlyChanges() async throws {
        let service = ClassificationFixtureService(items: [
            holding(1, "Alpha", symbol: "ALP"), holding(2, "Beta", sector: "Energy", issuer: "Beta NV"),
        ])
        let model = PortfolioClassificationModel(service: service)
        await model.open(investmentIds: [2])
        #expect(model.isPresented && model.single)
        #expect(model.holdings.map(\.investmentId) == [2])
        #expect(!model.hasUnsavedChanges)
        let beta = try #require(model.holdings.first)
        model.update(beta) { $0.country = "BE" }
        #expect(model.isChanged(beta) && model.hasUnsavedChanges)
        #expect(await model.save() == 1)
        #expect(!model.isPresented && model.drafts.isEmpty)
        let sent = try #require(await service.saved.first)
        #expect(sent.set.map(\.investmentId) == [2] && sent.set.first?.issuerCountryCode == "BE")
    }

    @Test func bulkApplyFillsSelectedVisibleHoldingsAndSearchMatchesNameSymbolAndSector() async throws {
        let service = ClassificationFixtureService(items: [
            holding(1, "Alpha", symbol: "ALP"), holding(2, "Beta", sector: "Energy", issuer: "Beta NV"),
            holding(3, "Gamma"),
        ])
        let model = PortfolioClassificationModel(service: service)
        await model.open()
        let locale = Locale(identifier: "en_US")
        model.search = "energy"
        #expect(model.visible(locale: locale).map(\.investmentId) == [2])
        model.search = "alp"
        #expect(model.visible(locale: locale).map(\.investmentId) == [1])
        model.setAllVisibleSelected(true, locale: locale)
        model.search = ""
        #expect(model.selected == [1] && !model.allVisibleSelected(locale: locale))
        #expect(!model.canApplyToSelected)
        model.bulkSector = "  Industrials "
        model.applyToSelected()
        #expect(model.draft(for: model.holdings[0]).sector == "Industrials")
        #expect(model.draft(for: model.holdings[2]).sector.isEmpty)
        #expect(model.changes.count == 1)
        #expect(model.sectorSuggestions(locale: locale).contains("Energy"))
        #expect(model.sectorSuggestions(locale: locale).filter { $0 == "Energy" }.count == 1)
    }

    @Test func aFailedSaveKeepsTheEditsAndClosingDropsThem() async throws {
        let service = ClassificationFixtureService(items: [holding(1, "Alpha")])
        await service.failSaves()
        let model = PortfolioClassificationModel(service: service)
        await model.open()
        model.update(model.holdings[0]) { $0.sector = "Energy" }
        #expect(await model.save() == nil)
        #expect(model.saveError != nil && model.isPresented && model.changes.count == 1)
        model.close()
        #expect(model.drafts.isEmpty && !model.hasUnsavedChanges)
    }
}

private actor ClassificationFixtureService: PortfolioClassificationService {
    private var items: [ClassifiableHolding]
    private var failing = false
    var saved: [PortfolioClassificationChanges] = []
    init(items: [ClassifiableHolding]) { self.items = items }
    func failSaves() { failing = true }
    func portfolioClassifications() async throws -> OpenAPI.PortfolioExposureClassifications {
        .init(items: items, issuers: [], sectors: ["Energy"])
    }
    func portfolioSaveClassifications(_ changes: PortfolioClassificationChanges) async throws
        -> OpenAPI.PortfolioExposureClassifications
    {
        if failing { throw APIError.backendUnavailable }
        saved.append(changes)
        return .init(items: items, issuers: [], sectors: ["Energy"])
    }
}
