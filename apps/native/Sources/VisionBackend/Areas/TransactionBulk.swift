import Foundation
import VisionNativeCore

/// `POST /api/transactions/bulk-tag` (`bulkTagTransactions`): the route's zod schema
/// (`bulkTagSchema` — the one custom message for every `transaction_ids` shape) and
/// `transactionBulkService.bulkTagTransactions` — the slug resolution with its active-tag
/// rule and the two junction writes in one write transaction. The bulk update, delete and
/// export routes of the same module stay on Bun until their own slice.
enum TransactionBulkArea {
    // MARK: - Register

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.BulkTagTransactions.self) { request in
            try await database.run { session in
                try TransactionBulkArea.tag(session, request: request)
            }
        }
    }

    // MARK: - Request input

    /// `bulkTagSchema`: `transaction_ids` answers every failure shape with its one custom
    /// message; the slug arrays default to empty. A type-mismatch issue is fatal in zod 4 —
    /// it skips the superRefine; a length issue does not.
    static func tagBody(_ request: InProcessRequest) throws -> (ids: [JSValue], add: [JSValue], remove: [JSValue]) {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(let object)? = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        var issues: [String] = []
        var fatal = false

        let badIds = "transaction_ids must be a non-empty array of up to 500 IDs"
        guard case .array(let ids)? = object["transaction_ids"] else {
            issues.append("transaction_ids: \(badIds)")
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        if ids.isEmpty || ids.count > 500 {
            fatal = false
            issues.append("transaction_ids: \(badIds)")
        }

        let badSlugs = "add_slugs must be an array of up to 50 slugs"
        let badRemove = "remove_slugs must be an array of up to 50 slugs"
        var add: [JSValue] = []
        var remove: [JSValue] = []
        if let value = object["add_slugs"] {
            if case .array(let slugs) = value {
                if slugs.count > 50 { issues.append("add_slugs: \(badSlugs)") }
                add = slugs
            } else {
                issues.append("add_slugs: \(badSlugs)")
                fatal = true
            }
        }
        if let value = object["remove_slugs"] {
            if case .array(let slugs) = value {
                if slugs.count > 50 { issues.append("remove_slugs: \(badRemove)") }
                remove = slugs
            } else {
                issues.append("remove_slugs: \(badRemove)")
                fatal = true
            }
        }

        // The lengths are plain checks; the superRefine runs beside them unless a leaf
        // type issue made the parse fatal.
        if !fatal, add.isEmpty, remove.isEmpty {
            issues.append("At least one of add_slugs or remove_slugs must be non-empty")
        }
        if !issues.isEmpty {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        return (ids, add, remove)
    }

    // MARK: - The action

    /// `bulkTagTransactions`: slug resolution, then the add and the remove in one write
    /// transaction, with the junction counts the route answers.
    static func tag(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let (idValues, addSlugs, removeSlugs) = try tagBody(request)

        // `validateInt4Ids`: a non-id element fails the whole request before any write.
        var txIds: [Int] = []
        for value in idValues {
            guard let id = TransactionsArea.validId(value) else {
                throw BackendHTTPError.validation(
                    "transaction_ids contains invalid value: \(AccountsArea.looseText(value))")
            }
            txIds.append(id)
        }
        if txIds.isEmpty {
            throw BackendHTTPError.validation("transaction_ids contains no valid IDs")
        }

        // Slug resolution: adds must reference active tags; removes may reference inactive.
        var addTagIds: [Int] = []
        var removeTagIds: [Int] = []
        var unknown: [String] = []
        if !addSlugs.isEmpty {
            let rows = try session.rows(
                "SELECT id, slug FROM tags WHERE slug IN (SELECT value FROM json_each(?)) AND is_active = 1",
                [.text(JSValue.array(addSlugs).jsonText)])
            var found: [String: Int] = [:]
            for row in rows { found[try row.text("slug")] = try row.integerId("id") }
            for slug in addSlugs {
                if let id = found[slug.javaScriptString] { addTagIds.append(id) } else {
                    unknown.append(AccountsArea.looseText(slug))
                }
            }
        }
        if !removeSlugs.isEmpty {
            let rows = try session.rows(
                "SELECT id, slug FROM tags WHERE slug IN (SELECT value FROM json_each(?))",
                [.text(JSValue.array(removeSlugs).jsonText)])
            var found: [String: Int] = [:]
            for row in rows { found[try row.text("slug")] = try row.integerId("id") }
            for slug in removeSlugs {
                if let id = found[slug.javaScriptString] { removeTagIds.append(id) } else {
                    unknown.append(AccountsArea.looseText(slug))
                }
            }
        }
        if !unknown.isEmpty {
            throw BackendHTTPError.validation("Unknown or inactive tags: \(unknown.joined(separator: ", "))")
        }

        let txIdsText = JSValue.array(txIds.map { .int($0) }).jsonText
        let outcome = try session.transaction { () -> (Int, Int, Int) in
            var affected: Set<Int> = []
            var added = 0
            var removed = 0
            if !addTagIds.isEmpty {
                let rows = try session.rows(
                    """
                    INSERT INTO transaction_tags (transaction_id, tag_id)
                    SELECT t.value, g.value FROM json_each(?) AS t CROSS JOIN json_each(?) AS g
                    WHERE true ON CONFLICT DO NOTHING RETURNING transaction_id
                    """, [.text(txIdsText),
                          .text(JSValue.array(addTagIds.map { .int($0) }).jsonText)])
                added = rows.count
                for row in rows { affected.insert(try row.integerId("transaction_id")) }
            }
            if !removeTagIds.isEmpty {
                let rows = try session.rows(
                    """
                    DELETE FROM transaction_tags
                    WHERE transaction_id IN (SELECT value FROM json_each(?))
                      AND tag_id IN (SELECT value FROM json_each(?))
                    RETURNING transaction_id
                    """, [.text(txIdsText),
                          .text(JSValue.array(removeTagIds.map { .int($0) }).jsonText)])
                removed = rows.count
                for row in rows { affected.insert(try row.integerId("transaction_id")) }
            }
            return (added, removed, affected.count)
        }
        return HandlerResult(data: .object([
            "added": .int(outcome.0),
            "removed": .int(outcome.1),
            "transactions_affected": .int(outcome.2),
        ]))
    }
}
