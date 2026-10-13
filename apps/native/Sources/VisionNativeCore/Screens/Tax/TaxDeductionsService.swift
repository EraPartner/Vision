import Foundation

public protocol TaxDeductionsService: Sendable {
    func deductionCandidates(year: Int) async throws -> TaxDeductionCandidates
}
extension APIClient: TaxDeductionsService {
    public func deductionCandidates(year: Int) async throws -> TaxDeductionCandidates {
        let result = try await send(TaxDeductionRequest(year: year))
        guard result.year == year, !result.currency.isEmpty else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/info/deduction-candidates", issues: ["year or currency: invalid response"]))
        }
        return result
    }
}
private struct TaxDeductionRequest: APIOperation {
    typealias Response = TaxDeductionCandidates
    static let operationId = OpenAPIOperations.GetDeductionCandidates.operationId
    static let method = OpenAPIOperations.GetDeductionCandidates.method
    static let pathTemplate = OpenAPIOperations.GetDeductionCandidates.pathTemplate
    var path: String { Self.pathTemplate }
    let year: Int
    var queryItems: [URLQueryItem] { [.init(name: "year", value: String(year))] }
}
