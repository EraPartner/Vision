import Foundation
import VisionNativeCore

@testable import VisionBackend

/// Reads the wire-shaped rows the TypeScript tests and the plan corpus hold (column names as
/// the repositories return them; ids as numbers or decimal text) into the Swift row types,
/// and writes a plan result the way the corpus recorder does.
enum PlanFixture {
    struct Malformed: Error { let what: String }

    static func object(_ json: String) throws -> JSObject {
        guard let object = JSValue.parse(json)?.objectValue else { throw Malformed(what: json) }
        return object
    }

    /// `base` with the keys of `over` replacing its own (`{ ...base, ...over }`).
    static func merged(_ base: JSObject, _ over: JSObject) -> JSObject {
        var result = base
        for (key, value) in over.entries { result[key] = value }
        return result
    }

    private static func integer(_ value: JSValue?) -> Int? {
        switch value {
        case .number(let number): return Int(exactly: number)
        case .string(let text): return Int(text)
        default: return nil
        }
    }

    private static func text(_ value: JSValue?) -> String? {
        switch value {
        case .string(let text): return text
        case .number: return value?.javaScriptString
        default: return nil
        }
    }

    private static func currency(_ value: JSValue?) -> CurrencyCode? {
        value?.stringValue.flatMap(CurrencyCode.init(rawValue:))
    }

    private static func config(_ value: JSValue?) -> StoredBatchConfig? {
        switch value {
        case .object(let object): return .object(object)
        case .string(let text): return .text(text)
        default: return nil
        }
    }

    private static func required<Value>(_ value: Value?, _ what: String) throws -> Value {
        guard let value else { throw Malformed(what: what) }
        return value
    }

    static func row(_ wire: JSObject) throws -> ReconciliationSourceRow {
        ReconciliationSourceRow(
            id: PortfolioImportRowID(try required(integer(wire["id"]), "row.id")),
            batchID: PortfolioImportBatchNumericID(try required(integer(wire["batch_id"]), "row.batch_id")),
            rowIndex: try required(integer(wire["row_index"]), "row.row_index"),
            status: StagingStatus(rawValue: try required(wire["status"]?.stringValue, "row.status")),
            route: wire["route"]?.stringValue.map(StagingRoute.init(rawValue:)),
            kind: wire["type"]?.stringValue.map(PortfolioEventKind.init(rawValue:)),
            kindRaw: wire["type_raw"]?.stringValue, day: wire["tx_date"]?.stringValue, amount: text(wire["amount"]),
            units: text(wire["units"]), pricePerUnit: text(wire["price_per_unit"]), fees: text(wire["fees"]),
            taxes: text(wire["taxes"]), currency: currency(wire["currency"]),
            fxRateToEUR: text(wire["fx_rate_to_eur"]), note: wire["note"]?.stringValue,
            rawData: wire["raw_data"]?.stringValue, symbolRaw: wire["symbol_raw"]?.stringValue,
            sourceReference: wire["source_transaction_id"]?.stringValue,
            sourceAccountIdentity: wire["source_account_identity"]?.stringValue,
            sourceRecordHash: wire["source_record_hash"]?.stringValue,
            dedupFingerprint: wire["dedup_fingerprint"]?.stringValue,
            dedupFingerprintVersion: integer(wire["dedup_fingerprint_version"]),
            assetTransferDetails: wire["asset_transfer_details"]?.objectValue,
            assetAdjustmentDetails: wire["asset_adjustment_details"]?.objectValue,
            investmentID: integer(wire["investment_id"]).map { InvestmentID(rawValue: $0) },
            resolvedInvestmentID: integer(wire["resolved_investment_id"]).map { InvestmentID(rawValue: $0) },
            userOverrideInvestmentID: integer(wire["user_override_investment_id"]).map { InvestmentID(rawValue: $0) },
            assetClass: wire["asset_class"]?.stringValue, investmentCurrency: currency(wire["investment_currency"]),
            accountID: integer(wire["account_id"]).map { AccountID(rawValue: $0) }, customConfig: config(wire["custom_config"]))
    }

    static func history(_ wire: JSObject) throws -> HistoryImage {
        HistoryImage(
            id: LedgerTransactionID(try required(integer(wire["id"]), "history.id")),
            investmentID: InvestmentID(try required(integer(wire["investment_id"]), "history.investment_id")),
            kind: PortfolioEventKind(rawValue: try required(wire["type"]?.stringValue, "history.type")),
            day: try required(wire["date"]?.stringValue, "history.date"), amount: text(wire["amount"]),
            units: text(wire["units"]), pricePerUnit: text(wire["price_per_unit"]), fees: text(wire["fees"]),
            taxes: text(wire["taxes"]), currency: currency(wire["currency"]),
            fxRateToEUR: text(wire["fx_rate_to_eur"]), accountID: integer(wire["account_id"]).map { AccountID(rawValue: $0) },
            note: wire["note"]?.stringValue,
            dividendAmountConvention: wire["dividend_amount_convention"]?.stringValue,
            isRecurring: wire["is_recurring"].flatMap { value -> Bool? in
                if case .bool(let flag) = value { return flag }
                return nil
            }, recurrenceInterval: wire["recurrence_interval"]?.stringValue,
            recurrenceEndDay: wire["recurrence_end_date"]?.stringValue,
            importBatchID: wire["import_batch_id"]?.stringValue.map { PortfolioImportBatchID(rawValue: $0) },
            sourceRecordHash: wire["source_record_hash"]?.stringValue,
            dedupFingerprint: wire["dedup_fingerprint"]?.stringValue,
            dedupFingerprintVersion: integer(wire["dedup_fingerprint_version"]),
            sourceAccountID: integer(wire["source_account_id"]).map { AccountID(rawValue: $0) },
            destinationAccountID: integer(wire["destination_account_id"]).map { AccountID(rawValue: $0) },
            feeUnits: text(wire["fee_units"]), adjustmentKind: wire["adjustment_kind"]?.stringValue,
            basisPolicy: wire["basis_policy"]?.stringValue)
    }

    static func batch(_ wire: JSObject) throws -> ReconciliationBatchScopeRow {
        ReconciliationBatchScopeRow(
            id: PortfolioImportBatchNumericID(try required(integer(wire["id"]), "batch.id")),
            accountID: integer(wire["account_id"]).map { AccountID(rawValue: $0) }, customConfig: config(wire["custom_config"]))
    }

    static func ledgerSource(_ wire: JSObject) throws -> CrossFormatLedgerSourceRow {
        CrossFormatLedgerSourceRow(
            id: PortfolioImportRowID(try required(integer(wire["id"]), "ledger.id")),
            batchID: PortfolioImportBatchNumericID(try required(integer(wire["batch_id"]), "ledger.batch_id")),
            status: StagingStatus(rawValue: try required(wire["status"]?.stringValue, "ledger.status")),
            route: wire["route"]?.stringValue.map(StagingRoute.init(rawValue:)),
            kind: wire["type"]?.stringValue.map(PortfolioEventKind.init(rawValue:)),
            kindRaw: wire["type_raw"]?.stringValue, day: wire["tx_date"]?.stringValue, units: text(wire["units"]),
            amount: text(wire["amount"]), currency: currency(wire["currency"]),
            rawData: wire["raw_data"]?.stringValue, sourceReference: wire["source_transaction_id"]?.stringValue,
            sourceAccountIdentity: wire["source_account_identity"]?.stringValue,
            dedupFingerprint: wire["dedup_fingerprint"]?.stringValue,
            dedupFingerprintVersion: integer(wire["dedup_fingerprint_version"]),
            investmentID: integer(wire["investment_id"]).map { InvestmentID(rawValue: $0) },
            accountID: AccountID(try required(integer(wire["account_id"]), "ledger.account_id")),
            customConfig: config(wire["custom_config"]),
            ledger: try required(wire["ledger"]?.stringValue.flatMap(SourceLedger.init(rawValue:)), "ledger.ledger"),
            transactionID: LedgerTransactionID(try required(integer(wire["transaction_id"]), "ledger.transaction_id")),
            ledgerDay: wire["ledger_date"]?.stringValue, ledgerAmount: text(wire["ledger_amount"]),
            ledgerCurrency: currency(wire["ledger_currency"]))
    }

    static func manualCash(_ wire: JSObject) throws -> ManualCashCandidateRow {
        ManualCashCandidateRow(
            id: LedgerTransactionID(try required(integer(wire["id"]), "cash.id")),
            accountID: AccountID(try required(integer(wire["account_id"]), "cash.account_id")),
            day: try required(wire["date"]?.stringValue, "cash.date"),
            amount: try required(text(wire["amount"]), "cash.amount"),
            currency: try required(currency(wire["currency"]), "cash.currency"))
    }

    private static func objects(_ value: JSValue?) -> [JSObject] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(\.objectValue)
    }

    private static func strings(_ value: JSValue?) -> [String] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(\.stringValue)
    }

    static func crossFormat(_ wire: JSObject) throws -> CrossFormatContext {
        CrossFormatContext(
            ledgerSources: try objects(wire["ledgerSources"]).map(ledgerSource),
            cashFingerprints: Set(strings(wire["cashFingerprints"])),
            correctedAliases: Set(strings(wire["correctedAliases"])),
            manualCash: try objects(wire["manualCash"]).map(manualCash),
            settledIdentities: Set(strings(wire["settledIdentities"])))
    }

    /// A recorded `ReconciliationPlanInput`: sets as arrays, `historySourceIds` as entries.
    static func input(_ wire: JSObject) throws -> ReconciliationPlanInput {
        var input = ReconciliationPlanInput(
            rows: try objects(wire["rows"]).map(row), history: try objects(wire["history"]).map(history),
            batches: try objects(wire["batches"]).map(batch), adoptPolicy: wire["adoptPolicy"]?.stringValue)
        input.batchPolicies = objects(wire["batchPolicies"]).map {
            BatchPolicyInput(
                batchID: integer($0["batchId"]).map { PortfolioImportBatchNumericID(rawValue: $0) },
                adoptPolicy: $0["adoptPolicy"]?.stringValue ?? "")
        }
        input.rowChoices = objects(wire["rowChoices"]).map {
            RowChoiceInput(
                batchID: integer($0["batchId"]).map { PortfolioImportBatchNumericID(rawValue: $0) },
                rowID: integer($0["rowId"]).map { PortfolioImportRowID(rawValue: $0) }, choice: $0["choice"]?.stringValue ?? "")
        }
        if case .array(let accounts)? = wire["priorProAccounts"] {
            input.priorProAccounts = accounts.compactMap { integer($0).map { AccountID(rawValue: $0) } }
        }
        if let context = wire["crossFormat"]?.objectValue { input.crossFormat = try crossFormat(context) }
        if case .array(let entries)? = wire["historySourceIds"] {
            for entry in entries {
                guard case .array(let pair) = entry, pair.count == 2, let id = integer(pair[0]) else { continue }
                input.historySourceKeys[LedgerTransactionID(id)] = strings(pair[1])
            }
        }
        return input
    }

    // MARK: Recorded result

    private static func optional(_ text: String?) -> JSValue { text.map(JSValue.string) ?? .null }
    private static func optional(_ number: Int?) -> JSValue { number.map(JSValue.int) ?? .null }

    private static func image(_ image: HistoryImage) -> JSValue {
        .object(
            JSObject([
                ("id", .int(image.id.rawValue)), ("investment_id", .int(image.investmentID.rawValue)),
                ("type", .string(image.kind.rawValue)), ("date", .string(image.day)),
                ("amount", optional(image.amount)), ("units", optional(image.units)),
                ("price_per_unit", optional(image.pricePerUnit)), ("fees", optional(image.fees)),
                ("taxes", optional(image.taxes)), ("currency", optional(image.currency?.rawValue)),
                ("fx_rate_to_eur", optional(image.fxRateToEUR)),
                ("dividend_amount_convention", optional(image.dividendAmountConvention)),
                ("account_id", optional(image.accountID?.rawValue)), ("note", optional(image.note)),
                ("import_batch_id", optional(image.importBatchID?.rawValue)),
                ("source_record_hash", optional(image.sourceRecordHash)),
                ("dedup_fingerprint", optional(image.dedupFingerprint)),
                ("dedup_fingerprint_version", optional(image.dedupFingerprintVersion)),
            ]))
    }

    private static func decision(_ decision: CashAdoptionDecision) -> JSValue {
        var object = JSObject([
            ("kind", .string("adopt_cash")), ("reason", .string(decision.reason.rawValue)),
            ("transactionId", .int(decision.transactionID.rawValue)), ("policy", .string(decision.policy.rawValue)),
            (
                "existing",
                .object(
                    JSObject([
                        ("date", .string(decision.existing.day)), ("amount", .string(decision.existing.amount)),
                        ("currency", .string(decision.existing.currency.rawValue)),
                    ]))
            ),
            (
                "after",
                .object(
                    JSObject([
                        ("amount", .string(decision.after.amount)),
                        ("currency", .string(decision.after.currency.rawValue)),
                    ]))
            ),
        ])
        if let original = decision.original {
            object["original"] = .object(
                JSObject([
                    ("batchId", .int(original.batchID.rawValue)),
                    ("stagingRowId", .int(original.stagingRowID.rawValue)),
                ]))
        }
        return .object(object)
    }

    /// The result as the corpus records it: the whole plan, and the commit-side lists by row.
    static func recorded(_ result: ReconciliationPlanResult) -> JSValue {
        .object(
            JSObject([
                ("plan", result.plan.jsonValue),
                (
                    "adoptions",
                    .array(
                        result.adoptions.map {
                            .object(
                                JSObject([
                                    ("rowId", .int($0.row.id.rawValue)), ("policy", .string($0.policy.rawValue)),
                                    ("before", image($0.before)), ("after", image($0.after)),
                                ]))
                        })
                ),
                ("settledDuplicates", .array(result.settledDuplicates.map { .int($0.id.rawValue) })),
                (
                    "cashAdoptions",
                    .array(
                        result.cashAdoptions.map {
                            .object(JSObject([("rowId", .int($0.row.id.rawValue)), ("decision", decision($0.decision))]))
                        })
                ),
            ]))
    }

    /// JSON text with every object's keys sorted, for a comparison that ignores key order.
    static func canonical(_ value: JSValue) -> String {
        switch value {
        case .array(let items): return "[" + items.map(canonical).joined(separator: ",") + "]"
        case .object(let object):
            let members = object.entries.sorted { $0.0 < $1.0 }.map { key, value in
                JSValue.string(key).jsonText + ":" + canonical(value)
            }
            return "{" + members.joined(separator: ",") + "}"
        default: return value.jsonText
        }
    }
}
