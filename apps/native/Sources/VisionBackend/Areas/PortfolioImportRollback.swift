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
            [.text(afterImage), .text(afterImage), .text(afterImage), .text(afterImage),
             .integer(Int64(receipt.transactionID)), .text(beforeImage)])
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
