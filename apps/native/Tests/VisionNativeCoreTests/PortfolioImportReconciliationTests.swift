import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Portfolio import scope and evidence validation")
struct PortfolioImportReconciliationTests {
    @Test func requestsPreserveFullDefaultsAndSortExplicitPerStatementPolicies() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [2, 1],
            batchPolicies: [
                .init(batchId: 2, adoptPolicy: .preferSource), .init(batchId: 1, adoptPolicy: .preserveExisting),
            ])
        let body = try scope.requestBody()
        #expect(body["reconciliation_scope"] == nil)
        #expect(body["adopt_policy"] == nil)
        #expect(body["batch_ids"] == .array([.number(2), .number(1)]))
        #expect(body["batch_policies"]?.arrayValue?.first?["batch_id"] == .number(1))
    }
    @Test func scopePoliciesCannotSilentlyBroadenCorrectionsOrCashConfirmation() throws {
        for scope in [
            PortfolioImportReconciliationScope(batchIds: [], adoptPolicy: .preserveExisting),
            .init(batchIds: [1], adoptPolicy: .preferSource, reconciliationScope: .adoptExistingOnly),
            .init(batchIds: [1], adoptPolicy: .preserveExisting, reconciliationScope: .correctExistingOnly),
            .init(batchIds: [1], adoptPolicy: .preferSource, reconciliationScope: .recordInKindIncomeOnly),
            .init(batchIds: [1], adoptPolicy: .preserveExisting, reconciliationScope: .recordCashOnly),
            .init(batchIds: [1], adoptPolicy: .preserveExisting, cashFundingPolicy: "own_account_transfer"),
            .init(batchIds: [1], batchPolicies: [.init(batchId: 2, adoptPolicy: .preserveExisting)]),
        ] { #expect(throws: APIError.self) { try scope.requestBody() } }
    }
    @Test func fullPlansKeepLegacyOptionalMetadataButRejectChangedScopeAndFingerprintShape() throws {
        let full = try plan(raw: planRaw())
        try full.validate(scope: .init(batchIds: [1]))
        var wrong = planRaw()
        wrong["batchIds"] = .array([.number(2)])
        #expect(throws: APIError.self) { try plan(raw: wrong).validate(scope: .init(batchIds: [1])) }
        wrong = planRaw()
        wrong["planFingerprint"] = .string("")
        #expect(throws: APIError.self) { try plan(raw: wrong) }
    }
    @Test func selectedRowsAndActionSummaryMustMatchExactlyInLimitedScopes() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1], adoptPolicy: .preserveExisting, reconciliationScope: .adoptExistingOnly)
        let action: TaxValue = .object([
            "batchId": .number(1), "rowId": .number(4), "rowOrdinal": .number(1), "action": .string("adopt"),
            "policy": .string("preserve_existing"),
        ])
        var raw = planRaw(mode: .adoptExistingOnly, policy: .preserveExisting, actions: [action], summary: ["adopt": 1])
        try plan(raw: raw).validate(scope: scope)
        raw["selectedRowIds"] = .array([.number(5)])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        raw["selectedRowIds"] = .array([.number(4)])
        raw["summary"] = .object(["adopt": .number(2)])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
    }
    @Test func incomeProofCannotDoubleCountAUnitOrUseAnUnprovedMoneyLeg() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1], adoptPolicy: .preserveExisting, reconciliationScope: .recordInKindIncomeOnly)
        let action = incomeAction(row: 4, unitTransaction: 9)
        var raw = planRaw(
            mode: .recordInKindIncomeOnly, policy: .preserveExisting, actions: [action], summary: ["record_income": 1])
        try plan(raw: raw).validate(scope: scope)
        var bad = action
        bad["source"]?["units"] = .number(1)
        raw = planRaw(
            mode: .recordInKindIncomeOnly, policy: .preserveExisting, actions: [bad], summary: ["record_income": 1])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        let second = incomeAction(row: 5, unitTransaction: 9)
        raw = planRaw(
            mode: .recordInKindIncomeOnly, policy: .preserveExisting, actions: [action, second],
            summary: ["record_income": 2])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
    }
    @Test func fullIncomeLinksToOneSameInvestmentZeroBasisGiftRow() throws {
        let gift: TaxValue = .object([
            "batchId": .number(1), "rowId": .number(3), "rowOrdinal": .number(1), "action": .string("insert"),
            "investmentId": .number(7),
            "source": .object([
                "type": .string("gift"), "date": .string("2025-01-01"), "units": .string("2"), "amount": .string("0"),
                "fees": .string("0"), "taxes": .string("0"), "price_per_unit": .string("0"),
            ]),
        ])
        var income = incomeAction(row: 4, unitTransaction: nil)
        income["incomeProof"] = .object(["kind": .string("paired_kinesis_income"), "unitRowId": .number(3)])
        var raw = planRaw(actions: [gift, income], summary: ["insert": 1, "record_income": 1])
        try plan(raw: raw).validate(scope: .init(batchIds: [1]))
        income["investmentId"] = .number(8)
        raw["actions"] = .array([gift, income])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: .init(batchIds: [1])) }
    }
    @Test func cashFundingProofRequiresClosedGroupsAndMatchingNegativeFeeComponents() throws {
        let scope = cashScope()
        let action = cashAction()
        var raw = planRaw(mode: .recordCashOnly, policy: .preserveExisting, actions: [action], summary: ["cash": 1])
        try plan(raw: raw).validate(scope: scope)
        #expect(try plan(raw: raw).actions.first?.cashValues?["amount"] == .string("-10.123456789"))
        var bad = action
        bad["cashFeeValues"]?["currency"] = .string("USD")
        raw["actions"] = .array([bad])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        bad = action
        bad["cashProof"]?["memberCount"] = .number(2)
        raw["actions"] = .array([bad])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        bad = action
        bad["cashProof"]?["unexpected"] = .bool(true)
        raw["actions"] = .array([bad])
        #expect(throws: APIError.self) { try plan(raw: raw) }
    }
    @Test func fullScopeCannotIntroduceUnreviewedCashButCanVerifySettledCash() throws {
        var action = cashAction()
        var raw = planRaw(actions: [action], summary: ["cash": 1])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: .init(batchIds: [1])) }
        action["action"] = .string("settled")
        action["existingTransactionId"] = .number(8)
        action["existingCashFeeTransactionId"] = .number(9)
        action["cashValues"] = nil
        action["cashFeeValues"] = nil
        raw = planRaw(actions: [action], summary: ["settled": 1])
        try plan(raw: raw).validate(scope: .init(batchIds: [1]))
    }
    @Test func dateCorrectionsPreserveEconomicFactsAndCannotReuseExistingTransactions() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1], adoptPolicy: .preferSource, reconciliationScope: .correctExistingOnly)
        let action = dateAction()
        var raw = planRaw(mode: .correctExistingOnly, policy: .preferSource, actions: [action], summary: ["adopt": 1])
        try plan(raw: raw).validate(scope: scope)
        var bad = action
        bad["source"]?["units"] = .string("3")
        raw["actions"] = .array([bad])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        var second = action
        second["rowId"] = .number(5)
        raw = planRaw(
            mode: .correctExistingOnly, policy: .preferSource, actions: [action, second], summary: ["adopt": 2])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
    }
    @Test func commitOutcomesRequireMatchingBatchTotalsAndZeroErrors() throws {
        let valid = resultRaw()
        try valid.decode(PortfolioImportReconciliationResult.self).validate(scope: .init(batchIds: [1]))
        var wrong = valid
        wrong["imported"] = .number(2)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: .init(batchIds: [1]))
        }
        wrong = valid
        wrong["errors"] = .number(1)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: .init(batchIds: [1]))
        }
    }
    @Test func cashOnlyOutcomesCountBothComponentsAndCannotClaimOtherImportedFacts() throws {
        let valid = resultRaw(mode: .recordCashOnly, imported: 2, recordedCash: 2)
        try valid.decode(PortfolioImportReconciliationResult.self).validate(scope: cashScope())
        var wrong = valid
        wrong["recordedCash"] = .number(1)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: cashScope())
        }
        wrong = valid
        wrong["recordedIncome"] = .number(1)
        #expect(throws: APIError.self) {
            try wrong.decode(PortfolioImportReconciliationResult.self).validate(scope: cashScope())
        }
    }
    @Test func metadataPendingCountsAndCompleteFlagStayConsistent() throws {
        var raw = planRaw()
        raw["pending"] = .number(2)
        raw["complete"] = .bool(false)
        raw["deferredCounts"] = .object(["sell": .number(2)])
        try plan(raw: raw).validate(scope: .init(batchIds: [1]))
        raw["complete"] = .bool(true)
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: .init(batchIds: [1])) }
        raw["complete"] = .bool(false)
        raw["deferredCounts"] = .object(["sell": .number(1)])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: .init(batchIds: [1])) }
    }
    @Test func statementPolicyResponseMustMatchReviewedOrderAndExplicitOverrides() throws {
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1],
            batchPolicies: [.init(batchId: 1, adoptPolicy: .preserveExisting)])
        var raw = planRaw()
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
        raw["batchPolicies"] = .array([.object(["batchId": .number(1), "adoptPolicy": .string("preserve_existing")])])
        try plan(raw: raw).validate(scope: scope)
        raw["batchPolicies"] = .array([.object(["batchId": .number(1), "adoptPolicy": .string("prefer_source")])])
        #expect(throws: APIError.self) { try plan(raw: raw).validate(scope: scope) }
    }
    @Test func duplicateRepairRequiresBothSnapshotsAndDifferentRetainedAndRemovedRecords() throws {
        var action: TaxValue = .object([
            "batchId": .number(1), "rowId": .number(4), "rowOrdinal": .number(1), "action": .string("repair_duplicate"),
            "existingTransactionId": .number(9), "importedTransactionId": .number(10), "originalBatchId": .number(3),
            "source": .object(["type": .string("dividend"), "amount": .string("15.01")]),
            "existing": .object(["type": .string("dividend"), "dividend_amount_convention": .string("gross")]),
            "importedExisting": .object(["type": .string("dividend"), "dividend_amount_convention": .string("net")]),
        ])
        try plan(raw: planRaw(actions: [action], summary: ["repair_duplicate": 1])).validate(
            scope: .init(batchIds: [1]))
        action["importedTransactionId"] = .number(9)
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
        action["importedTransactionId"] = .number(10)
        action["importedExisting"] = nil
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
    }
    @Test func cashCorrectionRejectsInvalidDatesZeroAmountsAndWrongInvestmentAttribution() throws {
        let values: TaxValue = .object([
            "date": .string("2024-02-29"), "currency": .string("EUR"), "amount": .string("-1.23456789"),
        ])
        var action: TaxValue = .object([
            "batchId": .number(1), "rowId": .number(4), "rowOrdinal": .number(1), "action": .string("adopt"),
            "isCash": .bool(true), "policy": .string("prefer_source"), "existingTransactionId": .number(9),
            "source": values, "existing": values, "corrections": .array([.string("amount")]),
        ])
        let scope = PortfolioImportReconciliationScope(
            batchIds: [1], adoptPolicy: .preferSource, reconciliationScope: .correctExistingOnly)
        try plan(
            raw: planRaw(mode: .correctExistingOnly, policy: .preferSource, actions: [action], summary: ["adopt": 1])
        ).validate(scope: scope)
        for defect in ["date", "amount", "investment"] {
            var invalid = action
            if defect == "date" { invalid["source"]?["date"] = .string("2023-02-29") }
            if defect == "amount" { invalid["source"]?["amount"] = .string("0") }
            if defect == "investment" { invalid["investmentId"] = .number(7) }
            #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [invalid])) }
        }
        action["corrections"] = .array([.string("units")])
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
    }
    @Test func allIntegerFieldsMatchZodSafeIntegerLimits() throws {
        let unsafe = Decimal(9_007_199_254_740_992)
        let action: TaxValue = .object([
            "batchId": .number(1), "rowId": .number(unsafe),
            "rowOrdinal": .number(1), "action": .string("insert"),
        ])
        #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
        var raw = planRaw()
        raw["summary"] = .object(["insert": .number(unsafe)])
        #expect(throws: APIError.self) { try plan(raw: raw) }
    }
    @Test func strictProofShapesAndSafeIdsRejectAddedFieldsNullAndUnsafeReferences() throws {
        for defect in ["unknown", "null", "unsafe"] {
            var action = incomeAction(row: 4, unitTransaction: 9)
            if defect == "unknown" { action["incomeProof"]?["surprise"] = .bool(true) }
            if defect == "null" { action["incomeProof"]?["unitTransactionId"] = .null }
            if defect == "unsafe" { action["incomeProof"]?["unitTransactionId"] = .number(9_007_199_254_740_992) }
            #expect(throws: APIError.self) { try plan(raw: planRaw(actions: [action])) }
        }
    }
}
private func plan(raw: TaxValue) throws -> PortfolioImportReconciliationPlan {
    try raw.decode(PortfolioImportReconciliationPlan.self)
}
private func planRaw(
    mode: PortfolioImportReconciliationMode = .full, policy: PortfolioImportReconciliationPolicy? = nil,
    actions: [TaxValue] = [], summary: [String: Int] = [:]
) -> TaxValue {
    var value: TaxValue = .object([
        "batchIds": .array([.number(1)]), "adoptPolicy": policy.map { .string($0.rawValue) } ?? .null,
        "batchPolicies": .array([]), "planFingerprint": .string("verified-test-plan"), "ready": .bool(true),
        "actions": .array(actions), "blockers": .array([]),
        "summary": .object(summary.mapValues { .number(Decimal($0)) }),
    ])
    if mode != .full {
        value["reconciliationScope"] = .string(mode.rawValue)
        value["pending"] = .number(0)
        value["complete"] = .bool(true)
        value["deferredCounts"] = .object([:])
        value["selectedRowIds"] = .array(actions.map { $0["rowId"]! })
    }
    return value
}
private func incomeAction(row: Int, unitTransaction: Int?) -> TaxValue {
    var proof: TaxValue = .object(["kind": .string("paired_kinesis_income")])
    if let unitTransaction { proof["unitTransactionId"] = .number(Decimal(unitTransaction)) }
    return .object([
        "batchId": .number(1), "rowId": .number(Decimal(row)), "rowOrdinal": .number(1),
        "action": .string("record_income"), "investmentId": .number(7), "incomeProof": proof,
        "source": .object([
            "type": .string("dividend"), "income_recognition_role": .string("included_in_units"),
            "date": .string("2025-01-01"), "units": .null, "price_per_unit": .null, "fx_rate_to_eur": .null,
            "amount": .string("12.123456789"), "fees": .string("0"), "taxes": .string("0"), "currency": .string("USD"),
        ]),
    ])
}
private func cashScope() -> PortfolioImportReconciliationScope {
    .init(
        batchIds: [1], adoptPolicy: .preserveExisting, reconciliationScope: .recordCashOnly,
        cashFundingPolicy: "own_account_transfer")
}
private func cashAction() -> TaxValue {
    let values: TaxValue = .object([
        "date": .string("2025-01-01"), "amount": .string("-10.123456789"), "currency": .string("EUR"),
        "accountId": .number(1), "isTransfer": .bool(true), "transferSource": .string("brokerage"),
        "transferPeerId": .null,
    ])
    var fee = values
    fee["amount"] = .string("-0.25")
    fee["isTransfer"] = .bool(false)
    return .object([
        "batchId": .number(1), "rowId": .number(4), "rowOrdinal": .number(1), "action": .string("cash"),
        "cashValues": values, "cashFeeValues": fee,
        "cashProof": .object([
            "kind": .string("closed_kinesis_cash"), "groupKey": .string(String(repeating: "a", count: 64)),
            "eventKey": .string(String(repeating: "b", count: 64)),
            "fileHash": .string(String(repeating: "c", count: 64)), "eventKind": .string("own_account_funding"),
            "memberCount": .number(1), "componentCount": .number(2),
        ]),
    ])
}
private func dateAction() -> TaxValue {
    let existing: TaxValue = .object([
        "type": .string("gift"), "date": .string("2025-01-01"), "units": .string("2"), "amount": .string("0"),
        "price_per_unit": .string("0"), "fees": .string("0"), "taxes": .string("0"), "currency": .string("USD"),
    ])
    var source = existing
    source["date"] = .string("2025-02-01")
    return .object([
        "batchId": .number(1), "rowId": .number(4), "rowOrdinal": .number(1), "action": .string("adopt"),
        "policy": .string("prefer_source"), "existingTransactionId": .number(9),
        "corrections": .array([.string("date")]), "source": source, "existing": existing,
        "dateProof": .object([
            "kind": .string("closed_kinesis_yield_group"), "groupKey": .string(String(repeating: "a", count: 64)),
            "recordedDate": .string("2025-01-01"), "paymentDate": .string("2025-02-01"), "memberCount": .number(2),
        ]),
    ])
}
private func resultRaw(mode: PortfolioImportReconciliationMode = .full, imported: Int = 1, recordedCash: Int? = nil)
    -> TaxValue
{
    var batch: TaxValue = .object([
        "batch_id": .number(1), "imported": .number(Decimal(imported)), "duplicates": .number(0), "adopted": .number(0),
        "repaired": .number(0), "errors": .number(0),
    ])
    var raw: TaxValue = .object([
        "imported": .number(Decimal(imported)), "duplicates": .number(0), "adopted": .number(0), "repaired": .number(0),
        "errors": .number(0),
    ])
    if mode != .full {
        for field in ["reconciliationScope", "pending", "complete", "deferredCounts"] {
            let value: TaxValue =
                field == "reconciliationScope"
                ? .string(mode.rawValue)
                : (field == "pending" ? .number(0) : (field == "complete" ? .bool(true) : .object([:])))
            raw[field] = value
            batch[field] = value
        }
        raw["selectedRowIds"] = .array([.number(4)])
        batch["selectedRowIds"] = .array([.number(4)])
    }
    if let recordedCash {
        raw["recordedCash"] = .number(Decimal(recordedCash))
        batch["recordedCash"] = .number(Decimal(recordedCash))
    }
    raw["batches"] = .array([batch])
    return raw
}
