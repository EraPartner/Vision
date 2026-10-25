import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Portfolio import scope and evidence validation")
struct PortfolioImportReconciliationTests {
    @Test func requestsOmitEmptyPartsAndSortExplicitPerStatementPolicies() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [2, 1],
            batchPolicies: [
                .init(batchId: 2, adoptPolicy: .preferSource), .init(batchId: 1, adoptPolicy: .preserveExisting),
            ])
        let request = try scope.request()
        #expect(request.batchIds == [2, 1])
        #expect(request.adoptPolicy == nil)
        #expect(request.rowChoices == nil)
        #expect(request.batchPolicies?.map(\.batchId) == [1, 2])
        let wire = try JSONDecoder().decode(TaxValue.self, from: APIBody.encode(request))
        #expect(wire["adopt_policy"] == nil && wire["row_choices"] == nil)
        #expect(wire["batch_policies"]?.arrayValue?.first?["batch_id"] == .number(1))
        let plain = try PortfolioImportReconciliationScope(batchIds: [1]).request()
        #expect(plain.batchPolicies == nil && plain.rowChoices == nil)
    }
    @Test func requestsCarryOnlyTheFieldsTheServerStillAccepts() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1, 2], adoptPolicy: .preferSource,
            rowChoices: [
                .init(batchId: 2, rowId: 9, choice: .sameTransaction), .init(batchId: 1, rowId: 4, choice: .keepBoth),
            ])
        let wire = try JSONDecoder().decode(TaxValue.self, from: APIBody.encode(scope.request()))
        #expect(Set(wire.objectValue?.keys.map { $0 } ?? []) == ["batch_ids", "adopt_policy", "row_choices"])
        #expect(wire["adopt_policy"] == .string("prefer_source"))
        let first = wire["row_choices"]?.arrayValue?.first
        #expect(first?["batch_id"] == .number(2) && first?["row_id"] == .number(9))
        #expect(first?["choice"] == .string("same_transaction"))
    }
    @Test func invalidScopesAreRejectedBeforeAnythingIsSent() throws {
        let answer = PortfolioImportRowChoice(batchId: 1, rowId: 4, choice: .keepBoth)
        for scope in [
            PortfolioImportReconciliationScope(batchIds: [], adoptPolicy: .preserveExisting),
            .init(batchIds: Array(1...101)),
            .init(batchIds: [9_007_199_254_740_992]),
            .init(batchIds: [1], batchPolicies: [.init(batchId: 2, adoptPolicy: .preserveExisting)]),
            .init(
                batchIds: [1],
                batchPolicies: [
                    .init(batchId: 1, adoptPolicy: .preserveExisting), .init(batchId: 1, adoptPolicy: .preferSource),
                ]),
            .init(batchIds: [1], rowChoices: [.init(batchId: 2, rowId: 4, choice: .keepBoth)]),
            .init(batchIds: [1], rowChoices: [answer, .init(batchId: 1, rowId: 4, choice: .sameTransaction)]),
            .init(batchIds: [1], rowChoices: [.init(batchId: 1, rowId: 0, choice: .keepBoth)]),
        ] { #expect(throws: APIError.self) { try scope.request() } }
    }
    @Test func rowChoicesEchoInBatchThenRowOrder() {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1, 2],
            rowChoices: [
                .init(batchId: 2, rowId: 1, choice: .keepBoth), .init(batchId: 1, rowId: 9, choice: .keepBoth),
                .init(batchId: 1, rowId: 3, choice: .sameTransaction),
            ])
        #expect(scope.sortedRowChoices.map { "\($0.batchId):\($0.rowId)" } == ["1:3", "1:9", "2:1"])
    }
    @Test func aPlanMustEchoExactlyTheSubmittedScope() throws {
        let scope = PortfolioImportReconciliationScope(batchIds: [1])
        try plan(raw: planRaw()).validate(scope: scope)
        var wrong = planRaw()
        wrong["batchIds"] = .array([.number(2)])
        #expect(throws: APIError.self) { try plan(raw: wrong).validate(scope: scope) }
        wrong = planRaw()
        wrong["adoptPolicy"] = .string("preserve_existing")
        #expect(throws: APIError.self) { try plan(raw: wrong).validate(scope: scope) }
        let outside = rowAction(row: 4, action: "insert", batch: 2)
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [outside])).validate(scope: scope) }
        var blocked = planRaw()
        blocked["blockers"] = .array([blocker(batch: 2, row: 4, reason: "ambiguous_history")])
        #expect(throws: APIError.self) { try plan(raw: blocked).validate(scope: scope) }
    }
    @Test func statementPoliciesAndRowChoicesMustComeBackAsSubmitted() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1], batchPolicies: [.init(batchId: 1, adoptPolicy: .preserveExisting)],
            rowChoices: [.init(batchId: 1, rowId: 5, choice: .sameTransaction)])
        var raw = planRaw()
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        raw["batchPolicies"] = .array([.object(["batchId": .number(1), "adoptPolicy": .string("preserve_existing")])])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        raw["rowChoices"] = .array([
            .object(["batchId": .number(1), "rowId": .number(5), "choice": .string("same_transaction")])
        ])
        try plan(raw: raw).validate(scope: scope)
        raw["rowChoices"] = .array([
            .object(["batchId": .number(1), "rowId": .number(5), "choice": .string("keep_both")])
        ])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        raw["batchPolicies"] = .array([.object(["batchId": .number(1), "adoptPolicy": .string("prefer_source")])])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
    }
    @Test func plansWithoutPolicyOrChoiceEchoesDefaultToNone() throws {
        var raw = planRaw()
        raw["batchPolicies"] = nil
        raw["rowChoices"] = nil
        let decoded = try plan(raw: raw)
        #expect(decoded.batchPolicies.isEmpty && decoded.rowChoices.isEmpty)
        try decoded.validate(scope: .init(batchIds: [1]))
    }
    @Test func removedFieldsAreIgnoredAndNoLongerRequired() throws {
        var raw = planRaw()
        raw["planFingerprint"] = .string("legacy")
        raw["reconciliationScope"] = .string("record_cash_only")
        raw["pending"] = .number(3)
        let decoded = try plan(raw: raw)
        try decoded.validate(scope: .init(batchIds: [1]))
        #expect(decoded.ready)
    }
    @Test func outcomesKeepTheCrossFormatEvidenceTheReviewShows() throws {
        var twin = rowAction(row: 4, action: "duplicate_source")
        twin["crossFormat"] = .bool(true)
        twin["duplicateOfRowId"] = .number(5)
        var cash = rowAction(row: 6, action: "adopt")
        cash["existingTransactionId"] = .number(9)
        cash["cash"] = .bool(true)
        cash["crossFormat"] = .bool(true)
        cash["policy"] = .string("prefer_source")
        cash["corrections"] = .array([.string("amount")])
        let decoded = try plan(
            raw: planRaw(actions: [twin, cash], summary: ["duplicate_source": 1, "adopt": 1]))
        try decoded.validate(scope: .init(batchIds: [1]))
        #expect(decoded.actions[0].crossFormat == true && decoded.actions[0].duplicateOfRowId == 5)
        #expect(decoded.actions[1].cash == true && decoded.actions[1].existingTransactionId == 9)
        #expect(decoded.actions[1].policy == "prefer_source" && decoded.actions[1].corrections == ["amount"])
    }
    @Test func nullPolicyAndNullInvestmentAreAccepted() throws {
        var action = rowAction(row: 4, action: "cash")
        action["policy"] = .null
        action["investmentId"] = .null
        let decoded = try plan(raw: planRaw(actions: [action]))
        #expect(decoded.actions.first?.policy == nil && decoded.actions.first?.investmentId == nil)
    }
    @Test func adoptionNeedsItsExistingTransactionAndAdjustmentItsEvidence() throws {
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [rowAction(row: 4, action: "adopt")])) }
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [rowAction(row: 4, action: "adjustment")])) }
        var adjustment = rowAction(row: 4, action: "adjustment")
        adjustment["adjustment"] = .object([
            "date": .string("2025-01-01"), "units": .string("1"), "kind": .string("asset_fee"),
            "basisPolicy": .string("carried"), "accountId": .number(3),
        ])
        #expect(try plan(raw: planRaw(actions: [adjustment])).actions.first?.adjustment?["kind"] == .string("asset_fee"))
        adjustment["adjustment"]?["kind"] = .string("other")
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [adjustment])) }
    }
    @Test func transferEvidenceNeedsAllLegsAndAccounts() throws {
        var action = rowAction(row: 4, action: "transfer")
        action["transfer"] = .object([
            "date": .string("2025-01-01"), "units": .string("2"), "feeUnits": .string("0.1"),
            "receivedUnits": .string("1.9"), "sourceAccountId": .number(3), "destinationAccountId": .number(4),
        ])
        #expect(try plan(raw: planRaw(actions: [action])).actions.first?.transfer?["receivedUnits"] == .string("1.9"))
        action["transfer"]?["destinationAccountId"] = nil
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
    }
    @Test func sourceAndExistingValuesKeepTheirClosedVocabularies() throws {
        var action = rowAction(row: 4, action: "insert")
        action["source"] = .object([
            "type": .string("dividend"), "income_recognition_role": .string("included_in_units"),
            "dividend_amount_convention": .string("net"), "amount": .string("12.123456789"), "units": .null,
        ])
        #expect(try plan(raw: planRaw(actions: [action])).actions.first?.source?["amount"] == .string("12.123456789"))
        var bad = action
        bad["source"]?["type"] = .string("gift")
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [bad])) }
        bad = action
        bad["source"]?["dividend_amount_convention"] = .string("estimated")
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [bad])) }
        bad = action
        bad["source"]?["nested"] = .object([:])
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [bad])) }
        bad = action
        bad["policy"] = .string("guess")
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [bad])) }
    }
    @Test func blockersKeepRowsAndCandidateCounts() throws {
        var raw = planRaw()
        raw["ready"] = .bool(false)
        raw["blockers"] = .array([
            blocker(batch: 1, row: 4, reason: "cross_format_identity_missing", candidates: [9]),
            blocker(batch: 1, row: nil, reason: "source_policy_required"),
        ])
        let decoded = try plan(raw: raw)
        #expect(decoded.blockers.count == 2 && !decoded.ready)
        #expect(decoded.blockers[0].rowId == 4 && decoded.blockers[0].candidateTransactionIds == [9])
        #expect(decoded.blockers[1].rowId == nil && decoded.blockers[1].rowOrdinal == nil)
    }
    @Test func allIntegerFieldsMatchZodSafeIntegerLimits() throws {
        let unsafe = Decimal(9_007_199_254_740_992)
        var action = rowAction(row: 4, action: "insert")
        action["rowId"] = .number(unsafe)
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
        var raw = planRaw()
        raw["summary"] = .object(["insert": .number(unsafe)])
        #expect(throws: APIError.self) { try plan(raw: raw) }
        raw = planRaw()
        raw["rowChoices"] = .array([
            .object(["batchId": .number(1), "rowId": .number(unsafe), "choice": .string("keep_both")])
        ])
        #expect(throws: (any Error).self) { try plan(raw: raw) }
    }
    @Test func commitOutcomesRequireMatchingBatchTotalsAndZeroErrors() throws {
        let scope = PortfolioImportReconciliationScope(batchIds: [1])
        let valid = resultRaw()
        try valid.decode(PortfolioImportReconciliationResult.self).validate(scope: scope)
        var wrong = valid
        wrong["imported"] = .number(2)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: scope)
        }
        wrong = valid
        wrong["errors"] = .number(1)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: scope)
        }
        wrong = resultRaw(batchErrors: 1)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: scope)
        }
        #expect(throws: APIError.self) {
            try valid.decode(PortfolioImportReconciliationResult.self).validate(scope: .init(batchIds: [1, 2]))
        }
    }
    @Test func commitOutcomesCountDisjointImportedDuplicateAndAdoptedRows() throws {
        let raw: TaxValue = .object([
            "imported": .number(3), "duplicates": .number(2), "adopted": .number(1), "errors": .number(0),
            "batches": .array([
                batchResult(id: 1, imported: 1, duplicates: 2, adopted: 0),
                batchResult(id: 2, imported: 2, duplicates: 0, adopted: 1),
            ]),
        ])
        let result = try raw.decode(PortfolioImportReconciliationResult.self)
        try result.validate(scope: .init(batchIds: [2, 1]))
        #expect(result.imported == 3 && result.duplicates == 2 && result.adopted == 1)
    }
}
private func plan(raw: TaxValue) throws -> PortfolioImportReconciliationPlan {
    try raw.decode(PortfolioImportReconciliationPlan.self)
}
private func planRaw(actions: [TaxValue] = [], summary: [String: Int] = [:]) -> TaxValue {
    .object([
        "batchIds": .array([.number(1)]), "adoptPolicy": .null, "batchPolicies": .array([]),
        "rowChoices": .array([]), "ready": .bool(true), "actions": .array(actions), "blockers": .array([]),
        "summary": .object(summary.mapValues { .number(Decimal($0)) }),
    ])
}
private func rowAction(row: Int, action: String, batch: Int = 1) -> TaxValue {
    .object([
        "batchId": .number(Decimal(batch)), "rowId": .number(Decimal(row)), "rowOrdinal": .number(1),
        "action": .string(action),
    ])
}
private func blocker(batch: Int, row: Int?, reason: String, candidates: [Int] = []) -> TaxValue {
    var value: TaxValue = .object([
        "batchId": .number(Decimal(batch)), "reason": .string(reason),
        "candidateTransactionIds": .array(candidates.map { .number(Decimal($0)) }),
    ])
    if let row {
        value["rowId"] = .number(Decimal(row))
        value["rowOrdinal"] = .number(Decimal(row))
    }
    return value
}
private func batchResult(id: Int, imported: Int, duplicates: Int, adopted: Int, errors: Int = 0) -> TaxValue {
    .object([
        "batch_id": .number(Decimal(id)), "imported": .number(Decimal(imported)),
        "duplicates": .number(Decimal(duplicates)), "adopted": .number(Decimal(adopted)),
        "errors": .number(Decimal(errors)),
    ])
}
private func resultRaw(batchErrors: Int = 0) -> TaxValue {
    .object([
        "imported": .number(1), "duplicates": .number(0), "adopted": .number(0), "errors": .number(0),
        "batches": .array([batchResult(id: 1, imported: 1, duplicates: 0, adopted: 0, errors: batchErrors)]),
    ])
}
