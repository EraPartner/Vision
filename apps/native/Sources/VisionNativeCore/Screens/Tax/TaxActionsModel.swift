import Foundation
import Observation

/// The server could not compute the figures a year action needs (`tax.yearActions.computeFailed`,
/// the web's YearActionsMenu toast): the year and the reason.
public struct TaxComputeFailure: Equatable, Sendable {
    public let year: Int
    public let detail: String
}

@MainActor
@Observable
public final class TaxActionsModel {
    public private(set) var isSaving = false
    public private(set) var error: String?
    /// Set when `POST /api/belgian-tax/compute` failed for a freeze or filing (#292, #342).
    public private(set) var computeFailure: TaxComputeFailure?
    @ObservationIgnored private let overview: TaxOverviewModel
    @ObservationIgnored private let computations: any TaxComputationService
    @ObservationIgnored private let settings: any TaxSettingsService
    @ObservationIgnored private let now: @Sendable () -> Date

    public init(
        overview: TaxOverviewModel, computations: any TaxComputationService,
        settings: any TaxSettingsService, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.overview = overview
        self.computations = computations
        self.settings = settings
        self.now = now
    }

    /// The page showed the compute failure.
    public func clearComputeFailure() {
        computeFailure = nil
    }

    @discardableResult
    public func perform(_ action: TaxYearAction, source explicitSource: OpenAPI.BelgianTaxOverview? = nil) async -> Bool
    {
        guard !isSaving, let source = explicitSource ?? overview.overview else { return false }
        isSaving = true
        error = nil
        computeFailure = nil
        var writeAttempted = false
        defer { isSaving = false }
        do {
            var computation: OpenAPI.BelgianTaxComputation?
            if action.needsComputation(source) {
                do {
                    computation = try await computations.computeTax(household: source.household)
                } catch {
                    computeFailure = TaxComputeFailure(year: source.year, detail: error.localizedDescription)
                    throw error
                }
            }
            guard
                let patch = try TaxYearMutation.patch(
                    action: action, overview: source, computation: computation, at: now())
            else {
                return true
            }
            writeAttempted = true
            try await settings.saveTaxSettings(patch)
            await overview.refreshAfterWrite()
            return true
        } catch {
            self.error = error.localizedDescription
            // A failed response may follow a committed write; conflicts may also reflect
            // a newer client. Reload authoritative state and keep the action error visible.
            if writeAttempted { await overview.refreshAfterWrite() }
            return false
        }
    }
}
