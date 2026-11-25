import Foundation
import VisionNativeCore

/// `registerImportBatchRoutes` as `routes/importRoutes.ts` wires it for the transaction
/// pipeline (`repositories/importBatchRepository.ts`): the batch history list and the
/// rollback delete. Uploads (`importCsv*`) and the review operations stay on Bun until
/// their slices.
enum ImportBatchesArea {
    /// The pipeline statuses `deleteImportBatch` refuses to roll back.
    static let inProgressStatuses = ["staging", "validating", "matching", "committing"]
    /// The status whose second delete answers "Batch is already aborted".
    static let abortStatuses = ["aborted"]
    /// `MAX_SAFE_ID` of `lib/validation.ts`: `import_batches.id` is BIGSERIAL.
    static let maxSafeId: Double = 9_007_199_254_740_991

    /// `BATCH_LIST_COLUMNS` + the LEFT JOIN's remaining count.
    static let columns = """
        b.id, b.adapter_name, b.source_filename, b.source_size_bytes, b.status, b.rows_total, \
        b.rows_imported, b.rows_duplicate, b.rows_error, b.error_summary, b.started_at, b.completed_at
        """

    // MARK: - Params

    /// `parseBatchIdParam`: `validateId(value, "id", MAX_SAFE_ID)`, one message.
    static func batchId(_ request: InProcessRequest) throws -> Int {
        let raw = request.pathParameters["id"] ?? ""
        let bytes = Array(raw.utf8)
        guard !bytes.isEmpty, bytes.allSatisfy({ (48...57).contains($0) }) else {
            throw BackendHTTPError.validation("Invalid batch id")
        }
        guard let id = Int(raw), id >= 1, Double(id) <= maxSafeId else {
            throw BackendHTTPError.validation("Invalid batch id")
        }
        return id
    }

    // MARK: - Rows

    /// A batch as the list row schema shapes it: BIGINT columns travel as text.
    static func batchJSON(_ row: SQLRow) throws -> [String: JSONValue] {
        var json: [String: JSONValue] = [
            "id": .string(String(try row.int64("id"))),
            "adapter_name": .string(try row.text("adapter_name")),
            "source_filename": try row.optionalText("source_filename").map(JSONValue.string) ?? .null,
            "source_size_bytes": try row.optionalInt64("source_size_bytes").map { .string(String($0)) } ?? .null,
            "status": .string(try row.text("status")),
            "rows_total": .int(Int(try row.int64("rows_total"))),
            "rows_imported": .int(Int(try row.int64("rows_imported"))),
            "rows_duplicate": .int(Int(try row.int64("rows_duplicate"))),
            "rows_error": .int(Int(try row.int64("rows_error"))),
            "error_summary": try row.optionalText("error_summary").map(JSONValue.string) ?? .null,
            "started_at": .string(try row.instant("started_at").text),
            "transactions_remaining": .int(Int(try row.int64("transactions_remaining"))),
        ]
        if try row.optionalText("completed_at") != nil {
            json["completed_at"] = .string(try row.instant("completed_at").text)
        } else {
            json["completed_at"] = .null
        }
        return json
    }

    /// The batch's status, for the delete's advisory read.
    static func status(_ session: BackendSession, id: Int) throws -> String? {
        try session.row("SELECT status FROM import_batches WHERE id = ?", [.integer(Int64(id))])
            .flatMap { try? $0.text("status") }
    }

    // MARK: - Handlers

    /// `GET /batches` (`listBatches`): the batches newest first, always paginated.
    static func list(_ session: BackendSession, limit: Double, offset: Double) throws -> HandlerResult {
        let page = PageParams(
            limit: JavaScriptInteger(value: limit),
            offset: JavaScriptInteger(value: offset))
        let rows = try session.rows(
            """
            SELECT \(columns), COUNT(t.id) AS transactions_remaining
              FROM import_batches b
              LEFT JOIN transactions t
                ON t.import_batch_id = b.id AND t.is_active = 1
             GROUP BY b.id
             ORDER BY b.started_at DESC
             LIMIT ? OFFSET ?
            """,
            [page.limit.sqlValue, page.offset.sqlValue])
            .map { row -> JSONValue in .object(try batchJSON(row)) }
        let count = try session.row("SELECT COUNT(*) AS n FROM import_batches")
        let total = (try count.map { Int(try $0.int64("n")) }) ?? 0
        return HandlerResult(data: .object(listBody(rows, total: total, page: page)))
    }

    /// `DELETE /batches/:id` (`rollbackBatch`): delete the batch's transactions, drop
    /// the orphaned auto-created recipients, abort the batch.
    static func delete(_ session: BackendSession, id: Int) throws -> HandlerResult {
        guard let advisory = try status(session, id: id) else {
            throw BackendHTTPError.notFound("Import batch \(id) not found")
        }
        try assertRollbackable(advisory)
        return try session.transaction {
            // The route's earlier read is advisory; the write transaction re-reads.
            guard let batchStatus = try status(session, id: id) else {
                throw BackendHTTPError.notFound("Import batch \(id) not found")
            }
            try assertRollbackable(batchStatus)
            let targets = try session.rows(
                "SELECT id FROM transactions WHERE import_batch_id = ? ORDER BY id", [.integer(Int64(id))]
            ).map { try $0.integerId("id") }
            try TransactionBulkArea.lockAccounts(session, targets)
            try protectPlannedExecutions(session, targets)
            let deleted = try session.rows(
                """
                DELETE FROM transactions
                 WHERE import_batch_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id
                """,
                [.integer(Int64(id)), .text(JSValue.array(targets.map { .int($0) }).jsonText)]).count

            // Auto-created recipients the batch no longer needs: referenced by its staging
            // rows, born during the import window, referenced by nothing else.
            let orphans = try session.rows(
                """
                SELECT r.id FROM recipients r
                 WHERE r.id IN (
                       SELECT resolved_recipient_id FROM import_staging_rows
                        WHERE batch_id = ? AND resolved_recipient_id IS NOT NULL
                       UNION
                       SELECT user_override_recipient_id FROM import_staging_rows
                        WHERE batch_id = ? AND user_override_recipient_id IS NOT NULL
                   )
                   AND r.created_at >= COALESCE(
                       (SELECT started_at FROM import_batches WHERE id = ?), '1970-01-01T00:00:00.000000Z')
                   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recipient_id = r.id)
                   AND NOT EXISTS (SELECT 1 FROM planned_transactions pt WHERE pt.recipient_id = r.id)
                   AND NOT EXISTS (SELECT 1 FROM recipients r2 WHERE r2.primary_recipient_id = r.id)
                """,
                [.integer(Int64(id)), .integer(Int64(id)), .integer(Int64(id))]
            ).map { Int(try $0.int64("id")) }
            var recipientsRemoved = 0
            if !orphans.isEmpty {
                let anyOrphan = JSValue.array(orphans.map { .int($0) }).jsonText
                _ = try session.rows(
                    "DELETE FROM recipient_bank_accounts WHERE recipient_id IN (SELECT value FROM json_each(?)) RETURNING recipient_id",
                    [.text(anyOrphan)])
                recipientsRemoved = try session.rows(
                    "DELETE FROM recipients WHERE id IN (SELECT value FROM json_each(?)) RETURNING id",
                    [.text(anyOrphan)]).count
            }
            _ = try session.row(
                """
                UPDATE import_batches
                   SET status = 'aborted', completed_at = NOW(), rows_imported = 0
                 WHERE id = ? RETURNING id
                """,
                [.integer(Int64(id))])
            return HandlerResult(
                data: .object([
                    "deleted": .int(deleted),
                    "recipientsRemoved": .int(recipientsRemoved),
                ]))
        }
    }

    /// The route's status guards, in their order.
    static func assertRollbackable(_ status: String) throws {
        if abortStatuses.contains(status) {
            throw BackendHTTPError.validation("Batch is already aborted")
        }
        if inProgressStatuses.contains(status) {
            throw BackendHTTPError.validation("Cannot rollback a batch that is still in progress")
        }
    }

    /// `protectPlannedExecutions`: a transaction a planned execution links cannot go.
    static func protectPlannedExecutions(_ session: BackendSession, _ targets: [Int]) throws {
        guard !targets.isEmpty else { return }
        let linked = try session.row(
            """
            SELECT 1 AS linked FROM planned_transaction_executions
             WHERE executed_transaction_id IN (SELECT value FROM json_each(?)) LIMIT 1
            """,
            [.text(JSValue.array(targets.map { .int($0) }).jsonText)])
        if linked != nil {
            throw BackendHTTPError.conflict(
                "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction")
        }
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetImportBatches.self) { request in
            try await database.run { session in
                try ImportBatchesArea.list(
                    session,
                    limit: JavaScriptInteger.clamped(request.query("limit"), min: 1, max: 200, fallback: 50).value,
                    offset: JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0).value)
            }
        }
        backend.serve(OpenAPIOperations.DeleteImportBatch.self) { request in
            let id = try ImportBatchesArea.batchId(request)
            return try await database.run { session in try ImportBatchesArea.delete(session, id: id) }
        }
    }
}
