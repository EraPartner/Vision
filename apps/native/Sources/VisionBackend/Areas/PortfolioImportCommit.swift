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
