import Foundation

/// The shared TypeScript engine owns every calculation, including per-partner assessment.
public protocol TaxComputationService: Sendable {
    func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation
    func taxOverview(year: Int?) async throws -> OpenAPI.BelgianTaxOverview
}

extension APIClient: TaxComputationService {
    public func taxOverview(year: Int? = nil) async throws -> OpenAPI.BelgianTaxOverview {
        try await send(OpenAPIOperations.GetBelgianTaxOverview(year: year))
    }
    public func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation {
        try await send(OpenAPIOperations.ComputeBelgianTax(body: .init(household: household)))
    }
}
