import Foundation

/// The shared TypeScript engine owns every calculation, including per-partner assessment.
public protocol TaxComputationService: Sendable {
    func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation
}

extension APIClient: TaxComputationService {
    public func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation {
        try await send(OpenAPIOperations.ComputeBelgianTax(body: .init(household: household)))
    }
}
