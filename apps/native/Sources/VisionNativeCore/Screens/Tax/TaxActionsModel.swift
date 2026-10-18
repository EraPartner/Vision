import Foundation
import Observation

@MainActor
@Observable
public final class TaxActionsModel {
    public private(set) var isSaving = false
    public private(set) var error: String?
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

    @discardableResult
    public func perform(_ action: TaxYearAction, source explicitSource: OpenAPI.BelgianTaxOverview? = nil) async -> Bool
    {
        guard !isSaving, let source = explicitSource ?? overview.overview else { return false }
        isSaving = true
        error = nil
        var writeAttempted = false
        defer { isSaving = false }
        do {
            let computation =
                action.needsComputation(source)
                ? try await computations.computeTax(household: source.household) : nil
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
