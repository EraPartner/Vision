import Foundation
import Observation

/// Coordinates year-scoped reads and structural settings edits. Monetary results remain server-owned.
@MainActor
@Observable
public final class TaxScreens {
    public let overview: TaxOverviewModel
    public let dashboard: TaxDashboardModel
    public let profile: TaxProfileModel
    public let actions: TaxActionsModel
    public let widgets: TaxWidgetsModel
    public let deductions: TaxDeductionsModel
    public private(set) var exportError: String?
    public private(set) var profileOpenError: String?
    public private(set) var isExporting = false
    @ObservationIgnored public var save: (@MainActor (Data, String) async throws -> Bool)?
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private var currency = "EUR"
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var isOpeningProfile = false

    public init(client: APIClient) {
        self.client = client
        let overview = TaxOverviewModel(service: client)
        let dashboard = TaxDashboardModel(service: client)
        self.overview = overview
        self.dashboard = dashboard
        profile = TaxProfileModel(service: client, settings: client, overview: overview, categories: client)
        actions = TaxActionsModel(overview: overview, computations: client, settings: client)
        widgets = TaxWidgetsModel(service: client)
        deductions = TaxDeductionsModel(service: client)
        overview.onInvalidate = { [weak dashboard] in dashboard?.invalidate() }
    }

    public func invalidate() {
        revision = UUID()
        overview.invalidate()
        widgets.invalidate()
        deductions.invalidate()
    }

    public func load(year: Int? = nil, currency: String, force: Bool = false) async {
        let token = UUID()
        revision = token
        self.currency = currency
        if force { overview.invalidate() }
        await overview.load(year: year, force: force)
        guard token == revision, !Task.isCancelled, overview.error == nil,
            let source = overview.overview, source.year == (year ?? source.liveYear)
        else { return }
        async let dashboardLoad: Void = dashboard.load(year: source.year, currency: currency, force: force)
        async let widgetsLoad: Void = widgets.load()
        // The web cards always edit the live household, including from a historical overview.
        async let deductionsLoad: Void = deductions.load(year: source.liveYear, force: force)
        _ = await (dashboardLoad, widgetsLoad, deductionsLoad)
    }

    public func openLiveProfile(initialStep: TaxProfileStep = .household) async {
        guard !profile.isPresented, !isOpeningProfile, !actions.isSaving else { return }
        isOpeningProfile = true
        profileOpenError = nil
        defer { isOpeningProfile = false }
        do {
            let live = try await client.taxOverview(year: nil)
            guard !Task.isCancelled else { return }
            guard live.year == live.liveYear else {
                throw APIError.contract(
                    APIContractError(
                        endpoint: "/api/belgian-tax/overview",
                        issues: ["year: does not match the live profile year"]))
            }
            profile.begin(overview: live, initialStep: initialStep)
        } catch { profileOpenError = error.localizedDescription }
    }

    /// The editor can target the live profile while the overview remains on a past year.
    public func unfileProfileYear() async -> Bool {
        guard profile.isPresented, !profile.isSaving, !profile.hasPendingChanges else { return false }
        do {
            let source = try await client.taxOverview(year: profile.year)
            guard source.year == profile.year else { throw APIError.invalidRequest("Wrong tax profile year") }
            guard await actions.perform(.unfile, source: source) else {
                profile.reportActionError(actions.error)
                return false
            }
            let refreshed = try await client.taxOverview(year: profile.year)
            profile.didUnfile(overview: refreshed)
            return !profile.isFiled
        } catch {
            profileOpenError = error.localizedDescription
            profile.reportActionError(error.localizedDescription)
            return false
        }
    }

    @discardableResult public func applyDeduction(_ application: TaxDeductionApplication) async throws -> Bool {
        guard !profile.isPresented, !actions.isSaving, let source = overview.overview else { return false }
        let patch = try application.patch(overview: source)
        do {
            try await client.saveTaxSettings(patch)
        } catch {
            await overview.refreshAfterWrite()
            throw error
        }
        await overview.refreshAfterWrite()
        if let updated = overview.overview, overview.error == nil {
            await dashboard.load(year: updated.year, currency: currency, force: true)
        }
        return true
    }

    public func exportYearCsv() async {
        guard !isExporting, !actions.isSaving, let source = overview.overview, overview.error == nil else { return }
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            await dashboard.load(year: source.year, currency: currency)
            guard let data = dashboard.data, data.year == source.year, data.currency == currency,
                overview.overview == source, dashboard.error == nil
            else { throw APIError.invalidRequest("Tax year data is unavailable for export") }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let file = try TaxYearCSV.make(
                overview: source, profile: data.exportProfile, currency: currency,
                generatedAt: formatter.string(from: Date()))
            guard let save else { throw APIError.invalidRequest("Tax CSV saving is unavailable") }
            _ = try await save(file.data, file.filename)
        } catch { exportError = error.localizedDescription }
    }
}
