import Foundation
import VisionNativeCore

/// The P18 commit routes: `commitPortfolioImportBatch` (`POST /batches/:id/commit`)
/// and `commitReviewedPortfolioImports` (`POST /reconciliation/commit`) — the
/// portfolio import pipeline's commit half (`portfolioImportPipeline/commit.ts`),
/// the reviewed-scope commit (`portfolioImportCommitService.ts`) and the
/// reconciliation apply half (`applyPortfolioImportReconciliation`).
enum PortfolioImportCommitArea {
    /// `parseBatchIdParam` reuses the shared id guard the batches area holds.
    typealias batchId = PortfolioImportBatchesArea.batchId

    /// `PORTFOLIO_ACCOUNT_TYPES` of `portfolioImportAccountService.ts`.
    static let portfolioAccountTypes: Set<String> = ["brokerage", "crypto_exchange", "wallet"]

    /// `assertPortfolioImportAccount`: the account must exist, be active and support
    /// portfolio imports. A missing id is legal (an unassigned batch).
    static func assertPortfolioImportAccount(_ session: BackendSession, _ accountId: Int?) throws {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let accountId else { return }
        guard let account = try session.row(
            """
            SELECT a.is_active AS is_active, a.type AS type
              FROM accounts a
             WHERE a.id = ?
            """,
            [.integer(Int64(accountId)])
        else {
            throw BackendHTTPError.notFound("Account not found")
        }
        let active = (try account.int64("is_active")) != 0
        let type = try account.text("type")
        guard active, portfolioAccountTypes.contains(type) else {
            throw BackendHTTPError.validation("account_id must reference an active portfolio account")
        }
    }

    /// `commitBodySchema` through `parseInput(bareMessages(...))`: `account_id` is
    /// `validateId`'s accept set with the int4 bound; null keeps its meaning (no
    /// switch), a present but malformed value is one joined issue.
    static func commitBody(_ parsed: JSValue?) throws -> Int? {
        var body: JSValue
        if case .object(let object)? = parsed {
            body = .object(object)
        } else if parsed == nil || parsed == .null {
            body = .object(JSObject())
        } else {
            body = parsed ?? .null
        }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        var issues: [String] = []
        var accountId: Int? = nil  // lint:allow raw-id the int4 account id the route body coerces
        if let value = object["account_id"], value != .null {
            let parsedId = PortfolioImportOverridesArea.validId(value, max: 2_147_483_647)
            if let parsedId {
                accountId = parsedId
            } else {
                issues.append("account_id must be a positive integer")
            }
        }
        if !issues.isEmpty {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        return accountId
    }

    /// `lockBatchForUpdate`: the lock row's fields. The caller's transaction holds the
    /// write lock; the read is the row's reviewed state.
    struct LockedBatch {
        var id: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var status: String
        var isBrokerage: Bool
        var adapterName: String?
        var customConfig: StoredBatchConfig
        var accountID: Int?  // lint:allow raw-id the id the repository query binds

        var maintained: Bool { PortfolioImportCommitArea.isMaintained(self) }
    }

    /// `isMaintainedPortfolioImport`: the adapter or the config's format is a
    /// maintained adapter.
    static func isMaintained(_ batch: LockedBatch) -> Bool {
        let format = batch.customConfig.parsedObject["format"]?.stringValue
        return [batch.adapterName, format].contains { value in
            guard let value else { return false }
            return PortfolioImportCommitArea.maintainedAdapters.contains(
                value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        }
    }

    static let maintainedAdapters: Set<String> = [
        "ibkr", "kinesis", "nexo", "saxo", "ibkr_transaction_history", "ibkr_funding_history",
        "kinesis_transaction_history", "nexo_transaction_history", "nexo_pro_spot_history",
        "saxo_transaction_history", "portfolio_performance_reference",
    ]

    /// `lockBatchForUpdate`: the batch's lock row.
    static func lockBatch(_ session: BackendSession, _ batchId: Int) throws -> LockedBatch? {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let row = try session.row(
            """
            SELECT b.id, b.status, b.is_brokerage, b.adapter_name, b.custom_config, b.account_id
              FROM portfolio_import_batches b
             WHERE b.id = ?
            """,
            [.integer(Int64(batchId)])
        else { return nil }
        return LockedBatch(
            id: Int(try row.int64("id")),
            status: try row.text("status"),
            isBrokerage: (try row.int64("is_brokerage")) != 0,
            adapterName: try row.optionalText("adapter_name"),
            customConfig: (try row.optionalText("custom_config"))
                .map(PortfolioImportReconciliationArea.storedConfig)
                ?? .text(""),
            accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) })
    }

    /// `assertReviewable`: a missing batch is 404; a terminal batch is a 400 with its status.
    static func assertReviewable(_ batch: LockedBatch?, _ batchId: Int) throws -> LockedBatch {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let batch else {
            throw BackendHTTPError.notFound("Import batch \(batchId) not found")
        }
        guard ["awaiting_review", "matching", "complete_with_errors"].contains(batch.status) else {
            throw BackendHTTPError.validation(
                "Batch \(batchId) is not in a reviewable state (status: \(batch.status))")
        }
        return batch
    }

    /// `setBatchAccount`: one unit — the cash repair, then the batch's account. The
    /// repaired rows and the batch move together or not at all.
    static func setBatchAccount(_ session: BackendSession, _ batchId: Int, _ accountId: Int?) throws {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var repaired = 0
        if let accountId {
            repaired = try session.rows(
                """
                UPDATE portfolio_import_staging_rows
                   SET status = 'matched', error_message = NULL
                 WHERE batch_id = ? AND route = 'cash' AND status = 'error'
                   AND error_message = 'brokerage cash row requires a batch account'
                RETURNING id
                """,
                [.integer(Int64(batchId))]).count
        }
        _ = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET account_id = ?,
                   rows_error = max(COALESCE(rows_error, 0) - ?, 0)
             WHERE id = ?
            RETURNING id
            """,
            [accountId.map { SQLValue.integer(Int64($0)) } ?? .null,
             .integer(Int64(repaired)),
             .integer(Int64(batchId))])
    }

    /// `getImportReadinessProblems`: the rows that are not settled or complete.
    static func readinessProblems(
        _ session: BackendSession, _ batchId: Int, _ accountId: Int?  // lint:allow raw-id the id the repository query binds
    ) throws -> [Int] {  // lint:allow raw-id business table ordinals of the TypeScript repository read
        let rows = try session.rows(
            """
            SELECT s.row_index AS row_index
              FROM portfolio_import_staging_rows s
             WHERE s.batch_id = ?
               AND (
                   s.status NOT IN ('matched', 'committed', 'duplicate')
                   OR (s.status = 'matched' AND (
                       s.tx_date IS NULL
                       OR (s.route = 'cash' AND (? IS NULL OR s.amount IS NULL))
                       OR (s.route IS NOT 'cash' AND s.route IS NOT 'account_internal' AND (
                           (s.type IS NULL AND s.route IS NOT 'asset_transfer'
                                              AND s.route IS NOT 'asset_adjustment')
                           OR COALESCE(s.user_override_investment_id, s.resolved_investment_id) IS NULL
                       ))
                   ))
               )
             ORDER BY s.row_index
            """,
            [.integer(Int64(batchId)), accountId.map { SQLValue.integer(Int64($0)) } ?? .null])
        return try rows.map { Int(try $0.int64("row_index")) }
    }
}

// MARK: - Snapshot images

extension PortfolioImportCommitArea {
    /// The canonical snapshot JSON `PortfolioTransactionSnapshot` holds, as
    /// `portfolio_income_transaction_snapshot` writes it: the column order of
    /// `SchemaFunctions.snapshotColumns`, with the JSON values the function emits.
    static func snapshotJSON(_ image: HistoryImage) throws -> String {
        func value(_ text: String?) -> JSONValue {
            guard let text else { return .null }
            return .string(text)
        }
        let object: [(String, JSONValue)] = [
            ("id", .int(image.id.rawValue)),
            ("investment_id", .int(image.investmentID.rawValue)),
            ("type", .string(image.kind.rawValue)),
            ("date", .string(image.day)),
            ("amount", value(image.amount)),
            ("units", value(image.units)),
            ("price_per_unit", value(image.pricePerUnit)),
            ("fees", value(image.fees)),
            ("taxes", value(image.taxes)),
            ("currency", value(image.currency?.rawValue)),
            ("fx_rate_to_eur", value(image.fxRateToEUR)),
            ("account_id", image.accountID.map { JSONValue.int($0.rawValue) } ?? .null),
            ("note", value(image.note)),
            ("dividend_amount_convention", value(image.dividendAmountConvention)),
            ("is_recurring", image.isRecurring.map { JSONValue.bool($0) } ?? .null),
            ("recurrence_interval", value(image.recurrenceInterval)),
            ("recurrence_end_date", value(image.recurrenceEndDay)),
            ("import_batch_id", value(image.importBatchID?.rawValue)),
            ("source_record_hash", value(image.sourceRecordHash)),
            ("dedup_fingerprint", value(image.dedupFingerprint)),
            ("dedup_fingerprint_version", image.dedupFingerprintVersion.map { JSONValue.int($0) } ?? .null),
            ("income_recognition_role", .null),
        ]
        return String(decoding: try JSONEncoder().encode(JSONValue.object(Dictionary(uniqueKeysWithValues: object))), as: UTF8.self)
    }

    /// `readTransactionSnapshot`: the row's snapshot image, or nil.
    static func readTransactionSnapshot(_ session: BackendSession, _ id: Int) throws -> HistoryImage? {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let row = try session.row(
            """
            SELECT \(try SchemaFunctions.snapshotSQL(alias: "pt")) AS snapshot
              FROM portfolio_transactions pt
             WHERE pt.id = ?
            """,
            [.integer(Int64(id))])
        guard let text = try row?.optionalText("snapshot"), let value = JSValue.parse(text),
            case .object(let snapshot) = value
        else { return nil }
        return try PortfolioImportReconciliationArea.historyImage(snapshot)
    }

    /// `compareAndSetReconciledTransaction`: write `after` only while the row still equals
    /// `before`. One unit: the update and its read-back share the caller's transaction.
    static func compareAndSetReconciledTransaction(
        _ session: BackendSession, _ before: HistoryImage, _ after: HistoryImage
    ) throws -> HistoryImage? {
        let afterImage = try snapshotJSON(after)
        let beforeImage = try snapshotJSON(before)
        func field(_ name: String) -> String { "? ->> '\(name)'" }
        let updated = try session.rows(
            """
            UPDATE portfolio_transactions SET
               date = \(field("date")),
               amount = vision_numeric(\(field("amount")), 18, 4),
               units = vision_numeric(\(field("units")), 18, 8),
               price_per_unit = vision_numeric(\(field("price_per_unit")), 18, 6),
               fees = vision_numeric(\(field("fees")), 18, 4),
               taxes = vision_numeric(\(field("taxes")), 18, 4),
               currency = \(field("currency")),
               dividend_amount_convention = \(field("dividend_amount_convention")),
               income_recognition_role = COALESCE(\(field("income_recognition_role")), 'standard'),
               fx_rate_to_eur = vision_numeric(\(field("fx_rate_to_eur")), 20, 10),
               account_id = CAST(\(field("account_id")) AS INTEGER),
               source_record_hash = \(field("source_record_hash")),
               dedup_fingerprint = \(field("dedup_fingerprint")),
               dedup_fingerprint_version = CAST(\(field("dedup_fingerprint_version")) AS INTEGER),
               updated_at = now()
             WHERE portfolio_transactions.id = ?
               AND \(try SchemaFunctions.snapshotSQL(alias: "portfolio_transactions")) =
                   normalize_portfolio_income_snapshot(?)
            RETURNING id
            """,
            [SQLValue](repeating: .text(afterImage), count: 13)
                + [.integer(Int64(before.id.rawValue)), .text(beforeImage)])
        guard updated.count == 1 else { return nil }
        return try readTransactionSnapshot(session, before.id.rawValue)
    }
}

// MARK: - Apply

extension PortfolioImportCommitArea {
    /// `insertReconciliationReceipt`: one journal row with both images.
    static func insertReconciliationReceipt(
        _ session: BackendSession, batchId: Int, stagingRowId: Int, transactionId: Int,  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        action: String, policy: String, before: HistoryImage, after: HistoryImage
    ) throws -> Int {
        let rows = try session.rows(
            """
            INSERT INTO portfolio_import_reconciliation_journal (
                batch_id, staging_row_id, transaction_id, action, policy, before_data, after_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
            """,
            [.integer(Int64(batchId)), .integer(Int64(stagingRowId)), .integer(Int64(transactionId)),
             .text(action), .text(policy), .text(try snapshotJSON(before)), .text(try snapshotJSON(after))])
        guard let id = try rows.first?.optionalInt64("id") else {
            throw RequiredValueError(message: "reconciliation receipt insert")
        }
        return Int(id)
    }

    /// `markAdoptedSourceDuplicate`: the adopted row settles, and the batch counts it.
    static func markAdoptedSourceDuplicate(
        _ session: BackendSession, _ stagingRowId: Int, _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws {
        _ = try session.rows(
            """
            UPDATE portfolio_import_staging_rows
               SET status = 'duplicate'
             WHERE id = ? AND batch_id = ? AND status = 'matched'
            """,
            [.integer(Int64(stagingRowId)), .integer(Int64(batchId))])
        _ = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET rows_duplicate = rows_duplicate + 1
             WHERE id = ?
            """,
            [.integer(Int64(batchId))])
    }

    /// `markCrossFormatSourceDuplicate`: one unit — the row settles only from its current
    /// status, and the batch's counters move by what that status was.
    static func markCrossFormatSourceDuplicate(
        _ session: BackendSession, _ row: ReconciliationSourceRow
    ) throws -> Bool {
        let changed = try session.rows(
            """
            UPDATE portfolio_import_staging_rows
               SET status = 'duplicate', error_message = NULL
             WHERE id = ? AND batch_id = ? AND status = ?
               AND status IN ('matched', 'error')
            RETURNING id
            """,
            [.integer(Int64(row.id.rawValue)), .integer(Int64(row.batchID.rawValue)), .text(row.status.rawValue)])
        let count = changed.count
        guard count > 0 else { return false }
        let errorCount = row.status.rawValue == "error" ? count : 0  // lint:allow string-literal-compare the staged row statuses
        let batchRows = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET rows_duplicate = rows_duplicate + ?,
                   rows_error = max(rows_error - ?, 0)
             WHERE id = ?
            RETURNING id
            """,
            [.integer(Int64(count)), .integer(Int64(errorCount)), .integer(Int64(row.batchID.rawValue))])
        return batchRows.count == 1
    }
}

// MARK: - Scope commit

extension PortfolioImportCommitArea {
    /// `applyPortfolioImportReconciliation`: the plan's adoptions and settlements, under the
    /// caller's locks. An unready plan writes nothing.
    static func applyReconciliation(
        _ session: BackendSession, _ scope: PortfolioImportReconciliationArea.Scope
    ) throws -> (result: ReconciliationPlanResult, adoptedByBatch: [Int: Int], settledByBatch: [Int: Int]) {
        let loaded = try PortfolioImportReconciliationArea.loadPlan(session, scope)
        let result = loaded.result
        if !result.plan.ready {
            throw BackendHTTPError.conflict(
                "Import needs reconciliation before any history can be changed",
                details: .object([
                    "reason": .string("reconciliation_required"),
                    "blockers": .array(result.plan.blockers.map { $0.jsonValue.envelopeValue }),
                ]))
        }
        try PortfolioImportReconciliationArea.assertProjectedHistory(
            loaded.history,
            try PortfolioImportReconciliationArea.projectedHistory(
                result, rows: loaded.rows, history: loaded.history))
        var adoptedByBatch: [Int: Int] = [:]
        for adoption in result.adoptions {
            guard let persisted = try compareAndSetReconciledTransaction(
                session, adoption.before, adoption.after)
            else {
                throw BackendHTTPError.conflict(
                    "An existing portfolio transaction changed during reconciliation",
                    details: .object(["reason": .string("stale_existing_transaction")]))
            }
            _ = try insertReconciliationReceipt(
                session, batchId: adoption.row.batchID.rawValue,
                stagingRowId: adoption.row.id.rawValue,
                transactionId: adoption.before.id.rawValue,
                action: "adopt", policy: adoption.policy.rawValue,
                before: adoption.before, after: persisted)
            try markAdoptedSourceDuplicate(
                session, adoption.row.id.rawValue, adoption.row.batchID.rawValue)
            adoptedByBatch[adoption.row.batchID.rawValue, default: 0] += 1
        }
        var settledByBatch: [Int: Int] = [:]
        func settle(_ row: ReconciliationSourceRow, adopted: Bool) throws {
            guard try markCrossFormatSourceDuplicate(session, row) else {
                throw BackendHTTPError.conflict(
                    "An import row changed during reconciliation",
                    details: .object(["reason": .string("stale_existing_transaction")]))
            }
            if !adopted {
                settledByBatch[row.batchID.rawValue, default: 0] += 1
            }
        }
        for row in result.settledDuplicates { try settle(row, adopted: false) }
        for adoption in result.cashAdoptions {
            try writeCashAdoption(session, adoption: adoption)
            try settle(adoption.row, adopted: true)
            adoptedByBatch[adoption.row.batchID.rawValue, default: 0] += 1
        }
        return (result, adoptedByBatch, settledByBatch)
    }
}

extension PortfolioImportCommitArea {

extension PortfolioImportCommitArea {
    /// `writeCashAdoption`: apply one planned cash correction only while the transaction
    /// still matches the plan's before image, and journal both images with the proof.
    static func writeCashAdoption(
        _ session: BackendSession, adoption: PlanCashAdoption
    ) throws {
        let decision = adoption.decision
        let row = adoption.row
        guard let before = try session.row(
            """
            SELECT t.id, t.date, t.amount, t.currency, t.memo, t.account_id, t.is_active,
                   t.dedup_fingerprint, t.source_record_hash
              FROM transactions t
             WHERE t.id = ?
            """,
            [.integer(Int64(decision.transactionID.rawValue))])
        else {
            throw staleCash()
        }
        let isActive = try before.optionalBool("is_active") ?? false
        let accountId = try before.optionalInt64("account_id").flatMap { Int(exactly: $0) }
        let day = String(try before.text("date").prefix(10))
        let amount = try before.optionalText("amount")
        let currency = try before.optionalText("currency")
        let memo = try before.optionalText("memo")
        let fingerprint = try before.optionalText("dedup_fingerprint")
        let sourceHash = try before.optionalText("source_record_hash")
        let amountMatches = try equalNumber(amount, decision.existing.amount, 4)
        guard isActive,
            accountId == row.accountID?.rawValue,
            day == decision.existing.day,
            currency == decision.existing.currency.rawValue,
            amountMatches,
            decision.reason != .manualCash || (fingerprint == nil && sourceHash == nil)
        else {
            throw staleCash()
        }
        _ = try session.rows(
            """
            UPDATE transactions SET
               amount = vision_numeric(?, 18, 4),
               currency = ?,
               dedup_fingerprint = ?,
               dedup_fingerprint_version = ?,
               updated_at = now()
             WHERE id = ?
            RETURNING id
            """,
            [.text(decision.after.amount), .text(decision.after.currency.rawValue),
             row.dedupFingerprint.map { SQLValue.text($0) } ?? .null,
             row.dedupFingerprintVersion.map { SQLValue.integer(Int64($0)) } ?? .null,
             .integer(Int64(decision.transactionID.rawValue))])
        _ = try session.rows(
            """
            INSERT INTO portfolio_import_reconciliation_journal (
                batch_id, staging_row_id, transaction_id, action, policy, before_data, after_data
            ) VALUES (?, ?, ?, 'adopt', ?, ?, ?) RETURNING id
            """,
            [.integer(Int64(row.batchID.rawValue)), .integer(Int64(row.id.rawValue)),
             .integer(Int64(decision.transactionID.rawValue)), .text(decision.policy.rawValue),
             .text(try cashEnvelope(amount, currency: currency, memo: memo, decision: decision, row: row, after: false)),
             .text(try cashEnvelope(decision.after.amount, currency: decision.after.currency.rawValue, memo: memo, decision: decision, row: row, after: true))])
    }

    private static func staleCash() -> BackendHTTPError {
        BackendHTTPError.conflict(
            "An existing cash transaction changed during reconciliation",
            details: .object(["reason": .string("stale_existing_transaction")]))
    }

    /// `equalNumber` of the reconciliation service: both parse, then compare at `places`.
    static func equalNumber(_ left: String?, _ right: String?, _ places: Int) throws -> Bool {
        guard let left, let right else { return left == nil && right == nil }
        return try DecimalJS.from(left).toDecimalPlaces(places)
            .eq(try DecimalJS.from(right).toDecimalPlaces(places))
    }

    /// The `IbkrCashProof` + snapshot envelope the journal's data columns hold.
    static func cashEnvelope(
        _ amount: String, currency: String, memo: String?, decision: CashAdoptionDecision,
        row: ReconciliationSourceRow, after: Bool
    ) throws -> String {
        func binding(_ source: CashAdoptionDecision.Original) -> JSONValue {
            .object([
                "id": .int(source.stagingRowID.rawValue),
                "batch_id": .int(source.batchID.rawValue),
                "account_id": row.accountID.map { JSONValue.int($0.rawValue) } ?? .null,
                "custom_config": .null,
                "staging": .object([:]),
            ])
        }
        let imported = CashAdoptionDecision.Original(
            batchID: row.batchID, stagingRowID: row.id)
        let proof: JSONValue
        if decision.reason == .ibkrNativeFunding, let original = decision.original {
            proof = .object([
                "kind": .string("ibkr_native_funding"),
                "version": .int(1),
                "original": .object([
                    "batchId": .int(original.batchID.rawValue),
                    "stagingRowId": .int(original.stagingRowID.rawValue),
                ]),
                "native": .object([
                    "batchId": .int(imported.batchID.rawValue),
                    "stagingRowId": .int(imported.stagingRowID.rawValue),
                ]),
                "sourceBindings": .array([binding(original), binding(imported)]),
            ])
        } else {
            proof = .object([
                "kind": .string("cash_adoption"),
                "version": .int(1),
                "sourceBindings": .array([binding(imported)]),
            ])
        }
        let fingerprint = after ? row.dedupFingerprint : nil
        let version = after ? row.dedupFingerprintVersion : nil
        let snapshot: JSONValue = .object([
            "id": .int(decision.transactionID.rawValue),
            "date": .string(decision.existing.day),
            "amount": .string(amount),
            "currency": .string(currency),
            "account_id": row.accountID.map { JSONValue.int($0.rawValue) } ?? .null,
            "memo": memo.map { JSONValue.string($0) } ?? .null,
            "dedup_fingerprint": fingerprint.map { JSONValue.string($0) } ?? .null,
            "dedup_fingerprint_version": version.map { JSONValue.int($0) } ?? .null,
            "is_active": .bool(true),
        ])
        return String(decoding: try JSONEncoder().encode(
            JSONValue.object([
                "ledgerKind": .string("cash"),
                "version": .int(1),
                "snapshot": snapshot,
                "proof": proof,
            ])), as: UTF8.self)
    }
}

    /// still matches the plan's before image, and journal both images with the proof.
    static func writeCashAdoption(
        _ session: BackendSession, adoption: PlanCashAdoption
    ) throws {
        let decision = adoption.decision
        let row = adoption.row
        guard let before = try session.row(
            """
            SELECT t.id, t.date, t.amount, t.currency, t.account_id, t.is_active,
                   t.dedup_fingerprint, t.source_record_hash
              FROM transactions t
             WHERE t.id = ?
            """,
            [.integer(Int64(decision.transactionID.rawValue))])
        else {
            throw BackendHTTPError.conflict(
                "An existing cash transaction changed during reconciliation",
                details: .object(["reason": .string("stale_existing_transaction")]))
        }
        func decimalText(_ value: SQLValue) throws -> String? {
            if case .text(let text) = value { return text }
            if case .integer(let int) = value { return String(int) }
            if case .real(let real) = value { return String(real) }
            return nil
        }
        let isActive = (try before.int64("is_active")) != 0
        let accountId = try before.optionalInt64("account_id").flatMap { Int(exactly: $0) }
        let day = try PortfolioImportReconciliationArea.shiftDayBack(try before.text("date"))
        let amount = try decimalText(try before.value("amount"))
        let currency = try before.optionalText("currency")
        let fingerprint = try before.optionalText("dedup_fingerprint")
        let sourceHash = try before.optionalText("source_record_hash")
        let amountMatches = try CashLedgerValues.equalAmount4(
            amount, decision.existing.amount)
        guard isActive,
            accountId == row.accountID?.rawValue,
            day == decision.existing.day,
            currency == decision.existing.currency.rawValue,
            amountMatches,
            decision.reason == .manualCash
                ? (fingerprint == nil && sourceHash == nil)
                : true
        else {
            throw BackendHTTPError.conflict(
                "An existing cash transaction changed during reconciliation",
                details: .object(["reason": .string("stale_existing_transaction")]))
        }
        _ = try session.rows(
            """
            UPDATE transactions SET
               amount = vision_numeric(?, 18, 4),
               currency = ?,
               dedup_fingerprint = ?,
               dedup_fingerprint_version = ?,
               updated_at = now()
             WHERE id = ?
            RETURNING id
            """,
            [.text(decision.after.amount), .text(decision.after.currency.rawValue),
             row.dedupFingerprint.map { SQLValue.text($0) } ?? .null,
             row.dedupFingerprintVersion.map { SQLValue.integer(Int64($0)) } ?? .null,
             .integer(Int64(decision.transactionID.rawValue))])
        _ = try session.rows(
            """
            INSERT INTO portfolio_import_reconciliation_journal (
                batch_id, staging_row_id, transaction_id, action, policy, before_data, after_data
            ) VALUES (?, ?, ?, 'adopt', ?, ?, ?) RETURNING id
            """,
            [.integer(Int64(row.batchID.rawValue)), .integer(Int64(row.id.rawValue)),
             .integer(Int64(decision.transactionID.rawValue)), .text(decision.policy.rawValue),
             .text(try cashEnvelope(before: before, decision: decision, row: row)),
             .text(try cashEnvelope(after: true, decision: decision, row: row))])
    }

    /// The `IbkrCashProof` + snapshot envelope the journal's data columns hold.
    static func cashEnvelope(
        after: Bool = false, before: SQLRow? = nil, decision: CashAdoptionDecision,
        row: ReconciliationSourceRow
    ) throws -> String {
        func binding(_ source: CashAdoptionDecision.Original) -> JSONValue {
            .object([
                "id": .int(source.stagingRowID.rawValue),
                "batch_id": .int(source.batchID.rawValue),
                "account_id": row.accountID.map { JSONValue.int($0.rawValue) } ?? .null,
                "custom_config": .null,
                "staging": .object([:]),
            ])
        }
        let imported = CashAdoptionDecision.Original(
            batchID: row.batchID, stagingRowID: row.id)
        let proof: JSONValue
        if decision.reason == .ibkrNativeFunding, let original = decision.original {
            proof = .object([
                "kind": .string("ibkr_native_funding"),
                "version": .int(1),
                "original": .null,
                "native": .object([
                    "batchId": .int(imported.batchID.rawValue),
                    "stagingRowId": .int(imported.stagingRowID.rawValue),
                ]),
                "sourceBindings": .array([binding(original), binding(imported)]),
            ])
        } else {
            proof = .object([
                "kind": .string("cash_adoption"),
                "version": .int(1),
                "sourceBindings": .array([binding(imported)]),
            ])
        }
        let amount = after ? decision.after.amount : decision.existing.amount
        let currency = after ? decision.after.currency.rawValue : decision.existing.currency.rawValue
        let fingerprint = after ? row.dedupFingerprint : nil
        let version = after ? row.dedupFingerprintVersion : nil
        let snapshot: JSONValue = .object([
            "id": .int(decision.transactionID.rawValue),
            "date": .string(decision.existing.day),
            "amount": .string(amount),
            "currency": .string(currency),
            "account_id": row.accountID.map { JSONValue.int($0.rawValue) } ?? .null,
            "memo": before.map { try row -> JSONValue in .null } ?? .null,
            "dedup_fingerprint": fingerprint.map { JSONValue.string($0) } ?? .null,
            "dedup_fingerprint_version": version.map { JSONValue.int($0) } ?? .null,
            "is_active": .bool(true),
        ])
        return String(decoding: try JSONEncoder().encode(
            JSONValue.object([
                "ledgerKind": .string("cash"),
                "version": .int(1),
                "snapshot": snapshot,
                "proof": proof,
            ])), as: UTF8.self)
    }
}

// MARK: - Custody commits

/// The approved custody scope `withPortfolioCustodyImportScope` holds. The pipeline's
/// unscoped path passes nil: its history is unfiltered and no approval is required.
struct CustodyImportScope: Sendable {
    /// eventKey → approved signature.
    var approved: [String: String]
}

extension PortfolioImportCommitArea {
    /// The reviewed scope's approval of one event, or the reason it is out of scope.
    static func custodyScopeCheck(
        _ scope: CustodyImportScope?, _ signature: String, _ key: String
    ) throws {
        guard let scope else { return }
        guard scope.approved[key] == signature else {
            throw BackendHTTPError.conflict("Custody write is outside its reviewed transaction scope")
        }
    }

    /// `validatePortfolioAssetTransferHistory`: chronology and custody, independent of
    /// the cost-basis selection.
    static func validateCustodyHistory(_ txns: [PortfolioCore.Txn]) throws {
        guard txns.contains(where: { PortfolioCustody.custodyEventTypes.contains($0.type) }) else {
            return
        }
        guard PortfolioCore.areLotsFullyAssigned(txns) else {
            throw BackendHTTPError.conflict(
                "Asset custody events require the original acquisitions to be reconciled"
                + " to their source accounts")
        }
        do {
            for method in PortfolioCore.costBasisMethods {
                _ = try PortfolioCustody.projectAssetTransferPartitions(txns, method: method)
            }
            if try !PortfolioCore.partitionOversellDeficits(txns).isEmpty {
                throw PortfolioCore.Failure(message: "Custody history contains an oversell")
            }
        } catch let error as BackendHTTPError {
            throw error
        } catch {
            throw BackendHTTPError.conflict(
                "Asset transfer custody history is invalid: \(String(describing: error))")
        }
    }

    /// The custody accounts a transfer names: both must exist, be active, and support custody.
    static func assertCustodyAccounts(
        _ session: BackendSession, _ accountIds: [Int]
    ) throws {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let placeholders = accountIds.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT a.id, a.is_active, a.type
              FROM accounts a
             WHERE a.id IN (\(placeholders))
             ORDER BY a.id
            """,
            accountIds.map { .integer(Int64($0)) })
        let valid = try rows.filter { row in
            (try row.optionalBool("is_active") ?? false)
                && portfolioAccountTypes.contains(try row.text("type"))
        }
        guard rows.count == accountIds.count, valid.count == rows.count else {
            throw BackendHTTPError.conflict("Asset transfer accounts must be active")
        }
    }

    /// `commitPortfolioAssetTransfer`: the canonical event, with its per-method fee-basis
    /// allocations. A matching fingerprint is a duplicate; a conflicting one is a 409.
    static func commitAssetTransfer(
        _ session: BackendSession, row: ReconciliationSourceRow, batchId: Int,  // lint:allow raw-id business table ids of the TypeScript route and repository writes
        scope: CustodyImportScope?
    ) throws -> (id: Int, duplicate: Bool) {
        let prepared = try PortfolioCustodyPreviews.assetTransfer(row)
        guard case .event(let event) = prepared else {
            let reason = (prepared as? CustodyPreview<AssetTransferEvent>)
            let message: String
            if case .error(let block)? = reason {
                message = "Asset transfer requires repair: \(block.rawValue)"
            } else {
                message = "Asset transfer requires repair"
            }
            throw BackendHTTPError.validation(message)
        }
        try assertCustodyAccounts(session, [event.sourceAccountID.rawValue, event.destinationAccountID.rawValue])
        let existing = try session.row(
            """
            SELECT t.id, t.investment_id, t.source_account_id, t.destination_account_id,
                   to_char(t.date, 'YYYY-MM-DD') AS date, t.units, t.fee_units
              FROM portfolio_asset_transfers t
             WHERE t.dedup_fingerprint = ? AND t.dedup_fingerprint_version = ?
            """,
            [.text(event.dedupFingerprint), .integer(Int64(event.dedupFingerprintVersion))])
        if let existing {
            let storedInvestment = try existing.optionalInt64("investment_id").flatMap { Int(exactly: $0) }
            let storedSource = try existing.optionalInt64("source_account_id").flatMap { Int(exactly: $0) }
            let storedDestination = try existing.optionalInt64("destination_account_id").flatMap { Int(exactly: $0) }
            let storedDate = try existing.optionalText("date")
            let storedUnits = try existing.optionalText("units")
            let storedFeeUnits = try existing.optionalText("fee_units")
            guard storedInvestment == event.investmentID.rawValue,
                storedSource == event.sourceAccountID.rawValue,
                storedDestination == event.destinationAccountID.rawValue,
                storedDate == event.day,
                try DecimalJS.from(storedUnits ?? "0").eq(try DecimalJS.from(event.units)),
                try DecimalJS.from(storedFeeUnits ?? "0").eq(try DecimalJS.from(event.feeUnits))
            else {
                throw BackendHTTPError.conflict(
                    "Asset transfer source identity conflicts with existing custody history")
            }
            return (Int(try existing.int64("id")), true)
        }
        let signature = transferSignature(row, event, batchId: batchId)
        try custodyScopeCheck(
            scope, signature, "\(batchId):\(row.id.rawValue)")
        var history = try PortfolioTransactionsArea.unitEvents(session, event.investmentID.rawValue)
        if scope != nil {
            history = history.filter { $0.date <= event.day }
        }
        let eventTxn = transferTxn(row, event, batchId: batchId)
        try validateCustodyHistory(history.map(\.txn) + [eventTxn])
        var feeBasisAllocations: [String: JSONValue] = [:]
        for method in PortfolioCore.costBasisMethods {
            let projected = try PortfolioCustody.projectAssetTransferPartitions(
                history.map(\.txn) + [eventTxn], method: method)
            let legs = projected.rows(of: Double(event.sourceAccountID.rawValue))
            guard let leg = legs.first(where: { $0.type == "transfer_out"  // lint:allow string-literal-compare the partition engine's leg kinds
                && $0.id == eventTxn.id })
            else {
                throw RequiredValueError(message: "the validated history holds the transfer_out leg")
            }
            let lots = leg.assetFeeLots.filter { try $0.units.gt(DecimalJS.zero) }
            feeBasisAllocations[method] = .object([
                "feeUnits": .string(event.feeUnits),
                "lots": .array(lots.map { lot in
                    .object([
                        "acquisitionId": .int(Int(lot.acquisitionId)),
                        "acquisitionDate": .string(lot.acquiredDate),
                        "currency": lot.currency.map { JSONValue.string($0) } ?? .null,
                        "units": .string(lot.units.description),
                        "nativeBasis": .string(lot.costBasis.description),
                        "eurBasis": lot.fxResolved
                            ? .string(lot.costBasisConv.description) : .null,
                    ])
                }),
            ])
        }
        let allocationsJSON = String(
            decoding: try JSONEncoder().encode(JSONValue.object(feeBasisAllocations)), as: UTF8.self)
        let inserted = try session.rows(
            """
            INSERT INTO portfolio_asset_transfers (
                investment_id, source_account_id, destination_account_id, date, units,
                fee_units, import_batch_id, staging_row_id, source_record_hash,
                dedup_fingerprint, dedup_fingerprint_version, fee_basis_allocations
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vision_jsonb(?)) RETURNING id
            """,
            [.integer(Int64(event.investmentID.rawValue)),
             .integer(Int64(event.sourceAccountID.rawValue)),
             .integer(Int64(event.destinationAccountID.rawValue)),
             .text(event.day), .text(event.units), .text(event.feeUnits),
             .integer(Int64(batchId)), .integer(Int64(row.id.rawValue)),
             row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
             .text(event.dedupFingerprint), .integer(Int64(event.dedupFingerprintVersion)),
             .text(allocationsJSON)])
        guard let id = try inserted.first?.optionalInt64("id") else {
            throw RequiredValueError(message: "asset transfer insert returned no row")
        }
        return (Int(id), false)
    }

    /// `signature(event)` of `portfolioCustodyImportScope.ts`, as the approved scope holds it.
    static func transferSignature(
        _ row: ReconciliationSourceRow, _ event: AssetTransferEvent, batchId: Int  // lint:allow raw-id the ids the reviewed scope's signature carries
    ) -> String {
        let object: [(String, JSONValue)] = [
            ("type", .string("asset_transfer")),
            ("investment", .int(event.investmentID.rawValue)),
            ("account", .null),
            ("source", .int(event.sourceAccountID.rawValue)),
            ("destination", .int(event.destinationAccountID.rawValue)),
            ("date", .string(event.day)),
            ("units", .string((try? DecimalJS.from(event.units).toFixed()) ?? event.units)),
            ("feeUnits", .string((try? DecimalJS.from(event.feeUnits).toFixed()) ?? event.feeUnits)),
            ("adjustmentKind", .null),
            ("basisPolicy", .null),
            ("eligibleSourceHashes", .null),
            ("sourceRecordHash", row.sourceRecordHash.map { JSONValue.string($0) } ?? .null),
            ("fingerprint", .string(event.dedupFingerprint)),
            ("fingerprintVersion", .int(event.dedupFingerprintVersion)),
        ]
        return String(
            decoding: (try? JSONEncoder().encode(
                JSONValue.object(Dictionary(uniqueKeysWithValues: object)))) ?? Data(),
            as: UTF8.self)
    }

    /// The transfer event as the partition engine replays it (`asPartitionedTxns`).
    static func transferTxn(
        _ row: ReconciliationSourceRow, _ event: AssetTransferEvent, batchId: Int  // lint:allow raw-id the ids the partition engine replays
    ) -> PortfolioCore.Txn {
        PortfolioCore.Txn(
            id: Double(row.id.rawValue), type: "asset_transfer", date: event.day,
            units: .text(event.units), amount: .text("0"), fees: .text("0"), taxes: .text("0"),
            accountId: nil, sourceAccountId: Double(event.sourceAccountID.rawValue),
            destinationAccountId: Double(event.destinationAccountID.rawValue),
            feeUnits: .text(event.feeUnits),
            sourceRecordHash: row.sourceRecordHash)
    }
}
