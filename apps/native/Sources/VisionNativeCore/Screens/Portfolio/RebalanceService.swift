import Foundation

public protocol RebalanceService: Sendable {
    func rebalance(_ request: RebalanceRequest) async throws -> RebalanceResult
    func rebalanceCash(currency: String, reserveFloor: Decimal) async throws -> RebalanceCashProjection
    func rebalancePlans() async throws -> OpenAPI.Setting
    func saveRebalancePlans(_ plans: [RebalancePlan], expected: JSONValue) async throws -> OpenAPI.Setting
}

extension APIClient: RebalanceService {
    public func rebalance(_ request: RebalanceRequest) async throws -> RebalanceResult {
        let result = try await send(RebalanceComputeOperation(request: request))
        guard result.currency.uppercased() == request.currency.uppercased(),
            result.cashAccounts.allSatisfy({
                $0.id > 0 && $0.balanceCurrency.uppercased() == result.currency.uppercased()
            })
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: RebalanceComputeOperation.pathTemplate,
                    issues: [
                        "currency: rebalance values or converted cash accounts do not match the requested currency"
                    ]))
        }
        return result
    }
    public func rebalanceCash(currency: String, reserveFloor: Decimal) async throws -> RebalanceCashProjection {
        let result = try await send(RebalanceCashOperation(currency: currency, reserveFloor: reserveFloor))
        guard result.currency.uppercased() == currency.uppercased(), result.horizonDays > 0,
            result.occurrenceCount >= 0, result.candidateCashCap >= 0, result.reserveFloor == reserveFloor
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: RebalanceCashOperation.pathTemplate,
                    issues: ["projection: invalid currency, reserve floor, cap or horizon"]))
        }
        return result
    }
    public func rebalancePlans() async throws -> OpenAPI.Setting { try await setting(key: "rebalance_plans") }
    public func saveRebalancePlans(_ plans: [RebalancePlan], expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(RebalancePlansWrite(plans: plans, expected: expected))
    }
}

private struct RebalanceComputeOperation: APIOperation {
    typealias Response = RebalanceResult
    static let operationId = OpenAPIOperations.ComputeRebalance.operationId
    static let method = OpenAPIOperations.ComputeRebalance.method
    static let pathTemplate = OpenAPIOperations.ComputeRebalance.pathTemplate
    var path: String { Self.pathTemplate }
    let request: RebalanceRequest
    func encodedBody() throws -> Data? { try APIBody.encode(request) }
}
private struct RebalanceCashOperation: APIOperation, Encodable {
    typealias Response = RebalanceCashProjection
    static let operationId = OpenAPIOperations.ComputeCommitmentAwareCash.operationId
    static let method = OpenAPIOperations.ComputeCommitmentAwareCash.method
    static let pathTemplate = OpenAPIOperations.ComputeCommitmentAwareCash.pathTemplate
    var path: String { Self.pathTemplate }
    let currency: String
    let reserveFloor: Decimal
    func encodedBody() throws -> Data? { try APIBody.encode(self) }
}
private struct RebalancePlansWrite: APIOperation {
    typealias Response = OpenAPI.Setting
    static let operationId = OpenAPIOperations.SaveSetting.operationId
    static let method = OpenAPIOperations.SaveSetting.method
    static let pathTemplate = OpenAPIOperations.SaveSetting.pathTemplate
    var path: String { "/api/settings/rebalance_plans" }
    let plans: [RebalancePlan]
    let expected: JSONValue
    func encodedBody() throws -> Data? { try APIBody.encode(Body(value: plans, expected: expected)) }
    private struct Body: Encodable {
        let value: [RebalancePlan]
        let expected: JSONValue
    }
}
