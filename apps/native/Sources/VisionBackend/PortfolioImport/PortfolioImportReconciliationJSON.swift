import Foundation
import VisionNativeCore

// The JSON the TypeScript plan serializes to (`ReconciliationPlan`, `PlanAction`,
// `PlanIssue`): the body the reconciliation preview answers with. A key TypeScript leaves
// `undefined` is absent here too.

extension PlanTransactionValues {
    /// `publicValues`: the type and every value field, `null` when missing.
    var jsonObject: JSObject {
        var object = JSObject()
        for field in PlanValueField.allCases { object[field.rawValue] = self[field].map(JSValue.string) ?? .null }
        return object
    }
}

extension PlanValues {
    var jsonValue: JSValue {
        switch self {
        case .transaction(let values, let includedInUnits):
            var object = values.jsonObject
            if includedInUnits { object["income_recognition_role"] = .string("included_in_units") }
            return .object(object)
        case .cash(let day, let amount, let currency):
            return .object(
                JSObject([
                    ("date", day.map(JSValue.string) ?? .null), ("amount", .string(amount)),
                    ("currency", .string(currency.rawValue)),
                ]))
        }
    }
}

extension PlanIssue {
    var jsonValue: JSValue {
        .object(
            JSObject([
                ("batchId", .int(batchID.rawValue)), ("rowId", .int(rowID.rawValue)), ("rowOrdinal", .int(rowOrdinal)),
                ("reason", .string(reason.rawValue)),
                ("candidateTransactionIds", .array(candidateTransactionIDs.map { .int($0.rawValue) })),
            ]))
    }
}

extension PlanAction {
    var jsonValue: JSValue {
        var object = JSObject([
            ("batchId", .int(batchID.rawValue)), ("rowId", .int(rowID.rawValue)), ("rowOrdinal", .int(rowOrdinal)),
            ("action", .string(action.rawValue)),
        ])
        if let reason { object["reason"] = .string(reason.rawValue) }
        if let candidateTransactionIDs {
            object["candidateTransactionIds"] = .array(candidateTransactionIDs.map { .int($0.rawValue) })
        }
        if let investmentID { object["investmentId"] = investmentID.map { .int($0.rawValue) } ?? .null }
        if let source { object["source"] = source.jsonValue }
        if let existing { object["existing"] = existing.jsonValue }
        if let existingTransactionID { object["existingTransactionId"] = .int(existingTransactionID.rawValue) }
        if let duplicateOfRowID { object["duplicateOfRowId"] = .int(duplicateOfRowID.rawValue) }
        if let corrections { object["corrections"] = .array(corrections.map { .string($0.rawValue) }) }
        if let economicsProven { object["economicsProven"] = .bool(economicsProven) }
        if let policy { object["policy"] = .string(policy.rawValue) }
        if crossFormat { object["crossFormat"] = .bool(true) }
        if cash { object["cash"] = .bool(true) }
        if let transfer {
            object["transfer"] = .object(
                JSObject([
                    ("date", .string(transfer.day)), ("units", .string(transfer.units)),
                    ("feeUnits", .string(transfer.feeUnits)), ("receivedUnits", .string(transfer.receivedUnits)),
                    ("sourceAccountId", .int(transfer.sourceAccountID.rawValue)),
                    ("destinationAccountId", .int(transfer.destinationAccountID.rawValue)),
                ]))
        }
        if let adjustment {
            object["adjustment"] = .object(
                JSObject([
                    ("date", .string(adjustment.day)), ("units", .string(adjustment.units)),
                    ("kind", .string(adjustment.kind.rawValue)),
                    ("basisPolicy", .string(adjustment.basisPolicy.rawValue)),
                    ("accountId", .int(adjustment.accountID.rawValue)),
                ]))
        }
        return .object(object)
    }
}

extension ReconciliationPlan {
    var jsonValue: JSValue {
        .object(
            JSObject([
                ("batchIds", .array(batchIDs.map { .int($0.rawValue) })),
                ("adoptPolicy", adoptPolicy.map { .string($0.rawValue) } ?? .null),
                (
                    "batchPolicies",
                    .array(
                        batchPolicies.map {
                            .object(
                                JSObject([
                                    ("batchId", .int($0.batchID.rawValue)),
                                    ("adoptPolicy", .string($0.adoptPolicy.rawValue)),
                                ]))
                        })
                ),
                (
                    "rowChoices",
                    .array(
                        rowChoices.map {
                            .object(
                                JSObject([
                                    ("batchId", .int($0.batchID.rawValue)), ("rowId", .int($0.rowID.rawValue)),
                                    ("choice", .string($0.choice.rawValue)),
                                ]))
                        })
                ),
                ("ready", .bool(ready)),
                ("actions", .array(actions.map(\.jsonValue))),
                ("blockers", .array(blockers.map(\.jsonValue))),
                (
                    "summary",
                    .object(JSObject(PlanActionKind.allCases.map { ($0.rawValue, .int(summary[$0] ?? 0)) }))
                ),
            ]))
    }
}
