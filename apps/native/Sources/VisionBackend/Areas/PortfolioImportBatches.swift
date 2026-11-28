import Foundation
import VisionNativeCore

/// `registerImportBatchRoutes` as `routes/portfolioImportRoutes.ts` wires it for the portfolio
/// pipeline (`repositories/portfolioImportBatchRepository.ts`): the batch history list, the
/// detail read, the review preview (its groups, match-source totals and account routing) and
/// the rollback delete. The receipt-driven restores inside `rollbackBatch` (adoption and
/// duplicate-repair journals) are not ported yet: the read runs and answers any batch whose
/// journals are empty, and refuses one that still holds receipts (the corpus only replays
/// empty journals; the receipt paths come with their own corpus).
enum PortfolioImportBatchesArea {
    /// `registerImportBatchRoutes`'s `inProgressStatuses` for the portfolio pipeline.
    static let inProgressStatuses = ["pending", "staging", "validating", "matching", "committing"]
    /// `BATCH_COLUMNS` of `portfolioImportBatchRepository.ts`, in its order.
    static let columns = """
        id, adapter_name, source_filename, source_size_bytes, default_asset_class, default_type, \
        status, account_id, rows_total, rows_imported, rows_duplicate, rows_error, error_summary, \
        started_at, completed_at
        """
    /// `PORTFOLIO_ACCOUNT_TYPES` of `portfolioImportAccountService.ts`.
    static let portfolioAccountTypes = ["brokerage", "crypto_exchange", "wallet"]

    /// A receipt journal the rollback cannot restore yet.
    struct UnportedReceipts: Error, Sendable {
        var batchId: Int  // lint:allow raw-id the BIGSERIAL batch id the routes coerce
    }

    // MARK: - Params

    /// `parseBatchIdParam`: `validateId(value, "id", MAX_SAFE_ID)`, one message.
    static func batchId(_ request: InProcessRequest) throws -> Int {
        let raw = request.pathParameters["id"] ?? ""
        let bytes = Array(raw.utf8)
        guard !bytes.isEmpty, bytes.allSatisfy({ (48...57).contains($0) }) else {
            throw BackendHTTPError.validation("Invalid batch id")
        }
        guard let id = Int(raw), id >= 1, Double(id) <= 9_007_199_254_740_991 else {
            throw BackendHTTPError.validation("Invalid batch id")
        }
        return id
    }

    /// `batchListQuery` → `parsePagination(query, { maxLimit: 200 })`.
    static func page(_ request: InProcessRequest) -> (limit: JavaScriptInteger, offset: JavaScriptInteger) {
        (
            limit: JavaScriptInteger.clamped(request.query("limit"), min: 1, max: 200, fallback: 50),
            offset: JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0)
        )
    }

    // MARK: - Rows

    /// `portfolioImportBatchSummaryRowSchema`: BIGINT ids travel as text, the row counters
    /// as numbers.
    static func batchJSON(_ row: SQLRow) throws -> [String: JSONValue] {
        var json: [String: JSONValue] = [
            "id": .string(String(try row.int64("id"))),
            "adapter_name": .string(try row.text("adapter_name")),
            "source_filename": try row.optionalText("source_filename").map(JSONValue.string) ?? .null,
            "source_size_bytes": try row.optionalInt64("source_size_bytes").map { .string(String($0)) }
                ?? .null,
            "default_asset_class": try row.optionalText("default_asset_class").map(JSONValue.string)
                ?? .null,
            "default_type": try row.optionalText("default_type").map(JSONValue.string) ?? .null,
            "status": .string(try row.text("status")),
            "account_id": try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
                .map { .int($0) } ?? .null,
            "rows_total": .int(Int(try row.int64("rows_total"))),
            "rows_imported": .int(Int(try row.int64("rows_imported"))),
            "rows_duplicate": .int(Int(try row.int64("rows_duplicate"))),
            "rows_error": .int(Int(try row.int64("rows_error"))),
            "error_summary": try row.optionalText("error_summary").map(JSONValue.string) ?? .null,
            "started_at": .string(try row.instant("started_at").text),
        ]
        if try row.optionalText("completed_at") != nil {
            json["completed_at"] = .string(try row.instant("completed_at").text)
        } else {
            json["completed_at"] = .null
        }
        return json
    }

    /// `getBatch`: the summary row of one id.
    static func getBatch(_ session: BackendSession, _ id: Int) throws -> SQLRow? {
        try session.row("SELECT \(columns) FROM portfolio_import_batches WHERE id = ?", [
            .integer(Int64(id)),
        ])
    }

    // MARK: - Handlers

    /// `GET /batches` (`listBatches`): newest first, always paginated.
    static func list(
        _ session: BackendSession, limit: JavaScriptInteger, offset: JavaScriptInteger
    ) throws -> HandlerResult {
        let rows = try session.rows(
            """
            SELECT \(columns) FROM portfolio_import_batches
            ORDER BY started_at DESC LIMIT ? OFFSET ?
            """,
            [limit.sqlValue, offset.sqlValue])
        let items = try rows.map { row -> JSONValue in .object(try batchJSON(row)) }
        let total = try session
            .row("SELECT COUNT(*) AS n FROM portfolio_import_batches")
            .flatMap { try? Int($0.int64("n")) } ?? 0
        return HandlerResult(data: .object([
            "items": .array(items),
            "total": .int(total),
            "limit": limit.json,
            "offset": offset.json,
        ]))
    }

    /// `GET /batches/:id`: the summary row, the 404 of `registerImportBatchRoutes`.
    static func read(_ session: BackendSession, _ id: Int) throws -> HandlerResult {
        guard let row = try getBatch(session, id) else {
            throw BackendHTTPError.notFound("Import batch \(id) not found")
        }
        return HandlerResult(data: .object(try batchJSON(row)))
    }

    /// `GET /batches/:id/preview`: the review groups, the match-source totals and the
    /// account routing of `buildPortfolioImportPreviewRouting`.
    static func preview(_ session: BackendSession, _ id: Int) throws -> HandlerResult {
        guard let batch = try getBatch(session, id) else {
            throw BackendHTTPError.notFound("Import batch \(id) not found")
        }
        let rows = try previewRows(session, id)
        let groups = groups(rows)
        let totals = totals(rows)
        let accountId = try batch.optionalInt64("account_id").flatMap { Int(exactly: $0) }
        let account = try accountId.flatMap { id in
            try session.row("SELECT is_active, type, name, display_name FROM accounts WHERE id = ?", [
                .integer(Int64(id)),
            ])
        }
        var accountName: JSONValue = .null
        if let account {
            accountName = .string(try account.optionalText("display_name") ?? account.text("name"))
        }
        return HandlerResult(data: .object([
            "batch_id": .int(id),
            "account_id": accountId.map { .int($0) } ?? .null,
            "account_name": accountName,
            "account_valid": .bool(isValidAccount(account)),
            "groups": .array(groups),
            "totals": .object(totals),
        ]))
    }

    /// `getPreviewRows`: the staging rows joined to their effective investment.
    static func previewRows(_ session: BackendSession, _ id: Int) throws -> [SQLRow] {
        try session.rows(
            """
            SELECT isr.id, isr.row_index, isr.status, isr.route, \
                   to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date, isr.type, isr.type_raw, \
                   isr.symbol_raw, isr.name_raw, isr.units, isr.price_per_unit, isr.amount, \
                   isr.fees, isr.taxes, isr.currency, isr.fx_rate_to_eur, isr.note, \
                   isr.match_source, isr.error_message, isr.resolved_investment_id, \
                   isr.user_override_investment_id, \
                   COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) \
                     AS effective_investment_id, \
                   inv.name AS investment_name, inv.symbol AS investment_symbol, \
                   inv.asset_class AS investment_asset_class
              FROM portfolio_import_staging_rows isr
              LEFT JOIN investments inv \
                ON inv.id = COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)
             WHERE isr.batch_id = ?
             ORDER BY isr.row_index ASC
            """,
            [.integer(Int64(id))])
    }

    /// `buildPortfolioImportBatchPreview`'s groups: by effective investment (cash its own),
    /// insertion order.
    static func groups(_ rows: [SQLRow]) -> [JSONValue] {
        struct Group {
            var key: String
            var json: [String: JSONValue]
            var rows: [JSONValue] = []
        }
        var byKey: [String: Group] = [:]
        var order: [String] = []
        for row in rows {
            let route = (try? row.optionalText("route")) ?? nil
            let effective = (try? row.optionalInt64("effective_investment_id"))
                .flatMap { Int(exactly: $0) }
            let symbol = (try? row.optionalText("symbol_raw")) ?? nil
            let name = (try? row.optionalText("name_raw")) ?? nil
            let key: String
            if route == "cash" {  // lint:allow string-literal-compare the staging-row route values
                key = "cash"
            } else if let effective {
                key = "inv:\(effective)"
            } else {
                // `symbol_raw || name_raw || "?"`: an empty text falls through too.
                var fallback = "?"
                if let symbol, !symbol.isEmpty {
                    fallback = symbol
                } else if let name, !name.isEmpty {
                    fallback = name
                }
                key = "raw:\(fallback.lowercased())"
            }
            // Append in place: copying the group out of the dictionary before the append
            // would copy its growing row array on every row (Astra consolidated C14).
            if byKey[key] == nil {
                order.append(key)
                byKey[key] = Group(key: key, json: [
                    "is_cash": .bool(route == "cash"),  // lint:allow string-literal-compare the staging-row route values
                    "investment_id": effective.map { .int($0) } ?? .null,
                    "investment_name": (try? row.optionalText("investment_name")).flatMap { $0 }
                        .map { .string($0) } ?? .null,
                    "investment_symbol": (try? row.optionalText("investment_symbol")).flatMap { $0 }
                        .map { .string($0) } ?? .null,
                    "investment_asset_class": (try? row.optionalText("investment_asset_class"))
                        .flatMap { $0 }.map { .string($0) } ?? .null,
                    "raw_symbol": route == "cash" ? .null : symbol.map { .string($0) } ?? .null,  // lint:allow string-literal-compare the staging-row route values
                    "raw_name": route == "cash" ? .null : name.map { .string($0) } ?? .null,  // lint:allow string-literal-compare the staging-row route values
                ])
            }
            byKey[key]?.rows.append(rowJSON(row))
        }
        var out: [JSONValue] = []
        for key in order {
            guard let group = byKey[key] else { continue }
            var json = group.json
            json["rows"] = .array(group.rows)
            json["row_count"] = .int(group.rows.count)
            out.append(.object(json))
        }
        return out
    }

    /// One preview row, `buildPortfolioImportBatchPreview`'s projection of a joined row.
    static func rowJSON(_ row: SQLRow) -> JSONValue {
        func text(_ column: String) -> JSONValue {
            ((try? row.optionalText(column)) ?? nil).map { .string($0) } ?? .null
        }
        func id(_ column: String) -> JSONValue {
            ((try? row.optionalInt64(column)) ?? nil).flatMap { Int(exactly: $0) }
                .map { .int($0) } ?? .null
        }
        return .object([
            "id": .string(String((try? row.int64("id")) ?? 0)),
            "row_index": .int(Int((try? row.int64("row_index")) ?? 0)),
            "status": .string((try? row.text("status")) ?? ""),
            "route": text("route"),
            "tx_date": text("tx_date"),
            "type": text("type"),
            "type_raw": text("type_raw"),
            "symbol_raw": text("symbol_raw"),
            "name_raw": text("name_raw"),
            "units": text("units"),
            "price_per_unit": text("price_per_unit"),
            "amount": text("amount"),
            "fees": text("fees"),
            "taxes": text("taxes"),
            "currency": text("currency"),
            "fx_rate_to_eur": text("fx_rate_to_eur"),
            "note": text("note"),
            "match_source": text("match_source"),
            "error_message": text("error_message"),
            "user_override_investment_id": id("user_override_investment_id"),
        ])
    }

    /// The match-source totals: `symbol`, `name_exact`, `unresolved`, `error`, then any
    /// other source the rows carry.
    static func totals(_ rows: [SQLRow]) -> [String: JSONValue] {
        var counts: [String: Int] = ["symbol": 0, "name_exact": 0, "unresolved": 0, "error": 0]
        var sources: [String] = []
        for row in rows {
            let status = (try? row.text("status")) ?? ""
            if status == "error" {  // lint:allow string-literal-compare the staging-row status values
                counts["error"] = (counts["error"] ?? 0) + 1
                continue
            }
            let source = ((try? row.optionalText("match_source")) ?? nil) ?? "unresolved"
            if counts[source] == nil { sources.append(source) }
            counts[source] = (counts[source] ?? 0) + 1
        }
        var totals: [String: JSONValue] = [
            "symbol": .int(counts["symbol"] ?? 0),
            "name_exact": .int(counts["name_exact"] ?? 0),
            "unresolved": .int(counts["unresolved"] ?? 0),
            "error": .int(counts["error"] ?? 0),
        ]
        for source in sources where totals[source] == nil { totals[source] = .int(counts[source] ?? 0) }
        return totals
    }

    /// `isValidPortfolioImportAccount`: an active account of a portfolio type.
    static func isValidAccount(_ account: SQLRow?) -> Bool {
        guard let account else { return false }
        let active = ((try? account.optionalBool("is_active")) ?? nil) == true
        let type = (try? account.optionalText("type")) ?? ""
        return active && portfolioAccountTypes.contains(type)
    }

    // MARK: - Rollback

    /// `DELETE /batches/:id`: the guards of `registerImportBatchRoutes`, then `rollbackBatch`.
    static func delete(_ session: BackendSession, _ id: Int) throws -> HandlerResult {
        guard let advisory = try getBatch(session, id) else {
            throw BackendHTTPError.notFound("Import batch \(id) not found")
        }
        let status = try advisory.text("status")
        if status == "aborted" {  // lint:allow string-literal-compare the batch status values
            throw BackendHTTPError.validation("Batch is already aborted")
        }
        if inProgressStatuses.contains(status) {
            throw BackendHTTPError.validation("Cannot rollback a batch that is still in progress")
        }
        let deleted = try rollback(session, id)
        return HandlerResult(data: .object(["deleted": .int(deleted)]))
    }

    /// `rollbackBatch`'s sequence. The PostgreSQL locks became the single SQLite writer
    /// (ADR-263), so only the reads and writes with an answer remain; the adoption receipts
    /// validate and restore through `PortfolioImportRollbackArea`, while a batch that still
    /// holds duplicate-repair receipts refuses — that legacy restore has no corpus yet.
    static func rollback(_ session: BackendSession, _ id: Int) throws -> Int {
        let repairReceipts = try session.rows(
            """
            SELECT a.id FROM portfolio_import_duplicate_repair_journal a
             WHERE a.batch_id = ? AND a.action = 'repair'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_duplicate_repair_journal r
                                WHERE r.previous_entry_id = a.id)
            """,
            [.integer(Int64(id))]).count
        guard repairReceipts == 0 else {
            throw UnportedReceipts(batchId: id)
        }
        let adoptionReceipts = try PortfolioImportRollbackArea.activeAdoptionReceipts(session, id)
        // `guardOriginalIbkrCashRollback`: a later IBKR funding correction owns the cash.
        let ownedElsewhere = try session.rows(
            """
            SELECT 1 FROM portfolio_import_reconciliation_journal a
             WHERE a.action = 'adopt' AND a.after_data ->> 'ledgerKind' = 'cash'
               AND (CAST(a.after_data ->> '$.proof.original.batchId' AS INTEGER) = ?
                    OR CAST(a.after_data ->> '$.proof.primaryReference.batchId' AS INTEGER) = ?)
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal r
                                WHERE r.previous_entry_id = a.id)
             LIMIT 1
            """,
            [.integer(Int64(id)), .integer(Int64(id))])
        guard ownedElsewhere.isEmpty else {
            throw BackendHTTPError.conflict(
                "A later IBKR funding correction still owns this cash. Undo that correction first.")
        }
        return try session.transaction {
            // `lockBatchForUpdate`, then the same lifecycle check inside the writer.
            let locked = try session.row(
                """
                SELECT status, is_brokerage, adapter_name, custom_config, account_id \
                FROM portfolio_import_batches WHERE id = ?
                """,
                [.integer(Int64(id))])
            guard let locked else {
                throw BackendHTTPError.notFound("Import batch \(id) not found")
            }
            let lockedStatus = try locked.text("status")
            if lockedStatus == "aborted"  // lint:allow string-literal-compare the batch status values
                || inProgressStatuses.contains(lockedStatus)
            {
                throw BackendHTTPError.validation(
                    "Batch \(id) cannot be rolled back from status \(lockedStatus)")
            }
            let isBrokerage = (try locked.optionalBool("is_brokerage")) == true

            // Committed rows: `getCommittedRows` (the ledger's cash ids and the portfolio's
            // trade ids the batch stamped).
            let committed = try session.rows(
                """
                SELECT isr.committed_txn_id AS id, isr.route, pt.investment_id
                  FROM portfolio_import_staging_rows isr
                  LEFT JOIN portfolio_transactions pt ON pt.id = isr.committed_txn_id
                 WHERE isr.batch_id = ? AND isr.committed_txn_id IS NOT NULL
                """,
                [.integer(Int64(id))])

            // `validatePortfolioImportAdoptionRollback`: every receipt the batch
            // owns is approved before any row is deleted. `portfolioRows` names
            // the trade ids the route deletes (cash rows only on a non-brokerage batch).
            let portfolioRows = try committed
                .filter { !isBrokerage || ((try? $0.optionalText("route")) ?? "") != "cash" }  // lint:allow string-literal-compare the staging-row route values
                .map { row -> (id: Int, investmentID: Int?) in  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                    (Int(try row.int64("id")),
                     (try row.optionalInt64("investment_id")).flatMap { Int(exactly: $0) })
                }
            let validatedAdoptions = adoptionReceipts.isEmpty
                ? []
                : try PortfolioImportRollbackArea.validateAdoptionRollback(session, id, portfolioRows)

            // `restorePairedPortfolioIncomeForBatch` closes the paired income receipts
            // before the rows they name are removed.
            try PortfolioImportRollbackArea.restorePairedPortfolioIncome(session, id)

            // The batch's custody events: transfer and adjustment rollbacks count first.
            let deletedTransfers = try session.rows(
                "DELETE FROM portfolio_asset_transfers WHERE import_batch_id = ? RETURNING id",
                [.integer(Int64(id))]).count
            let deletedAdjustments = try session.rows(
                "DELETE FROM portfolio_asset_adjustments WHERE import_batch_id = ? RETURNING id",
                [.integer(Int64(id))]).count

            // `hardDeleteByImportBatch`'s stamped trades, then the unstamped remainder.
            let bulkDeleted = try session.rows(
                "DELETE FROM portfolio_transactions WHERE import_batch_id = ? RETURNING id",
                [.integer(Int64(id))])
            let bulkDeletedIds = Set(try bulkDeleted.map { String(try $0.int64("id")) })
            var deleted = bulkDeleted.count + deletedTransfers + deletedAdjustments

            // Cash rows route at the ledger, never the portfolio table (brokerage only);
            // `readOwnedKinesisCashFeeIds` adds the fee components a cash-only commit owns.
            var cashIds: [Int64] = isBrokerage
                ? try committed.filter { (try? $0.optionalText("route")) ?? "" == "cash" }  // lint:allow string-literal-compare the staging-row route values
                    .compactMap { try? $0.int64("id") } : []
            if isBrokerage {
                cashIds.append(contentsOf: try PortfolioImportRollbackArea.ownedKinesisCashFeeIds(session, id)
                    .map(Int64.init))
            }
            let uniqueCashIds = Array(Set(cashIds)).sorted()
            if !uniqueCashIds.isEmpty {
                let idsJSON = "[\(uniqueCashIds.map(String.init).joined(separator: ","))]"
                let ledger = try session.rows(
                    """
                    DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?)) RETURNING id
                    """,
                    [.text(idsJSON)])
                deleted += ledger.count
            }
            for row in portfolioRows where !bulkDeletedIds.contains(String(row.id)) {
                if try session.row(
                    "DELETE FROM portfolio_transactions WHERE id = ? RETURNING id",
                    [.integer(Int64(row.id))]) != nil
                {
                    deleted += 1
                }
            }

            try PortfolioImportRollbackArea.restorePortfolioImportAdoptions(session, validatedAdoptions)

            try session.rows(
                """
                UPDATE portfolio_import_staging_rows SET status = 'matched', committed_txn_id = NULL
                 WHERE batch_id = ? AND status = 'committed'
                """,
                [.integer(Int64(id))])
            try session.rows(
                "UPDATE portfolio_import_batches SET status = 'aborted' WHERE id = ?",
                [.integer(Int64(id))])
            return deleted
        }
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetPortfolioImportBatches.self) { request in
            let page = PortfolioImportBatchesArea.page(request)
            return try await database.run { session in
                try PortfolioImportBatchesArea.list(session, limit: page.limit, offset: page.offset)
            }
        }
        backend.serve(OpenAPIOperations.GetPortfolioImportBatch.self) { request in
            let id = try PortfolioImportBatchesArea.batchId(request)
            return try await database.run { session in
                try PortfolioImportBatchesArea.read(session, id)
            }
        }
        backend.serve(OpenAPIOperations.PreviewPortfolioImportBatch.self) { request in
            let id = try PortfolioImportBatchesArea.batchId(request)
            return try await database.run { session in
                try PortfolioImportBatchesArea.preview(session, id)
            }
        }
        backend.serve(OpenAPIOperations.DeletePortfolioImportBatch.self) { request in
            let id = try PortfolioImportBatchesArea.batchId(request)
            return try await database.run { session in
                try PortfolioImportBatchesArea.delete(session, id)
            }
        }
    }
}
