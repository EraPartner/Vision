import Foundation
import VisionNativeCore

/// The review endpoints of `routes/importRoutes.ts`: the staged-rows preview the review page
/// builds its groups from, and the recipient/category overrides a reviewed row carries.
/// `repositories/importBatchRepository.ts` owns the locking rule these writes share: the
/// batch must still be `awaiting_review`, or the override answers the reload conflict.
enum ImportReviewArea {
    // MARK: - Params

    /// `parseBatchRowIdParams`: both route params through `validateId` with the BIGSERIAL
    /// `MAX_SAFE_ID` bound, one shared message.
    static func batchRowIds(_ request: InProcessRequest) throws -> (batch: Int, row: Int) {
        let batch = coercedId(request.pathParameters["id"] ?? "")
        let row = coercedId(request.pathParameters["rowId"] ?? "")
        guard let found = batch, let staged = row else {
            throw BackendHTTPError.validation("Invalid batch or row id")
        }
        return (batch: found, row: staged)
    }

    /// `coercedIdSchema`: `validateId(value, "id", MAX_SAFE_ID)` over one raw param.
    static func coercedId(_ raw: String) -> Int? {
        let bytes = Array(raw.utf8)
        guard !bytes.isEmpty, bytes.allSatisfy({ (48...57).contains($0) }) else { return nil }
        guard let id = Int(raw), id >= 1, Double(id) <= ImportBatchesArea.maxSafeId else { return nil }
        return id
    }

    /// `overrideIdField` + `parseInput`: the optional FK id an override body carries.
    /// Null and absent clear the override; anything else must be a real int4 id.
    static func overrideBody(_ request: InProcessRequest, field: String) throws -> Int? {
        guard let body = try RequestBody.parseJavaScript(request.body) else { return nil }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        guard let value = object[field], value != .null else { return nil }
        guard let id = TransactionsArea.validId(value) else {
            throw BackendHTTPError.validation("\(field) must be a positive integer or null")
        }
        return id
    }

    // MARK: - Preview

    /// `formatCategoryLabel`: `[general, detail].filter(Boolean).join(": ")`.
    static func categoryLabel(_ general: String?, _ detail: String?) -> String? {
        let parts = [general, detail].compactMap { value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        return parts.isEmpty ? nil : parts.joined(separator: ": ")
    }

    /// `buildImportBatchPreview`'s group map: one group per effective recipient in
    /// insertion order, each group's identity fields taken from its first row.
    static func preview(_ session: BackendSession, batch: Int) throws -> HandlerResult {
        let rows = try session.rows(
            """
            SELECT
                isr.id,
                isr.row_index,
                isr.recipient_raw,
                isr.amount,
                isr.currency,
                to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
                isr.memo,
                isr.bank_account,
                isr.match_source,
                isr.match_similarity,
                isr.matched_pattern_id,
                isr.resolved_recipient_id,
                isr.user_override_recipient_id,
                isr.override_category_id,
                COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id) AS effective_recipient_id,
                r.name AS recipient_name,
                r.default_category_id AS recipient_default_category_id,
                rdc.general AS recipient_default_category_general,
                rdc.detail AS recipient_default_category_detail,
                CASE WHEN rdc.legacy_compatible
                            AND rdc.path_name = rdc.general || ':' || rdc.detail
                     THEN NULL ELSE rdc.path_name END AS recipient_default_category_path,
                oc.general AS override_category_general,
                oc.detail AS override_category_detail,
                CASE WHEN oc.legacy_compatible
                            AND oc.path_name = oc.general || ':' || oc.detail
                     THEN NULL ELSE oc.path_name END AS override_category_path,
                rmp.pattern AS matched_pattern_text,
                rmp.pattern_kind AS matched_pattern_kind,
                EXISTS (
                  SELECT 1 FROM transactions t
                   WHERE t.dedup_fingerprint = isr.dedup_fingerprint
                     AND t.dedup_fingerprint_version = isr.dedup_fingerprint_version
                ) AS "already_imported::bool"
               FROM import_staging_rows isr
               LEFT JOIN recipients r
                 ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
               LEFT JOIN categories rdc ON rdc.id = r.default_category_id
               LEFT JOIN categories oc ON oc.id = isr.override_category_id
               LEFT JOIN recipient_match_patterns rmp ON rmp.id = isr.matched_pattern_id
              WHERE isr.batch_id = ?
                AND isr.status = 'matched'
              ORDER BY isr.row_index ASC
            """,
            [.integer(Int64(batch))])

        struct PreviewGroup {
            let key: Int?
            var fields: [String: JSONValue]
            var rows: [JSONValue] = []
        }

        let optionalTextValue: (SQLRow, String) throws -> JSONValue = { row, column in
            try row.optionalText(column).map(JSONValue.string) ?? .null
        }
        let optionalIdValue: (SQLRow, String) throws -> JSONValue = { row, column in
            try row.optionalInt64(column).map { JSONValue.int(Int($0)) } ?? .null
        }

        var groups: [PreviewGroup] = []
        var totals: [String: Int] = [:]
        var alreadyImported = 0
        for row in rows {
            let stagingRow: (SQLRow) throws -> JSONValue = { row in
                .object([
                    "id": .string(String(try row.int64("id"))),
                    "row_index": .int(Int(try row.int64("row_index"))),
                    "recipient_raw": try optionalTextValue(row, "recipient_raw"),
                    "amount": try optionalTextValue(row, "amount"),
                    "currency": try optionalTextValue(row, "currency"),
                    "tx_date": try optionalTextValue(row, "tx_date"),
                    "memo": try optionalTextValue(row, "memo"),
                    "bank_account": try optionalTextValue(row, "bank_account"),
                    "match_source": try optionalTextValue(row, "match_source"),
                    "match_similarity":
                        try row.optionalDouble("match_similarity").map { JSONValue.double($0) }
                        ?? .null,
                    "matched_pattern_id": try optionalIdValue(row, "matched_pattern_id"),
                    "user_override_recipient_id": try optionalIdValue(row, "user_override_recipient_id"),
                    "override_category_id": try optionalIdValue(row, "override_category_id"),
                    "already_imported": .bool(try row.bool("already_imported::bool")),
                ])
            }
            let effective =
                try row.optionalInt64("effective_recipient_id").map { Int($0) }
            if let index = groups.firstIndex(where: { $0.key == effective }) {
                groups[index].rows.append(try stagingRow(row))
            } else {
                let defaultLabel =
                    try row.optionalText("recipient_default_category_path")
                    ?? categoryLabel(
                        try row.optionalText("recipient_default_category_general"),
                        try row.optionalText("recipient_default_category_detail"))
                let overrideLabel =
                    try row.optionalText("override_category_path")
                    ?? categoryLabel(
                        try row.optionalText("override_category_general"),
                        try row.optionalText("override_category_detail"))
                let overrideCategoryId = try row.optionalInt64("override_category_id").map { Int($0) }
                let defaultCategoryId = try row.optionalInt64("recipient_default_category_id").map { Int($0) }
                let group = PreviewGroup(
                    key: effective,
                    fields: [
                        "recipient_id": try optionalIdValue(row, "effective_recipient_id"),
                        "recipient_name": try optionalTextValue(row, "recipient_name"),
                        "recipient_default_category_id":
                            defaultCategoryId.map { JSONValue.int($0) } ?? .null,
                        "recipient_default_category_label":
                            defaultLabel.map(JSONValue.string) ?? .null,
                        "override_category_id": overrideCategoryId.map { JSONValue.int($0) } ?? .null,
                        "current_category_id":
                            (overrideCategoryId ?? defaultCategoryId).map { JSONValue.int($0) } ?? .null,
                        "current_category_label":
                            (overrideLabel ?? defaultLabel).map(JSONValue.string) ?? .null,
                        "matched_pattern_id": try optionalIdValue(row, "matched_pattern_id"),
                        "matched_pattern_text": try optionalTextValue(row, "matched_pattern_text"),
                        "matched_pattern_kind": try optionalTextValue(row, "matched_pattern_kind"),
                    ],
                    rows: [try stagingRow(row)])
                groups.append(group)
            }
            let source = try row.optionalText("match_source") ?? "unresolved"
            totals[source, default: 0] += 1
            if try row.bool("already_imported::bool") { alreadyImported += 1 }
        }

        var totalsJSON: [String: JSONValue] = [:]
        for source in ["exact", "fuzzy", "pattern", "new", "unresolved"] {
            totalsJSON[source] = .int(totals[source] ?? 0)
        }
        let groupJSON = groups.map { group -> JSONValue in
            var fields = group.fields
            fields["rows"] = .array(group.rows)
            fields["row_count"] = .int(group.rows.count)
            return .object(fields)
        }
        return HandlerResult(
            data: .object([
                "batch_id": .int(batch),
                "groups": .array(groupJSON),
                "totals": .object(totalsJSON),
                "already_imported": .int(alreadyImported),
            ]))
    }

    // MARK: - Overrides

    /// `lockBatchUnderReview` inside the override's transaction: a batch no longer
    /// awaiting review refuses the write.
    static func lockBatchUnderReview(_ session: BackendSession, batch: Int) throws {
        let locked = try session.row(
            "SELECT id FROM import_batches WHERE id = ? AND status = 'awaiting_review'",
            [.integer(Int64(batch))])
        if locked == nil {
            throw BackendHTTPError.conflict(
                "Import review has ended; reload the batch before making changes")
        }
    }

    /// `overrideRecipient`/`overrideCategory`: lock, update the matched staging row, and
    /// answer the row the user named. An UPDATE that matched no row means the row id did
    /// not exist in the batch or the row was not in `matched` status.
    static func override(
        _ session: BackendSession, batch: Int, row: Int, column: String, value: Int?
    ) throws -> HandlerResult {
        try session.transaction {
            try lockBatchUnderReview(session, batch: batch)
            let written = try session.rows(
                """
                UPDATE import_staging_rows
                   SET \(column) = ?
                 WHERE id = ? AND batch_id = ? AND status = 'matched'
                RETURNING id
                """,
                [
                    value.map { SQLValue.integer(Int64($0)) } ?? .null, .integer(Int64(row)),
                    .integer(Int64(batch)),
                ])
            guard !written.isEmpty else {
                throw BackendHTTPError.notFound(
                    "Row \(row) not found in batch \(batch) or not in matched status")
            }
            return HandlerResult.noContent
        }
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.PreviewImportBatch.self) { request in
            let batchId = try ImportBatchesArea.batchId(request)
            return try await database.run { session in
                guard (try session.row("SELECT id FROM import_batches WHERE id = ?",
                    [.integer(Int64(batchId))])) != nil
                else { throw BackendHTTPError.notFound("Import batch \(batchId) not found") }
                return try ImportReviewArea.preview(session, batch: batchId)
            }
        }
        backend.serve(OpenAPIOperations.OverrideImportRow.self) { request in
            let ids = try ImportReviewArea.batchRowIds(request)
            let recipientId = try ImportReviewArea.overrideBody(request, field: "recipient_id")
            return try await database.run { session in
                _ = try ImportReviewArea.override(
                    session, batch: ids.batch, row: ids.row,
                    column: "user_override_recipient_id", value: recipientId)
                return HandlerResult(
                    data: .object([
                        "row_id": .int(ids.row),
                        "user_override_recipient_id": recipientId.map { JSONValue.int($0) } ?? .null,
                    ]))
            }
        }
        backend.serve(OpenAPIOperations.OverrideImportRowCategory.self) { request in
            let ids = try ImportReviewArea.batchRowIds(request)
            let categoryId = try ImportReviewArea.overrideBody(request, field: "category_id")
            return try await database.run { session in
                if let categoryId {
                    guard (try session.row(
                        "SELECT id FROM categories WHERE id = ?", [.integer(Int64(categoryId))])) != nil
                    else { throw BackendHTTPError.validation("Category \(categoryId) not found") }
                }
                _ = try ImportReviewArea.override(
                    session, batch: ids.batch, row: ids.row,
                    column: "override_category_id", value: categoryId)
                return HandlerResult(
                    data: .object([
                        "row_id": .int(ids.row),
                        "override_category_id": categoryId.map { JSONValue.int($0) } ?? .null,
                    ]))
            }
        }
    }
}
