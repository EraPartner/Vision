import Foundation
import VisionNativeCore

/// The P18 `rollbackBatch` receipt halves: the adoption-receipt validation
/// (`validatePortfolioImportAdoptionRollback`), the restores
/// (`restorePortfolioImportAdoptions`, `writeIbkrCashRestoration`,
/// `restorePairedPortfolioIncomeForBatch`) and the Kinesis fee lookup
/// (`readOwnedKinesisCashFeeIds`). The duplicate-repair journal keeps its
/// pre-port refusal: no corpus replays repair receipts yet.
enum PortfolioImportRollbackArea {
    /// One active `adopt` row of the reconciliation journal.
    struct AdoptionReceipt: Sendable {
        let id: Int
        let batchID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let stagingRowID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let transactionID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let action: String
        let policy: String
        let beforeText: String
        let afterText: String
        var before: JSValue? { JSValue.parse(beforeText) }
        var after: JSValue? { JSValue.parse(afterText) }
    }

    /// `getActiveAdoptionReceipts`: the batch's adopt rows no later restore undid.
    static func activeAdoptionReceipts(
        _ session: BackendSession, _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> [AdoptionReceipt] {
        try session.rows(
            """
            SELECT a.id, a.batch_id, a.staging_row_id, a.transaction_id, a."action", a.policy,
                   a.before_data, a.after_data
              FROM portfolio_import_reconciliation_journal a
             WHERE a.batch_id = ? AND a."action" = 'adopt'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal r
                                WHERE r.previous_entry_id = a.id)
             ORDER BY a.id
            """,
            [.integer(Int64(batchId))]
        ).map { row in
            AdoptionReceipt(
                id: Int(try row.int64("id")),
                batchID: Int(try row.int64("batch_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                stagingRowID: Int(try row.int64("staging_row_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                transactionID: Int(try row.int64("transaction_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                action: try row.text("action"),
                policy: try row.text("policy"),
                beforeText: try row.text("before_data"),
                afterText: try row.text("after_data"))
        }
    }

    /// `isIbkrCashReceipt`: a cash-kind journal envelope.
    static func isIbkrCashReceipt(_ receipt: AdoptionReceipt) -> Bool {
        guard case .object(let before)? = receipt.before,
            case .object(let after)? = receipt.after
        else { return false }
        guard before["ledgerKind"] == .string("cash"),
            after["ledgerKind"] == .string("cash"),
            before["version"] == .number(1),
            after["version"] == .number(1)
        else { return false }
        if case .object(let proof)? = after["proof"], case .string(let kind)? = proof["kind"],
            kind == "ibkr_native_funding" || kind == "cash_adoption"  // lint:allow string-literal-compare the journal proof kinds of the TypeScript receipt readers
        {
            return true
        }
        return false
    }

    /// `IbkrCashFinancialImage`'s compared keys, in `FINANCIAL_KEYS` order.
    static let cashFinancialKeys: [String] = [
        "id", "date", "amount", "currency", "memo", "comment", "balance",
        "account_id", "recipient_id", "recipient_bank_account_id", "is_active",
        "import_batch_id", "source_record_hash", "dedup_fingerprint",
        "dedup_fingerprint_version",
    ]

    /// `ibkrCashSnapshotSql`: the financial image of `transactions` row `alias`.
    static func ibkrCashSnapshotSQL(alias: String) -> String {
        """
        vision_jsonb(json_object(
        'id', \(alias).id, 'date', to_char(\(alias).date, 'YYYY-MM-DD'),
        'amount', \(alias).amount, 'currency', \(alias).currency, 'memo', \(alias).memo,
        'comment', \(alias).comment, 'balance', \(alias).balance,
        'account_id', \(alias).account_id, 'recipient_id', \(alias).recipient_id,
        'recipient_bank_account_id', \(alias).recipient_bank_account_id,
        'is_active', json(iif(\(alias).is_active, 'true', 'false')),
        'import_batch_id', \(alias).import_batch_id,
        'source_record_hash', \(alias).source_record_hash,
        'dedup_fingerprint', \(alias).dedup_fingerprint,
        'dedup_fingerprint_version', \(alias).dedup_fingerprint_version))
        """
    }

    static func cashReceiptChanged() -> BackendHTTPError {
        BackendHTTPError.conflict(
            "IBKR cash source or ledger image changed",
            details: .object(["reason": .string("cash_receipt_changed")]))
    }

    /// `financialImage`: the compared subset of a snapshot, absent keys as nulls.
    static func cashFinancialImage(_ snapshot: JSObject) -> [String: JSValue] {
        var image: [String: JSValue] = [:]
        for key in cashFinancialKeys {
            image[key] = snapshot[key] ?? .null
        }
        return image
    }

    /// `validateIbkrCashCorrectionRollback`: every corrected cash row must still
    /// match its recorded after-image.
    static func validateIbkrCashCorrectionRollback(
        _ session: BackendSession, _ receipts: [AdoptionReceipt]
    ) throws {
        let cash = receipts.filter(isIbkrCashReceipt)
        let ids = cash.map { $0.transactionID }
        guard Set(ids).count == ids.count else { throw cashReceiptChanged() }
        var current: [Int: JSObject] = [:]
        if !ids.isEmpty {
            let placeholders = ids.map { _ in "?" }.joined(separator: ", ")
            for row in try session.rows(
                """
                SELECT t.id, \(ibkrCashSnapshotSQL(alias: "t")) AS image
                  FROM transactions t
                 WHERE t.id IN (\(placeholders))
                 ORDER BY t.id
                """,
                ids.map { .integer(Int64($0)) }
            ) {
                guard let text = try row.optionalText("image"),
                    let value = JSValue.parse(text), case .object(let image) = value
                else { throw cashReceiptChanged() }
                current[Int(try row.int64("id"))] = image
            }
        }
        for receipt in cash {
            guard receipt.action == "adopt",  // lint:allow string-literal-compare the journal action values of the TypeScript receipt readers
                case .object(let after)? = receipt.after,
                case .object(let snapshot)? = after["snapshot"],
                let image = current[receipt.transactionID],
                cashFinancialImage(snapshot) == cashFinancialImage(image)
            else { throw cashReceiptChanged() }
        }
    }

    /// `sameSnapshot` for a journal image against the current row: key sets and
    /// values equal after the income-role normalization (absent means standard).
    static func sameSnapshot(_ current: HistoryImage?, _ data: JSObject) throws -> Bool {
        guard let current,
            let currentText = JSValue.parse(try PortfolioImportCommitArea.snapshotJSON(current)),
            case .object(let currentObject) = currentText
        else { return false }
        func normalizeRole(_ object: JSObject) -> [String: JSValue] {
            var image: [String: JSValue] = [:]
            for (key, value) in object.entries { image[key] = value }
            if image["income_recognition_role"] == nil || image["income_recognition_role"] == .string("standard") {
                image["income_recognition_role"] = .null
            }
            return image
        }
        let left = normalizeRole(currentObject)
        var right = normalizeRole(data)
        right["income_recognition_role"] = right["income_recognition_role"] ?? .null
        guard left.count == right.count else { return false }
        for (key, value) in left where right[key] != value { return false }
        return true
    }

    /// `validatePortfolioImportAdoptionRollback`: every receipt the batch owns,
    /// validated before rollback deletes anything. The duplicate-repair half is
    /// refused before this runs; a repair-free scope needs no repair validation.
    static func validateAdoptionRollback(
        _ session: BackendSession,
        _ batchId: Int,  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        _ removalRows: [(id: Int, investmentID: Int?)]  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> [AdoptionReceipt] {
        let receipts = try activeAdoptionReceipts(session, batchId)
        try validateIbkrCashCorrectionRollback(session, receipts)
        let portfolioReceipts = receipts.filter { !isIbkrCashReceipt($0) }
        var investmentIds: [Int] = []
        func append(_ id: Int?) {
            guard let id, !investmentIds.contains(id) else { return }
            investmentIds.append(id)
        }
        for receipt in portfolioReceipts {
            if case .object(let before)? = receipt.before, case .number(let id)? = before["investment_id"] {
                append(Int(id))
            }
        }
        for row in try session.rows(
            """
            SELECT COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) AS investment_id
              FROM portfolio_import_staging_rows isr
             WHERE isr.batch_id = ?
            """,
            [.integer(Int64(batchId))]
        ) {
            append((try row.optionalInt64("investment_id")).flatMap { Int(exactly: $0) })
        }
        for row in removalRows {
            append(row.investmentID)
        }
        let history = try PortfolioImportReconciliationArea.readHistory(session, investmentIds)
        for receipt in portfolioReceipts {
            guard case .object(let after)? = receipt.after else {
                throw BackendHTTPError.conflict(
                    "An adopted portfolio transaction was changed. Rollback needs review.",
                    details: .object(["reason": .string("adopted_transaction_changed")]))
            }
            let current = history.first { $0.id.rawValue == receipt.transactionID }
            if try !sameSnapshot(current, after) {
                throw BackendHTTPError.conflict(
                    "An adopted portfolio transaction was changed. Rollback needs review.",
                    details: .object(["reason": .string("adopted_transaction_changed")]))
            }
        }
        let removed = Set(removalRows.map { $0.id })
        var restored: [Int: HistoryImage] = [:]
        for receipt in portfolioReceipts {
            guard case .object(let before)? = receipt.before,
                let image = try? PortfolioImportReconciliationArea.historyImage(before)
            else { continue }
            restored[receipt.transactionID] = image
        }
        var projected: [HistoryImage] = []
        for image in history {
            let custody = image.kind == .assetTransfer || image.kind == .assetAdjustment
            if custody {
                if image.importBatchID?.rawValue == String(batchId) { continue }
            } else if removed.contains(image.id.rawValue) {
                continue
            }
            projected.append(restored[image.id.rawValue] ?? image)
        }
        try PortfolioImportReconciliationArea.assertProjectedHistory(
            history,
            projected.map { image in
                PortfolioImportReconciliationArea.ProjectedEvent(
                    id: Double(image.id.rawValue),
                    investmentID: image.investmentID.rawValue,
                    kind: image.kind.rawValue,
                    day: image.day,
                    amount: image.amount,
                    units: image.units,
                    fees: image.fees,
                    taxes: image.taxes,
                    accountID: image.accountID?.rawValue,
                    sourceAccountID: image.sourceAccountID?.rawValue,
                    destinationAccountID: image.destinationAccountID?.rawValue,
                    feeUnits: image.feeUnits)
            })
        return receipts
    }

    /// `writeIbkrCashRestoration`: restore only amount, currency and identity,
    /// then append the inverse receipt.
    static func writeIbkrCashRestoration(
        _ session: BackendSession, _ receipt: AdoptionReceipt
    ) throws {
        let active = try session.rows(
            """
            SELECT 1 FROM portfolio_import_reconciliation_journal a
             WHERE a.id = ? AND a."action" = 'adopt'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal r
                                WHERE r.previous_entry_id = a.id)
            """,
            [.integer(Int64(receipt.id))])
        guard active.count == 1 else { throw cashReceiptChanged() }
        guard case .object(let beforeEnvelope)? = receipt.before,
            case .object(let afterEnvelope)? = receipt.after,
            case .object(let beforeSnapshot)? = beforeEnvelope["snapshot"],
            case .object(let afterSnapshot)? = afterEnvelope["snapshot"]
        else { throw cashReceiptChanged() }
        // `compareAndSetIbkrCashImage(after, before)`: the row must still equal the
        // receipt's after image, and it is set back to the before image.
        let afterImage = JSValue.object(afterSnapshot).jsonText
        let beforeImage = JSValue.object(beforeSnapshot).jsonText
        let updated = try session.rows(
            """
            UPDATE transactions SET
               amount = vision_numeric(? ->> 'amount', 18, 4),
               currency = ? ->> 'currency',
               dedup_fingerprint = ? ->> 'dedup_fingerprint',
               dedup_fingerprint_version = CAST(? ->> 'dedup_fingerprint_version' AS INTEGER),
               updated_at = now()
             WHERE transactions.id = ?
               AND \(ibkrCashSnapshotSQL(alias: "transactions")) = vision_jsonb(?)
            RETURNING id
            """,
            [.text(beforeImage), .text(beforeImage), .text(beforeImage), .text(beforeImage),
             .integer(Int64(receipt.transactionID)), .text(afterImage)])
        guard updated.count == 1 else { throw cashReceiptChanged() }
        _ = try session.rows(
            """
            INSERT INTO portfolio_import_reconciliation_journal (
                batch_id, staging_row_id, transaction_id, action, policy,
                previous_entry_id, before_data, after_data
            ) VALUES (?, ?, ?, 'restore', ?, ?, vision_jsonb(?), vision_jsonb(?)) RETURNING id
            """,
            [.integer(Int64(receipt.batchID)), .integer(Int64(receipt.stagingRowID)),
             .integer(Int64(receipt.transactionID)), .text(receipt.policy),
             .integer(Int64(receipt.id)), .text(receipt.afterText), .text(receipt.beforeText)])
    }

    /// `restorePortfolioImportAdoptions`: put every adopted row back to its
    /// before-image and close the receipt.
    static func restorePortfolioImportAdoptions(
        _ session: BackendSession, _ receipts: [AdoptionReceipt]
    ) throws {
        for receipt in receipts {
            if isIbkrCashReceipt(receipt) {
                try writeIbkrCashRestoration(session, receipt)
                continue
            }
            guard case .object(let before)? = receipt.before,
                case .object(let after)? = receipt.after,
                let beforeImage = try? PortfolioImportReconciliationArea.historyImage(before),
                let afterImage = try? PortfolioImportReconciliationArea.historyImage(after)
            else {
                throw BackendHTTPError.conflict(
                    "An adopted portfolio transaction changed during rollback",
                    details: .object(["reason": .string("adopted_transaction_changed")]))
            }
            guard let restored = try PortfolioImportCommitArea.compareAndSetReconciledTransaction(
                session, afterImage, beforeImage)
            else {
                throw BackendHTTPError.conflict(
                    "An adopted portfolio transaction changed during rollback",
                    details: .object(["reason": .string("adopted_transaction_changed")]))
            }
            _ = try session.rows(
                """
                INSERT INTO portfolio_import_reconciliation_journal (
                    batch_id, staging_row_id, transaction_id, action, policy,
                    previous_entry_id, before_data, after_data
                ) VALUES (?, ?, ?, 'restore', ?, ?, vision_jsonb(?), vision_jsonb(?)) RETURNING id
                """,
                [.integer(Int64(receipt.batchID)), .integer(Int64(receipt.stagingRowID)),
                 .integer(Int64(receipt.transactionID)), .text(receipt.policy),
                 .integer(Int64(receipt.id)), .text(receipt.afterText),
                 .text(try PortfolioImportCommitArea.snapshotJSON(restored))])
        }
    }

    /// `restorePairedPortfolioIncomeForBatch`: close the batch's paired income
    /// `record` receipts with a `restore` entry.
    static func restorePairedPortfolioIncome(
        _ session: BackendSession,
        _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws {
        _ = try session.rows(
            """
            INSERT INTO portfolio_import_income_recognition_journal (
                batch_id, staging_row_id, unit_staging_row_id, income_transaction_id,
                unit_transaction_id, "action", previous_entry_id, income_data, unit_data, proof_data
            )
            SELECT r.batch_id, r.staging_row_id, r.unit_staging_row_id, r.income_transaction_id,
                   r.unit_transaction_id, 'restore', r.id, r.income_data, r.unit_data, r.proof_data
              FROM portfolio_import_income_recognition_journal r
             WHERE r.batch_id = ? AND r."action" = 'record'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_income_recognition_journal undo
                                WHERE undo.previous_entry_id = r.id)
             ORDER BY r.id
            """,
            [.integer(Int64(batchId))])
    }

    /// `readOwnedKinesisCashFeeIds`: the fee components a Kinesis cash-only
    /// commit recorded for this batch, owned while their receipt's identity holds.
    static func ownedKinesisCashFeeIds(
        _ session: BackendSession,
        _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> [Int] {
        try session.rows(
            """
            SELECT fee.id
              FROM (SELECT s.source_record_hash,
                           portfolio_cash_receipt(s.raw_data) AS receipt
                      FROM portfolio_import_staging_rows s
                     WHERE s.batch_id = ?
                       AND s.status = 'committed'
                       AND s.route = 'cash') r
              JOIN transactions fee
                ON CAST(fee.id AS TEXT) = r.receipt -> 'feeAfter' ->> 'id'
             WHERE r.receipt IS NOT NULL
               AND fee.dedup_fingerprint = r.receipt -> 'feeAfter' ->> 'dedup_fingerprint'
               AND fee.source_record_hash = r.source_record_hash
             ORDER BY fee.id
            """,
            [.integer(Int64(batchId))]
        ).map { Int(try $0.int64("id")) }
    }
}

/// The duplicate-repair journal (pre-ADR-236 repairs): validation and restore.
extension PortfolioImportRollbackArea {
    /// One active `repair` row of the duplicate-repair journal.
    struct RepairReceipt: Sendable {
        let id: Int
        let batchID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let stagingRowID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let originalBatchID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let legacyTransactionID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let importedTransactionID: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        let action: String
        let policy: String
        let beforeText: String
        let afterText: String
        var before: JSValue? { JSValue.parse(beforeText) }
        var after: JSValue? { JSValue.parse(afterText) }
    }

    /// `getActiveDuplicateRepairReceipts`: the batch's repair rows no later restore undid.
    static func activeDuplicateRepairReceipts(
        _ session: BackendSession,
        _ batchId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> [RepairReceipt] {
        try session.rows(
            """
            SELECT a.id, a.batch_id, a.staging_row_id, a.original_import_batch_id,
                   a.legacy_transaction_id, a.imported_transaction_id, a."action", a.policy,
                   a.before_data, a.after_data
              FROM portfolio_import_duplicate_repair_journal a
             WHERE a.batch_id = ? AND a."action" = 'repair'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_duplicate_repair_journal r
                                WHERE r.previous_entry_id = a.id)
             ORDER BY a.id DESC
            """,
            [.integer(Int64(batchId))]
        ).map { row in
            RepairReceipt(
                id: Int(try row.int64("id")),
                batchID: Int(try row.int64("batch_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                stagingRowID: Int(try row.int64("staging_row_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                originalBatchID: Int(try row.int64("original_import_batch_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                legacyTransactionID: Int(try row.int64("legacy_transaction_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                importedTransactionID: Int(try row.int64("imported_transaction_id")),  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                action: try row.text("action"),
                policy: try row.text("policy"),
                beforeText: try row.text("before_data"),
                afterText: try row.text("after_data"))
        }
    }

    /// `isDeepStrictEqual` of the journal images: key-order independent.
    static func sameRepairImage(_ left: JSValue?, _ right: JSValue?) -> Bool {
        switch (left, right) {
        case (nil, nil): return true
        case (.object(let a), .object(let b)):
            var leftImage: [String: JSValue] = [:]
            var rightImage: [String: JSValue] = [:]
            for (key, value) in a.entries { leftImage[key] = value }
            for (key, value) in b.entries { rightImage[key] = value }
            guard leftImage.count == rightImage.count else { return false }
            for (key, value) in leftImage where !sameRepairImage(rightImage[key], value) { return false }
            return true
        case (.array(let a), .array(let b)):
            guard a.count == b.count else { return false }
            return zip(a, b).allSatisfy { sameRepairImage($0, $1) }
        default: return left == right
        }
    }

    /// `fullTransaction`: the reconciliation snapshot plus its timestamps.
    static func fullRepairTransactionSQL(alias: String) -> String {
        "vision_jsonb(json_set(\(try! SchemaFunctions.snapshotSQL(alias: alias)),"
            + " '$.created_at', \(alias).created_at, '$.updated_at', \(alias).updated_at))"
    }

    /// `staging`: the full staging-row jsonb image.
    static func repairStagingSQL(alias: String) -> String {
        """
        vision_jsonb(json_object(
        'id', CAST(\(alias).id AS TEXT), 'batch_id', CAST(\(alias).batch_id AS TEXT),
        'row_index', \(alias).row_index, 'status', \(alias).status,
        'tx_date', \(alias).tx_date, 'type_raw', \(alias).type_raw, 'type', \(alias).type,
        'symbol_raw', \(alias).symbol_raw, 'name_raw', \(alias).name_raw,
        'units', \(alias).units, 'price_per_unit', \(alias).price_per_unit,
        'amount', \(alias).amount, 'fees', \(alias).fees, 'taxes', \(alias).taxes,
        'currency', \(alias).currency, 'fx_rate_to_eur', \(alias).fx_rate_to_eur,
        'note', \(alias).note, 'raw_data', \(alias).raw_data,
        'resolved_investment_id', \(alias).resolved_investment_id,
        'user_override_investment_id', \(alias).user_override_investment_id,
        'match_source', \(alias).match_source,
        'match_similarity', CASE WHEN \(alias).match_similarity = CAST(\(alias).match_similarity AS INTEGER)
            THEN CAST(\(alias).match_similarity AS INTEGER) ELSE \(alias).match_similarity END,
        'committed_txn_id', \(alias).committed_txn_id,
        'error_message', \(alias).error_message,
        'created_at', \(alias).created_at, 'route', \(alias).route,
        'updated_at', \(alias).updated_at,
        'source_transaction_id', \(alias).source_transaction_id,
        'source_account_identity', \(alias).source_account_identity,
        'dedup_occurrence', \(alias).dedup_occurrence,
        'source_record_hash', \(alias).source_record_hash,
        'dedup_fingerprint', \(alias).dedup_fingerprint,
        'dedup_fingerprint_version', \(alias).dedup_fingerprint_version,
        'asset_transfer_details', json(\(alias).asset_transfer_details),
        'asset_adjustment_details', json(\(alias).asset_adjustment_details)))
        """
    }

    /// `batch`: the full batch-row jsonb image, BIGINT columns as text.
    static func repairBatchSQL(alias: String) -> String {
        """
        vision_jsonb(json_object(
        'id', CAST(\(alias).id AS TEXT), 'adapter_name', \(alias).adapter_name,
        'source_filename', \(alias).source_filename,
        'source_size_bytes', CAST(\(alias).source_size_bytes AS TEXT),
        'custom_config', json(\(alias).custom_config),
        'default_asset_class', \(alias).default_asset_class,
        'default_type', \(alias).default_type, 'status', \(alias).status,
        'rows_total', \(alias).rows_total, 'rows_imported', \(alias).rows_imported,
        'rows_duplicate', \(alias).rows_duplicate, 'rows_error', \(alias).rows_error,
        'error_summary', \(alias).error_summary, 'started_at', \(alias).started_at,
        'completed_at', \(alias).completed_at, 'account_id', \(alias).account_id,
        'is_brokerage', json(iif(\(alias).is_brokerage, 'true', 'false'))))
        """
    }

    /// `financialRepairImage`: the snapshot without its timestamps, as a journal object.
    static func financialRepairImage(_ data: JSObject) -> [String: JSValue] {
        var image: [String: JSValue] = [:]
        for (key, value) in data.entries where key != "created_at" && key != "updated_at" {
            image[key] = value
        }
        return image
    }

    static func repairConflict() -> BackendHTTPError {
        BackendHTTPError.conflict(
            "Duplicate repair history or provenance changed. Review is required.",
            details: .object(["reason": .string("duplicate_repair_changed")]))
    }

    /// `validateDuplicatePortfolioRepairRollback`: every after-image the receipt
    /// recorded must still match the rows it changed.
    static func validateDuplicateRepairRollback(
        _ session: BackendSession, _ receipts: [RepairReceipt]
    ) throws {
        var batches: [Int: JSValue] = [:]
        for receipt in receipts {
            let legacy = try session.row(
                "SELECT \(fullRepairTransactionSQL(alias: "pt")) AS image FROM portfolio_transactions pt WHERE pt.id = ?",
                [.integer(Int64(receipt.legacyTransactionID))])
            let importedExists = try session.row(
                "SELECT id FROM portfolio_transactions WHERE id = ?",
                [.integer(Int64(receipt.importedTransactionID))]) != nil
            guard let legacyText = try legacy?.optionalText("image"),
                case .object(let after)? = receipt.after,
                case .object(let afterLegacy)? = after["legacy"],
                !importedExists,
                sameRepairImage(JSValue.parse(legacyText), .object(afterLegacy))
            else { throw repairConflict() }
            let originalBatch = try session.row(
                "SELECT \(repairBatchSQL(alias: "b")) AS image FROM portfolio_import_batches b WHERE b.id = ?",
                [.integer(Int64(receipt.originalBatchID))])
            guard let batchText = try originalBatch?.optionalText("image"),
                case .object(let afterBatch)? = after["originalBatch"],
                sameRepairImage(JSValue.parse(batchText), .object(afterBatch))
            else { throw repairConflict() }
            let currentBatch = batches[receipt.originalBatchID] ?? JSValue.parse(batchText)
            if !sameRepairImage(currentBatch, .object(afterBatch)) { throw repairConflict() }
            guard case .array(let afterStaging)? = after["originalStaging"] else {
                throw repairConflict()
            }
            var ids: [Int] = []
            for entry in afterStaging {
                guard case .object(let entryObject) = entry,
                    case .number(let id)? = entryObject["id"]
                else { throw repairConflict() }
                ids.append(Int(id))
            }
            let currentStaging = try session.rows(
                """
                SELECT \(repairStagingSQL(alias: "s")) AS image
                  FROM portfolio_import_staging_rows s
                 WHERE s.id IN (\(ids.map { _ in "?" }.joined(separator: ", ")))
                 ORDER BY s.id
                """,
                ids.map { .integer(Int64($0)) })
            guard currentStaging.count == afterStaging.count else { throw repairConflict() }
            for (index, row) in currentStaging.enumerated() {
                guard let text = try row.optionalText("image"),
                    sameRepairImage(JSValue.parse(text), afterStaging[index])
                else { throw repairConflict() }
            }
            // A receipt after-image holds the batch's before state for the next one.
            guard case .object(let before)? = receipt.before else { throw repairConflict() }
            batches[receipt.originalBatchID] = before["originalBatch"]
        }
    }

    /// `compareAndSetReconciledTransaction` with the repair's expected updated_at.
    static func compareAndSetRepairTransaction(
        _ session: BackendSession, _ before: HistoryImage, _ after: HistoryImage,
        expectedUpdatedAt: String?
    ) throws -> HistoryImage? {
        let afterImage = try PortfolioImportCommitArea.snapshotJSON(after)
        let beforeImage = try PortfolioImportCommitArea.snapshotJSON(before)
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
               AND \(try! SchemaFunctions.snapshotSQL(alias: "portfolio_transactions")) =
                   normalize_portfolio_income_snapshot(?)
               AND (? IS NULL OR portfolio_transactions.updated_at = vision_ts(?))
            RETURNING id
            """,
            [SQLValue](repeating: .text(afterImage), count: 13)
                + [.integer(Int64(before.id.rawValue)), .text(beforeImage),
                   expectedUpdatedAt.map { SQLValue.text($0) } ?? .null,
                   expectedUpdatedAt.map { SQLValue.text($0) } ?? .null])
        guard updated.count == 1 else { return nil }
        return try PortfolioImportCommitArea.readTransactionSnapshot(session, before.id.rawValue)
    }

    /// `restoreExactImportedCopy`: re-insert the exact imported copy a repair deleted.
    static func restoreExactImportedCopy(
        _ session: BackendSession, _ imported: JSValue
    ) throws -> Bool {
        let image = imported.jsonText
        let inserted = try session.rows(
            """
            INSERT INTO portfolio_transactions
              (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes,
               currency, fx_rate_to_eur, note, is_recurring, recurrence_interval,
               recurrence_end_date, created_at, updated_at, account_id, import_batch_id,
               dividend_amount_convention, source_record_hash, dedup_fingerprint,
               dedup_fingerprint_version, income_recognition_role)
            SELECT CAST(j ->> 'id' AS INTEGER), CAST(j ->> 'investment_id' AS INTEGER),
                   j ->> 'type', j ->> 'date',
                   vision_numeric(j ->> 'amount', 18, 4), vision_numeric(j ->> 'units', 18, 8),
                   vision_numeric(j ->> 'price_per_unit', 18, 6),
                   vision_numeric(j ->> 'fees', 18, 4), vision_numeric(j ->> 'taxes', 18, 4),
                   j ->> 'currency', vision_numeric(j ->> 'fx_rate_to_eur', 20, 10),
                   j ->> 'note', j ->> 'is_recurring', j ->> 'recurrence_interval',
                   j ->> 'recurrence_end_date', vision_ts(j ->> 'created_at'),
                   vision_ts(j ->> 'updated_at'), CAST(j ->> 'account_id' AS INTEGER),
                   CAST(j ->> 'import_batch_id' AS INTEGER), j ->> 'dividend_amount_convention',
                   j ->> 'source_record_hash', j ->> 'dedup_fingerprint',
                   CAST(j ->> 'dedup_fingerprint_version' AS INTEGER),
                   COALESCE(j ->> 'income_recognition_role', 'standard')
              FROM (SELECT ? AS j) restored
             WHERE true
            ON CONFLICT DO NOTHING RETURNING id
            """,
            [.text(image)])
        return inserted.count == 1
    }

    /// `replaceRepairStaging`: write the before state's status and pointer back.
    static func replaceRepairStaging(
        _ session: BackendSession, _ before: JSValue, _ after: JSValue
    ) throws -> Bool {
        let image = after.jsonText
        let updated = try session.rows(
            """
            UPDATE portfolio_import_staging_rows
               SET status = ? ->> 'status',
                   committed_txn_id = CAST(? ->> 'committed_txn_id' AS INTEGER)
             WHERE portfolio_import_staging_rows.id = CAST(? ->> 'id' AS INTEGER)
               AND vision_jsonb(json_remove(\(repairStagingSQL(alias: "portfolio_import_staging_rows")), '$.updated_at'))
                 = vision_jsonb(json_remove(vision_jsonb(?), '$.updated_at'))
            RETURNING id
            """,
            [.text(image), .text(image), .text(before.jsonText)])
        return updated.count == 1
    }

    /// `replaceRepairBatch`: write the before state's counters back.
    static func replaceRepairBatch(
        _ session: BackendSession, _ before: JSValue, _ after: JSValue
    ) throws -> Bool {
        let image = after.jsonText
        let updated = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET rows_imported = CAST(? ->> 'rows_imported' AS INTEGER),
                   rows_duplicate = CAST(? ->> 'rows_duplicate' AS INTEGER)
             WHERE portfolio_import_batches.id = CAST(? ->> 'id' AS INTEGER)
               AND \(repairBatchSQL(alias: "portfolio_import_batches")) = vision_jsonb(?)
            RETURNING id
            """,
            [.text(image), .text(image), .text(before.jsonText)])
        return updated.count == 1
    }

    /// `restoreDuplicatePortfolioRepairs`: undo every applied repair, then append
    /// the inverse receipt holding the SQL read-back images.
    static func restoreDuplicatePortfolioRepairs(
        _ session: BackendSession, _ receipts: [RepairReceipt]
    ) throws {
        for receipt in receipts {
            guard case .object(let before)? = receipt.before,
                case .object(let after)? = receipt.after,
                case .object(let afterLegacy)? = after["legacy"],
                case .object(let beforeLegacy)? = before["legacy"],
                let afterImage = try? PortfolioImportReconciliationArea.historyImage(afterLegacy),
                let beforeImage = try? PortfolioImportReconciliationArea.historyImage(beforeLegacy),
                case .string(let expected)? = afterLegacy["updated_at"],
                let restored = try compareAndSetRepairTransaction(
                    session, afterImage, beforeImage, expectedUpdatedAt: expected)
            else { throw repairConflict() }
            guard let imported = before["imported"], try restoreExactImportedCopy(session, imported)
            else { throw repairConflict() }
            var restoredStaging: [JSValue] = []
            guard case .array(let beforeStaging)? = before["originalStaging"],
                case .array(let afterStaging)? = after["originalStaging"]
            else { throw repairConflict() }
            for (index, previous) in beforeStaging.enumerated() {
                guard index < afterStaging.count,
                    try replaceRepairStaging(session, afterStaging[index], previous)
                else { throw repairConflict() }
                guard case .object(let entry) = previous,
                    case .number(let id)? = entry["id"]
                else { throw repairConflict() }
                let readBack = try session.row(
                    "SELECT \(repairStagingSQL(alias: "s")) AS image FROM portfolio_import_staging_rows s WHERE s.id = ?",
                    [.integer(Int64(id))])
                guard let text = try readBack?.optionalText("image"), let value = JSValue.parse(text)
                else { throw repairConflict() }
                restoredStaging.append(value)
            }
            guard let afterBatch = after["originalBatch"], let beforeBatch = before["originalBatch"],
                try replaceRepairBatch(session, afterBatch, beforeBatch)
            else { throw repairConflict() }
            guard case .object(let previousBatch)? = before["originalBatch"],
                case .number(let batchKey)? = previousBatch["id"]
            else { throw repairConflict() }
            let readBackBatch = try session.row(
                "SELECT \(repairBatchSQL(alias: "b")) AS image FROM portfolio_import_batches b WHERE b.id = ?",
                [.integer(Int64(batchKey))])
            guard let batchText = try readBackBatch?.optionalText("image"),
                let batchValue = JSValue.parse(batchText)
            else { throw repairConflict() }
            _ = batchValue
            _ = try session.rows(
                """
                INSERT INTO portfolio_import_duplicate_repair_journal (
                    batch_id, staging_row_id, original_import_batch_id,
                    legacy_transaction_id, imported_transaction_id, "action", policy,
                    previous_entry_id, before_data, after_data
                ) SELECT ?, ?, ?, ?, ?, 'restore', ?, ?, ?, vision_jsonb(json_object(
                    'legacy', json((SELECT \(fullRepairTransactionSQL(alias: "pt")) FROM portfolio_transactions pt WHERE pt.id = ?)),
                    'imported', json((SELECT \(fullRepairTransactionSQL(alias: "pt")) FROM portfolio_transactions pt WHERE pt.id = ?)),
                    'originalBatch', json(?),
                    'originalStaging', (SELECT json_group_array(json(\(repairStagingSQL(alias: "s")))) FROM portfolio_import_staging_rows s WHERE s.id IN (SELECT value FROM json_each(?))))
                ) RETURNING id
                """,
                [.integer(Int64(receipt.batchID)), .integer(Int64(receipt.stagingRowID)),
                 .integer(Int64(receipt.originalBatchID)),
                 .integer(Int64(receipt.legacyTransactionID)),
                 .integer(Int64(receipt.importedTransactionID)), .text(receipt.policy),
                 .integer(Int64(receipt.id)), .text(receipt.afterText),
                 .integer(Int64(receipt.legacyTransactionID)),
                 .integer(Int64(receipt.importedTransactionID)), .text(batchText),
                 .text(restoredIdsJSON(restoredStaging))])
            _ = restored
        }
    }
}

extension PortfolioImportRollbackArea {
    /// The staging-row ids of the restore receipt's read-back images, as `json_each` text.
    static func restoredIdsJSON(_ staging: [JSValue]) -> String {
        var ids: [Int] = []
        for entry in staging {
            guard case .object(let object) = entry, case .number(let id)? = object["id"] else { continue }
            ids.append(Int(id))
        }
        return "[\(ids.map(String.init).joined(separator: ","))]"
    }
}
