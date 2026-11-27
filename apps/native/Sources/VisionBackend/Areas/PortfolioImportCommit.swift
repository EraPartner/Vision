import Foundation
import VisionNativeCore

/// The P18 commit routes: `commitPortfolioImportBatch` (`POST /batches/:id/commit`)
/// and `commitReviewedPortfolioImports` (`POST /reconciliation/commit`) — the
/// portfolio import pipeline's commit half (`portfolioImportPipeline/commit.ts`),
/// the reviewed-scope commit (`portfolioImportCommitService.ts`) and the
/// reconciliation apply half (`applyPortfolioImportReconciliation`).
enum PortfolioImportCommitArea {
    /// `parseBatchIdParam` reuses the shared id guard the batches area holds.
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
            [.integer(Int64(accountId))])
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
            [.integer(Int64(batchId))])
        else { return nil }
        return LockedBatch(
            id: Int(try row.int64("id")),
            status: try row.text("status"),
            isBrokerage: (try row.int64("is_brokerage")) != 0,
            adapterName: try row.optionalText("adapter_name"),
            customConfig: (try row.optionalText("custom_config"))
                .map(PortfolioImportReconciliationArea.storedConfig)
                ?? .text(""),
            accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
        )
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
            throw PortfolioImportReconciliationArea.RequiredValueError(message: "reconciliation receipt insert")
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
             .text(try cashEnvelope(amount ?? decision.existing.amount, currency: currency ?? decision.existing.currency.rawValue, memo: memo, decision: decision, row: row, after: false)),
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
            try (try row.optionalBool("is_active") ?? false)
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
                throw PortfolioImportReconciliationArea.RequiredValueError(message: "the validated history holds the transfer_out leg")
            }
            let lots = try (leg.assetFeeLots ?? []).filter { try $0.units.gt(DecimalJS.zero) }
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
            throw PortfolioImportReconciliationArea.RequiredValueError(message: "asset transfer insert returned no row")
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
            ("units", .string((try? DecimalJS.from(event.units).toFixed) ?? event.units)),
            ("feeUnits", .string((try? DecimalJS.from(event.feeUnits).toFixed) ?? event.feeUnits)),
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

extension PortfolioImportCommitArea {
    /// `getEligibleYieldSources`: the zero-basis acquisitions a reversal may consume, with
    /// the staging row each hash settles through.
    static func eligibleYieldSources(
        _ session: BackendSession, investmentId: Int, accountId: Int?  // lint:allow raw-id the ids the repository query binds
    ) throws -> [(hash: String, stagingRowId: Int)] {  // lint:allow raw-id the staged rows the reversal settles through
        guard let accountId else { return [] }
        let rows = try session.rows(
            """
            SELECT s.source_record_hash, CAST(min(s.id) AS TEXT) AS staging_row_id
              FROM portfolio_import_staging_rows s
              INNER JOIN portfolio_import_batches b ON b.id = s.batch_id
             WHERE COALESCE(s.user_override_investment_id, s.resolved_investment_id) = ?
               AND b.account_id = ?
               AND s.type = 'gift'
               AND s.asset_adjustment_details ->> 'kind' = 'yield_acquisition'
               AND s.asset_adjustment_details ->> 'basisPolicy' = 'zero'
               AND s.status IN ('matched', 'committed', 'duplicate')
               AND s.source_record_hash IS NOT NULL
             GROUP BY s.source_record_hash
             ORDER BY s.source_record_hash
            """,
            [.integer(Int64(investmentId)), .integer(Int64(accountId))])
        return try rows.map { row in
            (hash: try row.text("source_record_hash"),
             stagingRowId: Int(try row.text("staging_row_id")) ?? 0)  // lint:allow raw-id the BIGINT id the repository reads back as text
        }
    }

    /// `commitPortfolioAssetAdjustment`: the canonical event with its consumed-lot basis
    /// allocations. A matching fingerprint is a duplicate; a conflicting one is a 409.
    static func commitAssetAdjustment(
        _ session: BackendSession, row: ReconciliationSourceRow, batchId: Int,  // lint:allow raw-id business table ids of the TypeScript route and repository writes
        scope: CustodyImportScope?
    ) throws -> (id: Int, duplicate: Bool) {
        let prepared = try PortfolioCustodyPreviews.assetAdjustment(row)
        guard case .event(let event) = prepared else {
            let message: String
            if case .error(let block)? = prepared as? CustodyPreview<AssetAdjustmentEvent> {
                message = "Asset adjustment requires repair: \(block.rawValue)"
            } else {
                message = "Asset adjustment requires repair"
            }
            throw BackendHTTPError.validation(message)
        }
        let account = try session.row(
            """
            SELECT a.is_active, a.type
              FROM accounts a
             WHERE a.id = ?
            """,
            [.integer(Int64(event.accountID.rawValue))])
        let active = try account?.optionalBool("is_active") ?? false
        let type = try account?.optionalText("type")
        guard active, type.map({ portfolioAccountTypes.contains($0) }) == true else {
            throw BackendHTTPError.conflict(
                "Asset adjustment account must be active and support custody")
        }
        let existing = try session.row(
            """
            SELECT a.id, a.investment_id, a.account_id, to_char(a.date, 'YYYY-MM-DD') AS date,
                   a.units, a.adjustment_kind, a.basis_policy
              FROM portfolio_asset_adjustments a
             WHERE a.dedup_fingerprint = ? AND a.dedup_fingerprint_version = ?
            """,
            [.text(event.dedupFingerprint), .integer(Int64(event.dedupFingerprintVersion))])
        if let existing {
            let storedInvestment = try existing.optionalInt64("investment_id").flatMap { Int(exactly: $0) }
            let storedAccount = try existing.optionalInt64("account_id").flatMap { Int(exactly: $0) }
            let storedDate = try existing.optionalText("date")
            let storedUnits = try existing.optionalText("units")
            let storedKind = try existing.optionalText("adjustment_kind")
            let storedPolicy = try existing.optionalText("basis_policy")
            guard storedInvestment == event.investmentID.rawValue,
                storedAccount == event.accountID.rawValue,
                storedDate == event.day,
                try DecimalJS.from(storedUnits ?? "0").eq(try DecimalJS.from(event.units)),
                storedKind == event.kind.rawValue,
                storedPolicy == event.basisPolicy.rawValue
            else {
                throw BackendHTTPError.conflict(
                    "Asset adjustment identity conflicts with existing unit history")
            }
            return (Int(try existing.int64("id")), true)
        }
        let sources = event.kind == .yieldReversal
            ? try eligibleYieldSources(session, investmentId: event.investmentID.rawValue, accountId: event.accountID.rawValue)
            : []
        let eligibleHashes = sources.map(\.hash)
        let signature = adjustmentSignature(row, event, batchId: batchId, hashes: eligibleHashes)
        try custodyScopeCheck(scope, signature, "\(batchId):\(row.id.rawValue)")
        var history = try PortfolioTransactionsArea.unitEvents(session, event.investmentID.rawValue)
        if scope != nil {
            history = history.filter { $0.date <= event.day }
        }
        let eventTxn = adjustmentTxn(row, event, batchId: batchId, hashes: eligibleHashes)
        try validateCustodyHistory(history.map(\.txn) + [eventTxn])
        var basisAllocations: [String: JSONValue] = [:]
        for method in PortfolioCore.costBasisMethods {
            let projected = try PortfolioCustody.projectAssetTransferPartitions(
                history.map(\.txn) + [eventTxn], method: method)
            let legs = projected.rows(of: Double(event.accountID.rawValue))
            guard let leg = legs.first(where: {
                $0.id == eventTxn.id
                    && ($0.type == "unit_reversal"  // lint:allow string-literal-compare the partition engine's leg kinds
                        || $0.type == "asset_fee")  // lint:allow string-literal-compare the partition engine's leg kinds
            })
            else {
                throw PortfolioImportReconciliationArea.RequiredValueError(message: "the validated history holds the adjustment leg")
            }
            basisAllocations[method] = .object([
                "units": .string(event.units),
                "lots": .array(leg.consumedLots.map { lot in
                    .object([
                        "acquisitionId": .int(Int(lot.acquisitionId)),
                        "acquisitionDate": .string(lot.acquiredDate),
                        "sourceRecordHash": lot.sourceRecordHash.map { JSONValue.string($0) } ?? .null,
                        "currency": lot.currency.map { JSONValue.string($0) } ?? .null,
                        "units": .string(lot.units.description),
                        "nativeBasis": .string(lot.costBasis.description),
                        "eurBasis": lot.costBasis.eq(DecimalJS.zero)
                            ? .string("0")
                            : (lot.fxResolved ? .string(lot.costBasisConv.description) : .null),
                    ])
                }),
            ])
        }
        let allocationsJSON = String(
            decoding: try JSONEncoder().encode(JSONValue.object(basisAllocations)), as: UTF8.self)
        let hashesJSON = String(
            decoding: try JSONEncoder().encode(JSONValue.array(eligibleHashes.map { JSONValue.string($0) })),
            as: UTF8.self)
        let inserted = try session.rows(
            """
            INSERT INTO portfolio_asset_adjustments (
                investment_id, account_id, date, units, adjustment_kind, basis_policy,
                basis_allocations, eligible_source_record_hashes, import_batch_id,
                staging_row_id, source_record_hash, dedup_fingerprint, dedup_fingerprint_version
            ) VALUES (?, ?, ?, ?, ?, ?, vision_jsonb(?), ?, ?, ?, ?, ?, ?) RETURNING id
            """,
            [.integer(Int64(event.investmentID.rawValue)),
             .integer(Int64(event.accountID.rawValue)),
             .text(event.day), .text(event.units),
             .text(event.kind.rawValue), .text(event.basisPolicy.rawValue),
             .text(allocationsJSON), .text(hashesJSON),
             .integer(Int64(batchId)), .integer(Int64(row.id.rawValue)),
             row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
             .text(event.dedupFingerprint), .integer(Int64(event.dedupFingerprintVersion))])
        guard let id = try inserted.first?.optionalInt64("id") else {
            throw PortfolioImportReconciliationArea.RequiredValueError(message: "asset adjustment insert returned no row")
        }
        for source in sources {
            _ = try session.rows(
                """
                INSERT INTO portfolio_asset_adjustment_sources (
                    adjustment_id, staging_row_id, source_record_hash
                ) VALUES (?, ?, ?) RETURNING id
                """,
                [.integer(Int64(id)), .integer(Int64(source.stagingRowId)), .text(source.hash)])
        }
        return (Int(id), false)
    }

    /// `signature(event)` for an adjustment, with its eligible source hashes.
    static func adjustmentSignature(
        _ row: ReconciliationSourceRow, _ event: AssetAdjustmentEvent, batchId: Int,  // lint:allow raw-id the ids the reviewed scope's signature carries
        hashes: [String]
    ) -> String {
        let object: [(String, JSONValue)] = [
            ("type", .string("asset_adjustment")),
            ("investment", .int(event.investmentID.rawValue)),
            ("account", .int(event.accountID.rawValue)),
            ("source", .null),
            ("destination", .null),
            ("date", .string(event.day)),
            ("units", .string((try? DecimalJS.from(event.units).toFixed) ?? event.units)),
            ("feeUnits", .null),
            ("adjustmentKind", .string(event.kind.rawValue)),
            ("basisPolicy", .string(event.basisPolicy.rawValue)),
            ("eligibleSourceHashes", .array(hashes.sorted().map { JSONValue.string($0) })),
            ("sourceRecordHash", row.sourceRecordHash.map { JSONValue.string($0) } ?? .null),
            ("fingerprint", .string(event.dedupFingerprint)),
            ("fingerprintVersion", .int(event.dedupFingerprintVersion)),
        ]
        return String(
            decoding: (try? JSONEncoder().encode(
                JSONValue.object(Dictionary(uniqueKeysWithValues: object)))) ?? Data(),
            as: UTF8.self)
    }

    /// The adjustment event as the partition engine replays it.
    static func adjustmentTxn(
        _ row: ReconciliationSourceRow, _ event: AssetAdjustmentEvent, batchId: Int,  // lint:allow raw-id the ids the partition engine replays
        hashes: [String]
    ) -> PortfolioCore.Txn {
        PortfolioCore.Txn(
            id: Double(row.id.rawValue), type: "asset_adjustment", date: event.day,
            units: .text(event.units), amount: .text("0"), fees: .text("0"), taxes: .text("0"),
            accountId: Double(event.accountID.rawValue),
            adjustmentKind: event.kind.rawValue, basisPolicy: event.basisPolicy.rawValue,
            eligibleSourceRecordHashes: hashes,
            sourceRecordHash: row.sourceRecordHash)
    }
}

extension BackendHTTPError {
    /// A `ConflictError` with the details envelope its route answers.
    static func conflict(_ message: String, details: JSONValue) -> BackendHTTPError {
        BackendHTTPError(status: 409, code: "CONFLICT", message: message, details: details)
    }
}

// MARK: - The commit pipeline drain

extension PortfolioImportCommitArea {
    /// `matchedPortfolioStagingRowSchema`: the projection `commitBatch` drains. `tx_date`
    /// is the 'YYYY-MM-DD' text, `investment_id` the COALESCE of the override and the
    /// resolution, and the investment columns come from the LEFT JOIN.
    struct PipelineRow: Equatable, Sendable {
        var id: Int  // lint:allow raw-id the staged row ids the pipeline drains
        var status: StagingStatus
        var route: StagingRoute?
        var kind: PortfolioEventKind?
        var kindRaw: String?
        var day: String?
        var units: String?
        var pricePerUnit: String?
        var amount: String?
        var fees: String?
        var taxes: String?
        var currency: String?
        var fxRateToEUR: String?
        var note: String?
        var sourceRecordHash: String?
        var sourceReference: String?
        var dedupFingerprint: String?
        var dedupFingerprintVersion: Int?
        var dedupOccurrence: Int?
        var assetTransferDetails: JSObject?
        var assetAdjustmentDetails: JSObject?
        var investmentID: Int?  // lint:allow raw-id the investment ids the pipeline writes
        var assetClass: String?
        var investmentCurrency: String?  // lint:allow raw-currency the LEFT JOIN's raw currency text, bound as the identity key reads it
    }

    /// The batch columns the drain reads, beside its account's labels.
    struct PipelineBatch: Equatable, Sendable {
        var accountID: Int?  // lint:allow raw-id the batch's brokerage sleeve account
        var isBrokerage: Bool
        var customConfig: StoredBatchConfig?
        var accountInstitution: String?
        var accountName: String?
    }

    /// `commitBatchRowSchema` through the LEFT JOIN on the account.
    static func readPipelineBatch(
        _ session: BackendSession, _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> PipelineBatch? {
        guard let row = try session.row(
            """
            SELECT b.account_id, b.is_brokerage, b.custom_config,
                   a.institution AS account_institution, a.name AS account_name
              FROM portfolio_import_batches b
              LEFT JOIN accounts a ON a.id = b.account_id
             WHERE b.id = ?
            """,
            [.integer(Int64(batchId))]
        ) else { return nil }
        return PipelineBatch(
            accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) },
            isBrokerage: (try row.int64("is_brokerage")) != 0,
            customConfig: (try row.optionalText("custom_config"))
                .map(PortfolioImportReconciliationArea.storedConfig),
            accountInstitution: try row.optionalText("account_institution"),
            accountName: try row.optionalText("account_name"))
    }

    /// The matched-row projection: older dates first, source order within a date.
    static func readPipelineRows(
        _ session: BackendSession, _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> [PipelineRow] {
        let rows = try session.rows(
            """
            SELECT isr.id, isr.status, isr.route, isr.type, isr.type_raw,
                   to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
                   isr.units, isr.price_per_unit, isr.amount, isr.fees, isr.taxes,
                   isr.currency, isr.fx_rate_to_eur, isr.note, isr.source_record_hash,
                   isr.source_transaction_id, isr.dedup_fingerprint,
                   isr.dedup_fingerprint_version, isr.dedup_occurrence,
                   isr.asset_transfer_details, isr.asset_adjustment_details,
                   COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) AS investment_id,
                   inv.asset_class, inv.currency AS investment_currency
              FROM portfolio_import_staging_rows isr
              LEFT JOIN investments inv
                 ON inv.id = COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)
             WHERE isr.batch_id = ?
               AND isr.status IN ('matched', 'committed', 'duplicate')
             ORDER BY isr.tx_date ASC, isr.row_index ASC
            """,
            [.integer(Int64(batchId))])
        return try rows.map { row in
            PipelineRow(
                id: Int(try row.int64("id")),
                status: StagingStatus(rawValue: try row.text("status")),
                route: (try row.optionalText("route")).map(StagingRoute.init(rawValue:)),
                kind: (try row.optionalText("type")).map(PortfolioEventKind.init(rawValue:)),
                kindRaw: try row.optionalText("type_raw"),
                day: try row.optionalText("tx_date"),
                units: try row.optionalText("units"),
                pricePerUnit: try row.optionalText("price_per_unit"),
                amount: try row.optionalText("amount"),
                fees: try row.optionalText("fees"),
                taxes: try row.optionalText("taxes"),
                currency: try row.optionalText("currency"),
                fxRateToEUR: try row.optionalText("fx_rate_to_eur"),
                note: try row.optionalText("note"),
                sourceRecordHash: try row.optionalText("source_record_hash"),
                sourceReference: try row.optionalText("source_transaction_id"),
                dedupFingerprint: try row.optionalText("dedup_fingerprint"),
                dedupFingerprintVersion: try row.optionalInt64("dedup_fingerprint_version")
                    .flatMap { Int(exactly: $0) },
                dedupOccurrence: try row.optionalInt64("dedup_occurrence")
                    .flatMap { Int(exactly: $0) },
                assetTransferDetails: try PortfolioImportReconciliationArea.jsonObject(
                    row, "asset_transfer_details"),
                assetAdjustmentDetails: try PortfolioImportReconciliationArea.jsonObject(
                    row, "asset_adjustment_details"),
                investmentID: try row.optionalInt64("investment_id").flatMap { Int(exactly: $0) },
                assetClass: try row.optionalText("asset_class"),
                investmentCurrency: try row.optionalText("investment_currency"))
        }
    }

    /// `Number(value ?? 0)`: a staged decimal text as the number JavaScript parsed.
    static func pipelineNumber(_ text: String?) -> Double? {
        guard let text else { return nil }
        let parsed = JavaScriptNumber.fromString(text)
        return parsed.isFinite ? parsed : Double.nan
    }

    /// `signedCashAmount`: the ledger sign of a staged cash magnitude.
    static func signedCashAmount(_ row: PipelineRow) -> Double {
        let direction = BrokerageRouting.instrumentLessCashDirection(
            kind: row.kind?.rawValue ?? row.kindRaw)
        let magnitude = (pipelineNumber(row.amount) ?? 0).magnitude
        return Double(direction ?? 1) * magnitude
    }

    /// The cash-row memo `cashIdentityKey` and the INSERT share.
    static func cashMemo(_ row: PipelineRow) -> String {
        if let note = row.note, !note.isEmpty { return note }
        if let raw = row.kindRaw, !raw.isEmpty { return raw.uppercased() }
        return "BROKERAGE CASH"
    }

    /// `cashIdentityKey`: (date, signed amount, currency, memo), joined by '|'.
    static func cashIdentityKey(_ row: PipelineRow) -> String {
        let signed = SQLArguments.javaScriptText(signedCashAmount(row))
        let currency = row.currency ?? "EUR"
        return "\(row.day ?? "null")|\(signed)|\(currency)|\(cashMemo(row))"
    }

    /// `countCashFieldMatches`: the ledger occurrences of one cash identity.
    static func countCashFieldMatches(
        _ session: BackendSession, _ accountId: Int, _ row: PipelineRow, _ legacyOnly: Bool  // lint:allow raw-id the sleeve account the probe counts
    ) throws -> Int {  // lint:allow raw-id the sleeve account the probe reads
        let signed = SQLArguments.javaScriptText(signedCashAmount(row))
        var arguments: [SQLValue] = [.integer(Int64(accountId)), .text(row.day ?? "")]
        let amountClause: String
        if row.kind == nil {
            amountClause = "(dec_eq(amount, ?) OR dec_eq(amount, ?))"
            arguments.append(.text(signed))
            arguments.append(.text(SQLArguments.javaScriptText((pipelineNumber(row.amount) ?? 0).magnitude)))
        } else {
            amountClause = "dec_eq(amount, ?)"
            arguments.append(.text(signed))
        }
        arguments.append(.text(row.currency ?? "EUR"))
        arguments.append(.text(cashMemo(row)))
        let legacyClause = legacyOnly ? " AND dedup_fingerprint IS NULL" : ""
        let found = try session.row(
            """
            SELECT COUNT(*) AS n FROM transactions
             WHERE account_id = ? AND date = ? AND \(amountClause)
               AND COALESCE(currency, 'EUR') = ? AND COALESCE(memo, '') = COALESCE(?, '')
               AND is_active = 1\(legacyClause)
            """,
            arguments)
        return try found.map { Int(try $0.int64("n")) } ?? 0
    }

    /// `canonicalTradeValues`: the repository normalization dedup compares against.
    static func canonicalTradeValues(_ row: PipelineRow) throws -> PortfolioTransactionsArea.Normalized {
        try PortfolioTransactionsArea.normalize(
            row.kind?.rawValue, nil, nil,
            row.amount.map { JSValue.string($0) } ?? nil,
            row.units.map { JSValue.string($0) } ?? nil,
            row.pricePerUnit.map { JSValue.string($0) } ?? nil,
            JSValue.number(pipelineNumber(row.fees) ?? 0),
            JSValue.number(pipelineNumber(row.taxes) ?? 0),
            row.fxRateToEUR.flatMap { text in
                pipelineNumber(text).map { JSValue.number($0) }
            },
            assetClass: row.assetClass)
    }

    /// `tradeIdentityKey`: the canonical trade identity, joined by '|'.
    static func tradeIdentityKey(
        _ row: PipelineRow, _ batchAccountId: Int?, _ canonical: PortfolioTransactionsArea.Normalized  // lint:allow raw-id the batch account the identity carries
    ) -> String {
        [
            row.investmentID.map(String.init) ?? "",
            row.day ?? "",
            row.kind?.rawValue ?? "",
            SQLArguments.javaScriptText(canonical.amount ?? 0),
            canonical.units.map { SQLArguments.javaScriptText($0) } ?? "",
            batchAccountId.map(String.init) ?? "",
            row.currency ?? row.investmentCurrency ?? "EUR",
        ].joined(separator: "|")
    }

    /// `countTradeFieldMatches`: the destination occurrences of one trade identity.
    static func countTradeFieldMatches(
        _ session: BackendSession, _ row: PipelineRow, _ batchAccountId: Int?,  // lint:allow raw-id the batch account the probe counts
        _ canonical: PortfolioTransactionsArea.Normalized, _ legacyOnly: Bool
    ) throws -> Int {
        let units = canonical.units.map { SQLValue.text(SQLArguments.javaScriptText($0)) } ?? .null
        let legacyClause = legacyOnly ? " AND dedup_fingerprint IS NULL" : ""
        let found = try session.row(
            """
            SELECT COUNT(*) AS n FROM portfolio_transactions
             WHERE investment_id = ? AND date = ? AND type = ?
               AND dec_eq(amount, ?)
               AND dec_eq(COALESCE(units, '0'), COALESCE(?, '0'))
               AND account_id IS ?
               AND COALESCE(currency, 'EUR') = ?\(legacyClause)
            """,
            [row.investmentID.map { SQLValue.integer(Int64($0)) } ?? .null,
             .text(row.day ?? ""),
             .text(row.kind?.rawValue ?? ""),
             .text(SQLArguments.javaScriptText(canonical.amount ?? 0)),
             units,
             batchAccountId.map { SQLValue.integer(Int64($0)) } ?? .null,
             .text(row.currency ?? row.investmentCurrency ?? "EUR")])
        return try found.map { Int(try $0.int64("n")) } ?? 0
    }

    /// `hasCanonicalFingerprint`: the modern identity probe against a destination table.
    static func hasCanonicalFingerprint(
        _ session: BackendSession, table: String, _ row: PipelineRow
    ) throws -> Bool {
        guard let fingerprint = row.dedupFingerprint, let version = row.dedupFingerprintVersion
        else { return false }
        return try session.row(
            "SELECT 1 AS one FROM \(table) WHERE dedup_fingerprint_version = ? AND dedup_fingerprint = ? LIMIT 1",
            [.integer(Int64(version)), .text(fingerprint)]) != nil
    }

    /// `markRow`: one staged row's terminal status, with its error message cleared.
    static func markPipelineRow(
        _ session: BackendSession, _ id: Int, _ status: String, _ message: String?  // lint:allow raw-id the staged row ids the pipeline marks
    ) throws {
        _ = try session.rows(
            "UPDATE portfolio_import_staging_rows SET status = ?, error_message = ? WHERE id = ?",
            [.text(status), message.map { SQLValue.text($0) } ?? .null, .integer(Int64(id))])
    }

    /// `markCommitted`: the staged row's settled status with its committed ledger row.
    static func markPipelineCommitted(
        _ session: BackendSession, _ id: Int, _ committedTxnId: Int?  // lint:allow raw-id the staged row ids the pipeline marks
    ) throws {
        _ = try session.rows(
            """
            UPDATE portfolio_import_staging_rows
               SET status = 'committed', committed_txn_id = ? WHERE id = ?
            """,
            [committedTxnId.map { SQLValue.integer(Int64($0)) } ?? .null, .integer(Int64(id))])
    }

    /// `truncatedErrorMessage`: `err?.message?.slice(0, 500)` of a caught error.
    static func truncatedErrorMessage(_ error: Error) -> String? {
        if let http = error as? BackendHTTPError {
            return String(http.message.prefix(500))
        }
        if let required = error as? PortfolioImportReconciliationArea.RequiredValueError {
            return String(required.message.prefix(500))
        }
        if let source = error as? PortfolioImportReconciliationArea.SourceRowError {
            return "column \(source.column): Invalid input"
        }
        return nil
    }

    /// `isZeroYieldKinesisBatch`: the Kinesis format under the zero yield-basis policy.
    static func isZeroYieldKinesisBatch(_ config: StoredBatchConfig?) -> Bool {
        let fields = config?.parsedObject ?? JSObject()
        return fields["format"]?.stringValue == "kinesis_transaction_history"  // lint:allow string-literal-compare the stored wire value the TypeScript batch config compares
            && fields["yield_basis_policy"]?.stringValue == "zero"  // lint:allow string-literal-compare the stored wire value the TypeScript batch config compares
    }

    /// `kinesisInKindIncomeRowIds`: the ':income' dividends whose ':units' gift is staged.
    static func kinesisInKindIncomeRowIds(_ rows: [PipelineRow]) -> Set<Int> {
        var units = Set<String>()
        for row in rows {
            guard row.kind == PortfolioEventKind.gift,
                let reference = row.sourceReference, reference.hasSuffix(":units"),
                let hash = row.sourceRecordHash
            else { continue }
            units.insert("\(reference)|\(hash)")
        }
        var ids = Set<Int>()
        for row in rows {
            guard row.kind == PortfolioEventKind.dividend,
                let reference = row.sourceReference, reference.hasSuffix(":income"),
                let hash = row.sourceRecordHash,
                units.contains("\(String(reference.dropLast(":income".count))):units|\(hash)")
            else { continue }
            ids.insert(row.id)
        }
        return ids
    }

    /// `findCorrectedIbkrCashAlias`: a native funding correction's receipt still owns this
    /// fingerprint, so a repeat of the original row is that corrected record.
    static func findCorrectedIbkrCashAlias(_ session: BackendSession, _ row: PipelineRow) throws -> Int? {
        guard let fingerprint = row.dedupFingerprint, let version = row.dedupFingerprintVersion
        else { return nil }
        let receipts = try session.rows(
            """
            SELECT a.before_data, a.transaction_id
              FROM portfolio_import_reconciliation_journal a
             WHERE a.action = 'adopt'
               AND a.before_data ->> 'ledgerKind' = 'cash'
               AND NOT EXISTS (
                   SELECT 1 FROM portfolio_import_reconciliation_journal r
                    WHERE r.previous_entry_id = a.id)
             ORDER BY a.id
            """)
        for receipt in receipts {
            guard let text = try receipt.optionalText("before_data"),
                let value = JSValue.parse(text), case .object(let before) = value,
                case .object(let snapshot)? = before["snapshot"]
            else { continue }
            guard snapshot["dedup_fingerprint"]?.stringValue == fingerprint,
                (snapshot["dedup_fingerprint_version"]?.javaScriptNumber ?? .nan) == Double(version)
            else { continue }
            return try receipt.optionalInt64("transaction_id").flatMap { Int(exactly: $0) }
        }
        return nil
    }

    /// `insertIncludedInUnitsIncome`: the paired Kinesis yield dividend's in-kind record.
    /// The new transaction id, or nil when the identity exists.
    static func insertIncludedInUnitsIncome(
        _ session: BackendSession, _ row: PipelineRow, _ accountId: Int?, _ batchId: Int  // lint:allow raw-id the ids the paired income insert writes
    ) throws -> Int? {
        let inserted = try session.row(
            """
            INSERT INTO portfolio_transactions (
                investment_id, type, date, amount, units, price_per_unit, fees, taxes,
                currency, note, fx_rate_to_eur, account_id, import_batch_id,
                source_record_hash, dedup_fingerprint, dedup_fingerprint_version,
                income_recognition_role
            ) VALUES (?, 'dividend', ?, vision_numeric(?, 18, 4), NULL, NULL, '0', '0',
                ?, ?, NULL, ?, ?, ?, ?, ?, 'included_in_units')
            ON CONFLICT DO NOTHING RETURNING id
            """,
            [row.investmentID.map { SQLValue.integer(Int64($0)) } ?? .null,
             .text(row.day ?? ""),
             row.amount.map { SQLValue.text(SQLArguments.javaScriptText(pipelineNumber($0) ?? 0)) }
                 ?? .null,
             row.currency.map { SQLValue.text($0) } ?? .null,
             row.note.map { SQLValue.text($0) } ?? .null,
             accountId.map { SQLValue.integer(Int64($0)) } ?? .null,
             .integer(Int64(batchId)),
             row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
             row.dedupFingerprint.map { SQLValue.text($0) } ?? .null,
             row.dedupFingerprintVersion.map { SQLValue.integer(Int64($0)) } ?? .null])
        return try inserted?.optionalInt64("id").flatMap { Int(exactly: $0) }
    }

    /// `savepointFor`: the staged row's id is always a digits-only integer here, so the
    /// per-row savepoint of `commit.ts` is the nested transaction of the session.
    static func withRowSavepoint<T>(_ session: BackendSession, _ body: () throws -> T) throws -> T {
        try session.transaction(body)
    }

    /// `commitBatch`: drain the batch's matched rows into the ledger with occurrence-based
    /// field dedup and a per-row savepoint, in chunked transactions.
    static func commitBatch(
        _ session: BackendSession, _ batchId: Int, _ rowIds: [Int]?,  // lint:allow raw-id the staged row ids the route schedules
        scope: CustodyImportScope? = nil
    ) throws -> (imported: Int, duplicates: Int, errors: Int) {
        let batch = try readPipelineBatch(session, batchId)
        let batchAccountId = batch?.accountID
        let isBrokerage = batch?.isBrokerage ?? false
        let relevantRows = try readPipelineRows(session, batchId)
        let selectedRowIds = rowIds.map { Set($0) }
        let matched = relevantRows.filter { row in
            row.status == StagingStatus.matched
                && (selectedRowIds == nil || selectedRowIds?.contains(row.id) == true)
        }
        let batchFormat = batch?.customConfig?.parsedObject["format"]?.stringValue
        let zeroYieldKinesis = isZeroYieldKinesisBatch(batch?.customConfig)
        let inKindIncomeRowIds = zeroYieldKinesis
            ? kinesisInKindIncomeRowIds(relevantRows) : []
        if zeroYieldKinesis,
            matched.contains(where: { row in
                row.kind == PortfolioEventKind.dividend
                    && row.sourceReference?.hasSuffix(":income") == true
                    && !inKindIncomeRowIds.contains(row.id)
            })
        {
            throw BackendHTTPError.conflict(
                "A Kinesis yield income row is missing its received units",
                details: .object(["reason": .string("paired_income_units_missing")]))
        }
        _ = try session.rows(
            "UPDATE portfolio_import_batches SET status = 'committing' WHERE id = ?",
            [.integer(Int64(batchId))])

        var cashSeenByIdentity: [String: Int] = [:]
        var cashInsertedByIdentity: [String: Int] = [:]
        var tradeSeenByIdentity: [String: Int] = [:]
        var tradeInsertedByIdentity: [String: Int] = [:]
        for row in relevantRows {
            if row.status == StagingStatus.matched { continue }
            if row.route == StagingRoute.assetTransfer
                || row.route == StagingRoute.assetAdjustment
                || row.route == StagingRoute.accountInternal
            { continue }
            if isBrokerage, row.route == StagingRoute.cash {
                let identity = cashIdentityKey(row)
                cashSeenByIdentity[identity, default: 0] += 1
                continue
            }
            guard row.investmentID != nil else { continue }
            let canonical = try canonicalTradeValues(row)
            let identity = tradeIdentityKey(row, batchAccountId, canonical)
            tradeSeenByIdentity[identity, default: 0] += 1
        }

        // The cash recipient: the broker label of the batch's account, else SYSTEM.
        var cashRecipientId: Int? = nil  // lint:allow raw-id the recipient the cash rows record
        if isBrokerage, batchAccountId != nil,
            matched.contains(where: { $0.route == StagingRoute.cash })
        {
            let brokerName = [batch?.accountInstitution, batch?.accountName]
                .compactMap { $0 }
                .map { JavaScriptWhitespace.trim($0) }
                .filter { !$0.isEmpty }
                .first
            if let brokerName {
                let (recipient, _) = try RecipientsArea.createOrGetId(
                    session,
                    upperName: brokerName.uppercased().trimmingCharacters(in: .whitespacesAndNewlines),
                    normalized: RecipientText.normalizeForMatching(brokerName))
                cashRecipientId = recipient.rawValue
            }
            if cashRecipientId == nil {
                cashRecipientId = try AccountsArea.systemRecipientId(session)
            }
        }

        // The configured brokerage cash categories, once per drain.
        var cashCategoryIds: [String: Int] = [:]  // lint:allow raw-id the configured category ids
        if isBrokerage, batchAccountId != nil {
            let stored = try session.row(
                "SELECT value FROM user_settings WHERE key = 'brokerage_cash_category_ids'")
            var configured = JSObject()
            if let stored, let text = try stored.optionalText("value"),
                let value = JSValue.parse(text)
            {
                configured = SettingsArea.revive(key: "brokerage_cash_category_ids", value).objectValue ?? JSObject()
            }
            let cashCategoryKinds = ["dividend", "interest", "fee", "tax"]
            var requestedIds = Set<Int>()
            for kind in cashCategoryKinds {
                if let id = configured[kind]?.javaScriptNumber,
                    id.rounded() == id, id > 0, id <= 9_007_199_254_740_991
                {
                    requestedIds.insert(Int(id))
                }
            }
            var activeIds = Set<Int>()
            if !requestedIds.isEmpty {
                let placeholders = requestedIds.map { _ in "?" }.joined(separator: ", ")
                let rows = try session.rows(
                    "SELECT id FROM categories WHERE is_active = 1 AND id IN (\(placeholders))",
                    requestedIds.sorted().map { .integer(Int64($0)) })
                activeIds = Set(try rows.map { Int(try $0.int64("id")) })
            }
            for kind in cashCategoryKinds {
                if let id = configured[kind]?.javaScriptNumber,
                    id.rounded() == id, id > 0, activeIds.contains(Int(id))
                {
                    cashCategoryIds[kind] = Int(id)
                }
            }
        }

        // The per-batch FX cache of the on-or-before stored-rate lookup.
        var fxCache: [String: Double?] = [:]
        func resolveFx(_ currency: String, _ date: String?) throws -> Double? {
            let key = "\(currency.isEmpty ? "EUR" : currency.uppercased())|\(date ?? "null")"
            if fxCache.keys.contains(key) { return fxCache[key] ?? nil }
            let rate = try PortfolioTransactionsArea.storedRateToEur(
                session, currency, date ?? "")
            fxCache[key] = rate
            return rate
        }

        let total = matched.count
        var imported = 0
        var duplicates = 0
        var errors = 0
        let commitChunk = 1000

        for start in stride(from: 0, to: total, by: commitChunk) {
            let chunk = matched[start..<min(start + commitChunk, total)]
            var chunkImported = 0
            var chunkDuplicates = 0
            var chunkErrors = 0

            try session.transaction {
                for row in chunk {
                    if row.route == StagingRoute.accountInternal {
                        try markPipelineRow(session, row.id, "duplicate", nil)
                        chunkDuplicates += 1
                        continue
                    }

                    if row.route == StagingRoute.assetTransfer
                        || row.route == StagingRoute.assetAdjustment
                    {
                        do {
                            let source = try custodySourceRow(row, batchId, batch)
                            let committed: (id: Int, duplicate: Bool)
                            if row.route == StagingRoute.assetTransfer {
                                committed = try commitAssetTransfer(
                                    session, row: source, batchId: batchId, scope: scope)
                            } else {
                                committed = try commitAssetAdjustment(
                                    session, row: source, batchId: batchId, scope: scope)
                            }
                            try markPipelineRow(
                                session, row.id,
                                committed.duplicate ? "duplicate" : "committed", nil)
                            if committed.duplicate { chunkDuplicates += 1 } else { chunkImported += 1 }
                        } catch {
                            chunkErrors += 1
                            try? markPipelineRow(
                                session, row.id, "error",
                                truncatedErrorMessage(error) ?? "asset transfer failed")
                        }
                        continue
                    }

                    if isBrokerage, row.route == StagingRoute.cash {
                        guard let sleeveId = batchAccountId else {
                            chunkErrors += 1
                            try markPipelineRow(
                                session, row.id, "error",
                                "brokerage cash row requires a batch account")
                            continue
                        }
                        if batchFormat == "ibkr_transaction_history",  // lint:allow string-literal-compare the stored wire value the TypeScript pipeline dispatches on
                            let raw = row.kindRaw?.lowercased(),
                            ["deposit", "withdrawal"].contains(raw),
                            try findCorrectedIbkrCashAlias(session, row) != nil
                        {
                            chunkDuplicates += 1
                            try markPipelineRow(session, row.id, "duplicate", nil)
                            continue
                        }
                        let identity = cashIdentityKey(row)
                        let occurrence = cashSeenByIdentity[identity] ?? 0
                        cashSeenByIdentity[identity] = occurrence + 1
                        let insertedThisRun = cashInsertedByIdentity[identity] ?? 0
                        let fingerprintExists = try hasCanonicalFingerprint(
                            session, table: "transactions", row)
                        let ledgerMatches = try countCashFieldMatches(
                            session, sleeveId, row, row.dedupFingerprint != nil)
                        let occurrenceMatched = row.dedupOccurrence.map { $0 <= ledgerMatches }
                        if fingerprintExists
                            || (row.dedupFingerprint != nil && occurrenceMatched == true)
                            || (row.dedupFingerprint == nil
                                && occurrence < ledgerMatches - insertedThisRun)
                        {
                            chunkDuplicates += 1
                            try markPipelineRow(session, row.id, "duplicate", nil)
                            continue
                        }
                        do {
                            let insertedId = try withRowSavepoint(session, { () throws -> Int? in
                                let categoryId = row.kind.map { cashCategoryIds[$0.rawValue] } ?? nil
                                var arguments: [SQLValue] = [
                                    .text(row.day ?? ""),
                                    .text(SQLArguments.javaScriptText(signedCashAmount(row))),
                                    .text(row.currency ?? "EUR"),
                                    .text(cashMemo(row)),
                                    .integer(Int64(sleeveId)),
                                    cashRecipientId.map { SQLValue.integer(Int64($0)) } ?? .null,
                                    categoryId.map { SQLValue.integer(Int64($0)) } ?? .null,
                                ]
                                if let fingerprint = row.dedupFingerprint {
                                    arguments.append(contentsOf: [
                                        row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
                                        .text(fingerprint),
                                        row.dedupFingerprintVersion.map {
                                            SQLValue.integer(Int64($0))
                                        } ?? .null,
                                    ])
                                }
                                let provenanceColumns = row.dedupFingerprint != nil
                                    ? ", source_record_hash, dedup_fingerprint, dedup_fingerprint_version"
                                    : ""
                                let provenanceValues = row.dedupFingerprint != nil ? ", ?, ?, ?" : ""
                                let inserted = try session.row(
                                    """
                                    INSERT INTO transactions (
                                        date, amount, currency, memo, account_id, recipient_id,
                                        category_id, is_active\(provenanceColumns))
                                    VALUES (?, vision_numeric(?, 18, 4), ?, ?, ?, ?, ?, 1\(provenanceValues))
                                    ON CONFLICT DO NOTHING RETURNING id
                                    """,
                                    arguments)
                                return try inserted?.optionalInt64("id").flatMap { Int(exactly: $0) }
                            })
                            guard let insertedId else {
                                chunkDuplicates += 1
                                try markPipelineRow(session, row.id, "duplicate", nil)
                                continue
                            }
                            try markPipelineCommitted(session, row.id, insertedId)
                            chunkImported += 1
                            cashInsertedByIdentity[identity] = insertedThisRun + 1
                        } catch {
                            chunkErrors += 1
                            try? markPipelineRow(
                                session, row.id, "error",
                                truncatedErrorMessage(error) ?? "cash insert failed")
                        }
                        continue
                    }

                    guard let investmentID = row.investmentID else {
                        chunkErrors += 1
                        try markPipelineRow(
                            session, row.id, "error",
                            "unresolved instrument — pick or create a holding")
                        continue
                    }

                    let canonical: PortfolioTransactionsArea.Normalized
                    do {
                        canonical = try canonicalTradeValues(row)
                    } catch {
                        chunkErrors += 1
                        try markPipelineRow(
                            session, row.id, "error",
                            truncatedErrorMessage(error) ?? "invalid transaction values")
                        continue
                    }
                    let identity = tradeIdentityKey(row, batchAccountId, canonical)
                    let occurrence = tradeSeenByIdentity[identity] ?? 0
                    tradeSeenByIdentity[identity] = occurrence + 1
                    let insertedThisRun = tradeInsertedByIdentity[identity] ?? 0
                    let fingerprintExists = try hasCanonicalFingerprint(
                        session, table: "portfolio_transactions", row)
                    let destinationMatches = try countTradeFieldMatches(
                        session, row, batchAccountId, canonical, row.dedupFingerprint != nil)
                    let occurrenceMatched = row.dedupOccurrence.map { $0 <= destinationMatches }
                    if fingerprintExists
                        || (row.dedupFingerprint != nil && occurrenceMatched == true)
                        || (row.dedupFingerprint == nil
                            && occurrence < destinationMatches - insertedThisRun)
                    {
                        chunkDuplicates += 1
                        try markPipelineRow(session, row.id, "duplicate", nil)
                        continue
                    }

                    if inKindIncomeRowIds.contains(row.id) {
                        do {
                            let incomeId = try withRowSavepoint(session, { () throws -> Int? in
                                try insertIncludedInUnitsIncome(session, row, batchAccountId, batchId)
                            })
                            guard let incomeId else {
                                chunkDuplicates += 1
                                try markPipelineRow(session, row.id, "duplicate", nil)
                                continue
                            }
                            try markPipelineCommitted(session, row.id, incomeId)
                            chunkImported += 1
                            tradeInsertedByIdentity[identity] = insertedThisRun + 1
                        } catch {
                            chunkErrors += 1
                            try? markPipelineRow(
                                session, row.id, "error",
                                truncatedErrorMessage(error) ?? "insert failed")
                        }
                        continue
                    }

                    do {
                        guard let type = row.kind?.rawValue else {
                            throw PortfolioImportReconciliationArea.RequiredValueError(
                                message: "validate stamps a type on the row")
                        }
                        guard let date = row.day else {
                            throw PortfolioImportReconciliationArea.RequiredValueError(
                                message: "validate rejects a missing date")
                        }
                        let grossDividendFormats: Set<String> = [
                            "saxo_transaction_history", "ibkr_transaction_history"]
                        var assetClass = row.assetClass
                        if assetClass == nil {
                            assetClass = try PortfolioTransactionsArea.assetClass(session, investmentID)
                        }
                        if assetClass == nil {
                            throw BackendHTTPError.validation("Investment not found")
                        }
                        let convention = row.kind == PortfolioEventKind.dividend
                            && batchFormat.map(grossDividendFormats.contains) == true
                            ? "gross" : nil
                        let normalized = try PortfolioTransactionsArea.normalize(
                            type, nil, convention,
                            canonical.amount.map { JSValue.number($0) } ?? nil,
                            canonical.units.map { JSValue.number($0) } ?? nil,
                            canonical.pricePerUnit.map { JSValue.number($0) } ?? nil,
                            JSValue.number(pipelineNumber(row.fees) ?? 0),
                            JSValue.number(pipelineNumber(row.taxes) ?? 0),
                            row.fxRateToEUR.flatMap { text in
                                pipelineNumber(text).map { JSValue.number($0) }
                            },
                            assetClass: assetClass)
                        var fxRate = row.fxRateToEUR.flatMap { pipelineNumber($0) }
                        let primaryZeroYield = zeroYieldKinesis
                            && row.kind == PortfolioEventKind.gift
                            && row.sourceReference?.hasSuffix(":units") == true
                            && [normalized.amount, normalized.pricePerUnit,
                                pipelineNumber(row.fees), pipelineNumber(row.taxes)]
                                .allSatisfy { (($0 ?? 0)) == 0 }
                        if fxRate == nil, !primaryZeroYield {
                            let currency = row.currency ?? row.investmentCurrency ?? "EUR"
                            fxRate = try resolveFx(currency, row.day)
                        }

                        try PortfolioTransactionsArea.validateUnitMutation(
                            session,
                            PortfolioTransactionsArea.UnitMutation(
                                investmentId: investmentID, assetClass: assetClass,
                                type: type, date: date, units: normalized.units,
                                accountId: batchAccountId.map(Double.init),
                                checkProjectedHistory: type == "split"))  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on

                        let createdId = try withRowSavepoint(session, { () throws -> Int? in
                            var arguments: [SQLValue] = [
                                .text(SQLArguments.javaScriptText(normalized.amount ?? 0)),
                                .integer(Int64(investmentID)),
                                .text(type),
                                .text(date),
                                normalized.units.map {
                                    SQLValue.text(SQLArguments.javaScriptText($0))
                                } ?? .null,
                                normalized.pricePerUnit.map {
                                    SQLValue.text(SQLArguments.javaScriptText($0))
                                } ?? .null,
                                .text(SQLArguments.javaScriptText(normalized.fees)),
                                .text(SQLArguments.javaScriptText(normalized.taxes)),
                                .text(row.currency ?? row.investmentCurrency ?? "EUR"),
                                row.note.map { SQLValue.text($0) } ?? .null,
                                normalized.fxRateToEur.map {
                                    SQLValue.text(SQLArguments.javaScriptText($0))
                                } ?? .null,
                                batchAccountId.map { SQLValue.integer(Int64($0)) } ?? .null,
                                .text(normalized.dividendAmountConvention),
                            ]
                            let provenanceColumns = row.dedupFingerprint != nil
                                ? ", import_batch_id, source_record_hash, dedup_fingerprint, dedup_fingerprint_version"
                                : ", import_batch_id"
                            let provenanceValues = row.dedupFingerprint != nil ? ", ?, ?, ?, ?" : ", ?"
                            arguments.append(.integer(Int64(batchId)))
                            if row.dedupFingerprint != nil {
                                arguments.append(contentsOf: [
                                    row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
                                    row.dedupFingerprint.map { SQLValue.text($0) } ?? .null,
                                    row.dedupFingerprintVersion.map {
                                        SQLValue.integer(Int64($0))
                                    } ?? .null,
                                ])
                            }
                            let inserted = try session.row(
                                """
                                INSERT INTO portfolio_transactions (
                                    amount, investment_id, type, date, units, price_per_unit,
                                    fees, taxes, currency, note, fx_rate_to_eur, account_id,
                                    dividend_amount_convention\(provenanceColumns))
                                VALUES (vision_numeric(?, 18, 4), ?, ?, ?, vision_numeric(?, 18, 8),
                                    vision_numeric(?, 18, 6), vision_numeric(?, 18, 4),
                                    vision_numeric(?, 18, 4), ?, ?, vision_numeric(?, 20, 10), ?,
                                    ?\(provenanceValues))
                                ON CONFLICT DO NOTHING RETURNING id
                                """,
                                arguments)
                            return try inserted?.optionalInt64("id").flatMap { Int(exactly: $0) }
                        })
                        guard let createdId else {
                            chunkDuplicates += 1
                            try markPipelineRow(session, row.id, "duplicate", nil)
                            continue
                        }
                        try markPipelineCommitted(session, row.id, createdId)
                        chunkImported += 1
                        tradeInsertedByIdentity[identity] = insertedThisRun + 1
                    } catch {
                        chunkErrors += 1
                        try? markPipelineRow(
                            session, row.id, "error",
                            truncatedErrorMessage(error) ?? "insert failed")
                    }
                }
            }

            imported += chunkImported
            duplicates += chunkDuplicates
            errors += chunkErrors
            _ = try session.rows(
                """
                UPDATE portfolio_import_batches
                   SET rows_imported = COALESCE(rows_imported, 0) + ?,
                       rows_duplicate = COALESCE(rows_duplicate, 0) + ?,
                       rows_error = COALESCE(rows_error, 0) + ?
                 WHERE id = ?
                """,
                [.integer(Int64(chunkImported)), .integer(Int64(chunkDuplicates)),
                 .integer(Int64(chunkErrors)), .integer(Int64(batchId))])
        }

        return (imported, duplicates, errors)
    }

    /// The staged pipeline row as the custody commit's source row: the batch's config and
    /// account ride along, as the service's `batch` argument did.
    static func custodySourceRow(
        _ row: PipelineRow, _ batchId: Int, _ batch: PipelineBatch?  // lint:allow raw-id the ids the custody commit writes
    ) -> ReconciliationSourceRow {
        ReconciliationSourceRow(
            id: PortfolioImportRowID(row.id),
            batchID: PortfolioImportBatchNumericID(batchId),
            rowIndex: 0,
            status: .matched,
            route: row.route,
            kind: row.kind,
            kindRaw: row.kindRaw,
            day: row.day,
            amount: row.amount,
            units: row.units,
            pricePerUnit: row.pricePerUnit,
            fees: row.fees,
            taxes: row.taxes,
            currency: row.currency.flatMap { CurrencyCode(rawValue: $0) },
            fxRateToEUR: row.fxRateToEUR,
            note: row.note,
            rawData: nil,
            symbolRaw: nil,
            sourceReference: row.sourceReference,
            sourceAccountIdentity: nil,
            sourceRecordHash: row.sourceRecordHash,
            dedupFingerprint: row.dedupFingerprint,
            dedupFingerprintVersion: row.dedupFingerprintVersion,
            assetTransferDetails: row.assetTransferDetails,
            assetAdjustmentDetails: row.assetAdjustmentDetails,
            investmentID: row.investmentID.map(InvestmentID.init(rawValue:)),
            resolvedInvestmentID: nil,
            userOverrideInvestmentID: nil,
            assetClass: row.assetClass,
            investmentCurrency: row.investmentCurrency.flatMap { CurrencyCode(rawValue: $0) },
            accountID: batch?.accountID.map(AccountID.init(rawValue:)),
            customConfig: batch?.customConfig)
    }

    /// `commitPortfolioImport`: the drain plus the batch's terminal status.
    static func commitPortfolioImport(
        _ session: BackendSession, _ batchId: Int, _ rowIds: [Int]?,  // lint:allow raw-id the staged row ids the route schedules
        scope: CustodyImportScope? = nil
    ) throws -> (imported: Int, duplicates: Int, errors: Int) {
        let result = try commitBatch(session, batchId, rowIds, scope: scope)
        _ = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET status = CASE
                       WHEN EXISTS (
                           SELECT 1 FROM portfolio_import_staging_rows
                            WHERE batch_id = ? AND status = 'error'
                       ) THEN 'complete_with_errors' ELSE 'complete'
                   END,
                   completed_at = now()
             WHERE id = ?
            """,
            [.integer(Int64(batchId)), .integer(Int64(batchId))])
        return result
    }
}

// MARK: - The reviewed scope commit service

extension PortfolioImportCommitArea {
    /// `getManualPortfolioOverlaps`: matched portfolio rows a manual history row may
    /// already record, by staging row ordinal.
    static func manualPortfolioOverlaps(
        _ session: BackendSession, _ batchId: Int, _ accountId: Int?  // lint:allow raw-id the ids the repository query binds
    ) throws -> [Int] {
        let rows = try session.rows(
            """
            SELECT DISTINCT isr.row_index AS row_index
              FROM portfolio_import_staging_rows isr
              JOIN portfolio_transactions pt
                ON pt.investment_id = COALESCE(
                     isr.user_override_investment_id, isr.resolved_investment_id)
               AND pt.type = isr.type
               AND abs(date_diff_days(pt.date, isr.tx_date)) <= 7
             WHERE isr.batch_id = ?
               AND isr.status = 'matched'
               AND isr.route IS NOT 'cash'
               AND pt.dedup_fingerprint IS NULL
               AND (
                   (isr.type IN ('buy', 'sell', 'gift', 'split')
                     AND isr.units IS NOT NULL AND pt.units IS NOT NULL
                     AND dec_le(
                       dec_abs(dec_sub(pt.units, isr.units)),
                       dec_greatest('0.00000001', dec_mul(dec_abs(isr.units), '0.00000001'))))
                   OR isr.type NOT IN ('buy', 'sell', 'gift', 'split'))
               AND NOT EXISTS (
                   SELECT 1 FROM portfolio_transactions canonical
                    WHERE NULLIF(isr.dedup_fingerprint, '') IS NOT NULL
                      AND canonical.dedup_fingerprint = isr.dedup_fingerprint
                      AND canonical.dedup_fingerprint_version = isr.dedup_fingerprint_version
                      AND canonical.investment_id = COALESCE(
                           isr.user_override_investment_id, isr.resolved_investment_id)
                      AND canonical.account_id IS ?
                      AND canonical.type = isr.type)
             ORDER BY isr.row_index
            """,
            [.integer(Int64(batchId)), accountId.map { SQLValue.integer(Int64($0)) } ?? .null])
        return try rows.map { Int(try $0.int64("row_index")) }
    }

    /// `assertPortfolioImportReadiness`: a maintained batch must be complete, and outside
    /// the planned reconciliation its rows must not overlap manual history.
    static func assertReadiness(
        _ session: BackendSession, _ batchId: Int, _ batch: LockedBatch, _ accountId: Int?,  // lint:allow raw-id the ids the readiness preflight binds
        reconciliationPlanned: Bool
    ) throws {
        guard batch.maintained else { return }
        let problems = try readinessProblems(session, batchId, accountId)
        if !problems.isEmpty {
            throw BackendHTTPError.conflict(
                "Import needs repair: \(problems.count) source rows are incomplete or unresolved."
                    + " No new transactions were imported.",
                details: .object([
                    "reason": .string("incomplete_source"),
                    "count": .int(problems.count),
                    "row_ordinals": .array(problems.map { .int($0 + 1) }),
                ]))
        }
        if reconciliationPlanned { return }
        let overlaps = try manualPortfolioOverlaps(session, batchId, accountId)
        if !overlaps.isEmpty {
            throw BackendHTTPError.conflict(
                "Import needs reconciliation: \(overlaps.count) source rows may already exist"
                    + " in portfolio history. No new transactions were imported.",
                details: .object([
                    "reason": .string("existing_history_overlap"),
                    "count": .int(overlaps.count),
                    "row_ordinals": .array(overlaps.map { .int($0 + 1) }),
                ]))
        }
    }

    /// `atomicFailure`: a run with error rows rolls the whole scope back.
    static func atomicFailure(_ batchId: Int, _ errors: Int) -> BackendHTTPError {  // lint:allow raw-id the batch id the failure reports
        .conflict(
            "Import failed its atomic commit. No history changes were retained.",
            details: .object([
                "reason": .string("atomic_import_failed"),
                "batch_id": .int(batchId),
                "errors": .int(errors),
            ]))
    }

    /// One batch's rolled-up result of the scope commit.
    struct ScopeBatchResult: Equatable, Sendable {
        var batchId: Int  // lint:allow raw-id the locked batch the scope commits
        var imported = 0
        var duplicates = 0
        var adopted = 0
        var errors = 0

        var json: JSONValue {
            .object([
                "batch_id": .int(batchId),
                "imported": .int(imported),
                "duplicates": .int(duplicates),
                "adopted": .int(adopted),
                "errors": .int(errors),
            ])
        }
    }

    /// The scope's answer: one result per batch, plus the totals.
    struct ScopeCommitResult: Equatable, Sendable {
        var batches: [ScopeBatchResult]
        var imported: Int { batches.reduce(0) { $0 + $1.imported } }
        var duplicates: Int { batches.reduce(0) { $0 + $1.duplicates } }
        var adopted: Int { batches.reduce(0) { $0 + $1.adopted } }

        var json: JSONValue {
            .object([
                "batches": .array(batches.map { $0.json }),
                "imported": .int(imported),
                "duplicates": .int(duplicates),
                "adopted": .int(adopted),
                "errors": .int(0),
            ])
        }
    }

    /// `withPortfolioCustodyImportScope`'s approved map: one signature per custody row of
    /// the scheduled runs, built exactly as the commit writes it.
    static func approvedCustodyScope(
        _ session: BackendSession, _ scheduledRows: [ReconciliationSourceRow]
    ) throws -> CustodyImportScope {
        var approved: [String: String] = [:]
        for row in scheduledRows
        where row.route == StagingRoute.assetTransfer || row.route == StagingRoute.assetAdjustment {
            let key = "\(row.batchID.rawValue):\(row.id.rawValue)"
            guard !approved.keys.contains(key) else {
                throw BackendHTTPError.conflict(
                    "Reviewed custody scope contains an invalid source event")
            }
            if row.route == StagingRoute.assetTransfer,
                case .event(let event) = try PortfolioCustodyPreviews.assetTransfer(row)
            {
                approved[key] = transferSignature(row, event, batchId: row.batchID.rawValue)
            } else if case .event(let event) = try PortfolioCustodyPreviews.assetAdjustment(row) {
                let sources = event.kind == .yieldReversal
                    ? try eligibleYieldSources(
                        session, investmentId: event.investmentID.rawValue,
                        accountId: event.accountID.rawValue)
                    : []
                approved[key] = adjustmentSignature(
                    row, event, batchId: row.batchID.rawValue, hashes: sources.map { $0.hash })
            } else {
                throw BackendHTTPError.conflict(
                    "Reviewed custody source changed during commit preparation")
            }
        }
        return CustodyImportScope(approved: approved)
    }

    /// The scope's final full-history validation and retention check of
    /// `portfolioCustodyImportScope.ts`: every approved event persisted with the
    /// signature it was approved with, and every touched investment's history valid.
    static func assertCustodyScopeRetained(
        _ session: BackendSession, _ scheduledRows: [ReconciliationSourceRow]
    ) throws {
        let events = approvedCustodyEvents(scheduledRows)
        for investmentId in Set(events.map { $0.investmentId }) {
            let history = try PortfolioTransactionsArea.unitEvents(session, investmentId)
            try validateCustodyHistory(history.map(\.txn))
        }
        for event in events {
            let persisted = try session.row(
                """
                SELECT investment_id, to_char(date, 'YYYY-MM-DD') AS date, units,
                       source_record_hash
                  FROM \(event.isTransfer
                      ? "portfolio_asset_transfers" : "portfolio_asset_adjustments")
                 WHERE dedup_fingerprint = ? AND dedup_fingerprint_version = ?
                """,
                [.text(event.fingerprint), .integer(Int64(event.version))])
            guard let persisted,
                try persisted.optionalInt64("investment_id").flatMap({ Int(exactly: $0) })
                    == event.investmentId,
                try persisted.optionalText("date") == event.day,
                try DecimalJS.from(persisted.optionalText("units") ?? "0")
                    .eq(try DecimalJS.from(event.units)),
                try persisted.optionalText("source_record_hash") == event.sourceRecordHash
            else {
                throw BackendHTTPError.conflict(
                    "Reviewed custody scope did not retain every approved event")
            }
        }
    }

    /// The persisted fields one approved custody event's retention check compares.
    struct RetainedCustodyEvent {
        var isTransfer: Bool
        var investmentId: Int  // lint:allow raw-id the investment the approved event names
        var day: String
        var units: String
        var sourceRecordHash: String?
        var fingerprint: String
        var version: Int
    }

    /// The scheduled custody rows' persisted-event identities, in scheduling order.
    static func approvedCustodyEvents(
        _ scheduledRows: [ReconciliationSourceRow]
    ) -> [RetainedCustodyEvent] {
        var events: [RetainedCustodyEvent] = []
        for row in scheduledRows
        where row.route == StagingRoute.assetTransfer || row.route == StagingRoute.assetAdjustment {
            if row.route == StagingRoute.assetTransfer,
                case .event(let event) = try? PortfolioCustodyPreviews.assetTransfer(row)
            {
                events.append(RetainedCustodyEvent(
                    isTransfer: true,
                    investmentId: event.investmentID.rawValue,
                    day: event.day,
                    units: event.units,
                    sourceRecordHash: row.sourceRecordHash,
                    fingerprint: event.dedupFingerprint,
                    version: event.dedupFingerprintVersion))
            } else if case .event(let event) = try? PortfolioCustodyPreviews.assetAdjustment(row) {
                events.append(RetainedCustodyEvent(
                    isTransfer: false,
                    investmentId: event.investmentID.rawValue,
                    day: event.day,
                    units: event.units,
                    sourceRecordHash: row.sourceRecordHash,
                    fingerprint: event.dedupFingerprint,
                    version: event.dedupFingerprintVersion))
            }
        }
        return events
    }

    /// `commitLockedScope`: apply the reviewed plan, then drain each batch's scheduled
    /// rows, all inside one transaction under the custody import scope.
    static func commitLockedScope(
        _ session: BackendSession, _ batches: [LockedBatch],
        _ scope: PortfolioImportReconciliationArea.Scope
    ) throws -> ScopeCommitResult {
        let ids = batches.map { $0.id }
        let sourceRows = try PortfolioImportReconciliationArea.readSources(session, ids)
        let loaded = try PortfolioImportReconciliationArea.loadPlan(session, scope)
        var accountIds: [Int] = []  // lint:allow raw-id the accounts the scope asserts and locks
        func include(_ id: Int?) {
            guard let id, !accountIds.contains(id) else { return }
            accountIds.append(id)
        }
        for row in sourceRows {
            if let value = row.assetAdjustmentDetails?["accountId"], value != .null {
                let number = value.javaScriptNumber
                if number.isFinite, number == number.rounded(), number > 0 {
                    include(Int(number))
                }
            }
        }
        for action in loaded.result.plan.actions {
            include(action.transfer?.sourceAccountID.rawValue)
            include(action.transfer?.destinationAccountID.rawValue)
            include(action.adjustment?.accountID.rawValue)
        }
        for batch in batches {
            include(batch.accountID)
            let fields = batch.customConfig.parsedObject
            if let destination = fields["transfer_destination_account_id"] {
                let number = destination.javaScriptNumber
                if number.isFinite, number == number.rounded(), number > 0 {
                    include(Int(number))
                }
            }
            if let origin = fields["transfer_origin_account_id"] {
                let number = origin.javaScriptNumber
                if number.isFinite, number == number.rounded(), number > 0 {
                    include(Int(number))
                }
            }
        }
        accountIds.sort()
        for accountId in accountIds { try assertPortfolioImportAccount(session, accountId) }
        for accountId in accountIds { try assertPortfolioImportAccount(session, accountId) }

        func assertReady() throws {
            for batch in batches {
                try assertReadiness(
                    session, batch.id, batch, batch.accountID, reconciliationPlanned: true)
            }
        }

        var adoptedByBatch: [Int: Int] = [:]
        var settledByBatch: [Int: Int] = [:]
        do {
            (_, adoptedByBatch, settledByBatch) = try applyReconciliation(session, scope)
        } catch let error as BackendHTTPError {
            if error.details?.objectValue?["reason"]?.stringValue == "reconciliation_required" {  // lint:allow string-literal-compare the reason the TypeScript commit service dispatches on
                try assertReady()
            }
            throw error
        }
        try assertReady()

        var scheduledRows = try PortfolioImportReconciliationArea.readSources(session, ids)
            .filter { $0.status == StagingStatus.matched }
        try scheduledRows.sort { left, right in
            let leftDate = try PortfolioImportReconciliationArea.matchedSourceDate(left)
            let rightDate = try PortfolioImportReconciliationArea.matchedSourceDate(right)
            let byDate = leftDate.utf16Compare(rightDate)
            if byDate != 0 { return byDate < 0 }
            let byBatch = left.batchID.rawValue - right.batchID.rawValue
            if byBatch != 0 { return byBatch < 0 }
            return left.rowIndex < right.rowIndex
        }
        var runs: [(batchId: Int, rowIds: [Int])] = []  // lint:allow raw-id the batch and staged row ids the runs schedule
        for row in scheduledRows {
            let rowBatchId = row.batchID.rawValue
            if runs.last?.batchId != rowBatchId {
                runs.append((rowBatchId, []))
            }
            runs[runs.count - 1].rowIds.append(row.id.rawValue)
        }
        var results = batches.map { batch in
            ScopeBatchResult(batchId: batch.id)
        }
        for index in results.indices {
            results[index].duplicates = settledByBatch[results[index].batchId] ?? 0
            results[index].adopted = adoptedByBatch[results[index].batchId] ?? 0
        }
        let custodyScope = try approvedCustodyScope(session, scheduledRows)

        return try session.transaction {
            for run in runs {
                let result = try commitPortfolioImport(
                    session, run.batchId, run.rowIds, scope: custodyScope)
                if result.errors > 0 { throw atomicFailure(run.batchId, result.errors) }
                guard let total = results.firstIndex(where: { $0.batchId == run.batchId })
                else {
                    throw PortfolioImportReconciliationArea.RequiredValueError(
                        message: "every run belongs to one of the selected batches")
                }
                results[total].imported += result.imported
                results[total].duplicates += result.duplicates
            }
            for batch in batches {
                let result = try commitPortfolioImport(session, batch.id, nil, scope: custodyScope)
                if result.errors > 0 { throw atomicFailure(batch.id, result.errors) }
            }
            try assertCustodyScopeRetained(session, scheduledRows)
            return ScopeCommitResult(batches: results)
        }
    }

    /// `commitReviewedPortfolioImports`: the scope route's service entry point.
    static func commitReviewedPortfolioImports(
        _ session: BackendSession, _ scope: PortfolioImportReconciliationArea.Scope
    ) throws -> ScopeCommitResult {
        var ids = Array(Set(scope.batchIds))
        ids.sort()
        return try session.transaction {
            var batches: [LockedBatch] = []
            for batchId in ids {
                let batch = try lockBatch(session, batchId)
                let locked = try assertReviewable(batch, batchId)
                batches.append(locked)
            }
            return try commitLockedScope(session, batches, scope)
        }
    }

    /// `commitReviewedPortfolioImport`: the batch commit route's service entry point.
    static func commitReviewedPortfolioImport(
        _ session: BackendSession, _ batchId: Int, _ accountId: Int?  // lint:allow raw-id the ids the route binds
    ) throws -> (imported: Int, duplicates: Int, errors: Int) {
        try session.transaction {
            let batch = try assertReviewable(try lockBatch(session, batchId), batchId)

            if let accountId {
                try assertPortfolioImportAccount(session, accountId)
                try setBatchAccount(session, batchId, accountId)
            }

            if batch.maintained {
                var scoped = batch
                if let accountId { scoped.accountID = accountId }
                let result = try commitLockedScope(
                    session, [scoped],
                    (batchIds: [batchId], adoptPolicy: nil, batchPolicies: [],
                     rowChoices: []))
                guard let total = result.batches.first else {
                    throw PortfolioImportReconciliationArea.RequiredValueError(
                        message: "commitLockedScope reports one result per locked batch")
                }
                return (
                    imported: total.imported,
                    duplicates: total.duplicates + total.adopted,
                    errors: total.errors)
            }

            try assertReadiness(
                session, batchId, batch, accountId ?? batch.accountID,
                reconciliationPlanned: false)

            return try commitPortfolioImport(session, batchId, nil)
        }
    }

    /// The two commit routes.
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.CommitPortfolioImportBatch.self) { request in
            let parsed = try RequestBody.parseJavaScript(request.body)
            let batchId = try PortfolioImportBatchesArea.batchId(request)
            let accountId = try commitBody(parsed)
            return try await database.run { session in
                let result = try commitReviewedPortfolioImport(session, batchId, accountId)
                return HandlerResult(status: 200, data: .object([
                    "batch_id": .int(batchId),
                    "total": .int(result.imported + result.duplicates + result.errors),
                    "imported": .int(result.imported),
                    "duplicates": .int(result.duplicates),
                    "errors": .int(result.errors),
                ]))
            }
        }
        backend.serve(OpenAPIOperations.CommitReviewedPortfolioImports.self) { request in
            let scope = try PortfolioImportReconciliationArea.scopeBody(request)
            return try await database.run { session in
                let result = try commitReviewedPortfolioImports(session, scope)
                return HandlerResult(status: 200, data: result.json)
            }
        }
    }
}
