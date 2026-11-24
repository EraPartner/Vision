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
        backend.serve(OpenAPIOperations.BulkUpdateTransactions.self) { request in
            try await database.run { session in try TransactionBulkArea.update(session, request: request) }
        }
        backend.serve(OpenAPIOperations.BulkDeleteTransactions.self) { request in
            try await database.run { session in try TransactionBulkArea.delete(session, request: request) }
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

    // MARK: - The shared selector body

    /// The bulk body's raw object (`z.preprocess((body) => body ?? {})` then `z.object`): the
    /// ids, the filter and `expected_count` read as the TypeScript schema leaves them.
    static func bulkBody(_ request: InProcessRequest) throws -> (raw: JSObject, ids: JSValue?, filter: JSValue?, expected: JSValue?) {
        // `z.preprocess((body) => body ?? {})`: no body or a JSON null is an empty
        // selector, which the selector validation answers.
        guard let body = try RequestBody.parseJavaScript(request.body) else {
            return (JSObject(), nil, nil, nil)
        }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        return (object, object["ids"], object["filter"], object["expected_count"])
    }

    /// `lockAccountsForLedgerMutation`: every owning account of the rows must be open,
    /// checked inside the caller's write transaction.
    static func lockAccounts(_ session: BackendSession, _ txIds: [Int]) throws {
        guard !txIds.isEmpty else { return }
        let ownership = try session.rows(
            "SELECT id, account_id FROM transactions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
            [.text(JSValue.array(txIds.map { .int($0) }).jsonText)])
        var accountIds = Set<Int>()
        for row in ownership {
            if let account = try row.optionalInt64("account_id") { accountIds.insert(Int(account)) }
        }
        guard !accountIds.isEmpty else { return }
        let accounts = try session.rows(
            "SELECT id, is_active FROM accounts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
            [.text(JSValue.array(accountIds.sorted().map { .int($0) }).jsonText)])
        if accounts.count != accountIds.count
            || accounts.contains(where: { (try? $0.bool("is_active")) != true })
        {
            throw BackendHTTPError.validation(
                "Reopen the account before changing its ledger balance")
        }
    }

    // MARK: - The bulk update

    /// `bulkUpdateBodySchema`'s `fields`: strict presence-driven validation (no coercion), the
    /// sanitized object non-empty, and the one message per field the schema answers.
    // lint:allow raw-id the fields ride as the plain numbers the TypeScript schema parses
    static func updateFields(_ raw: JSValue?) throws -> (categoryId: JSValue?, recipientId: Int?, isActive: Bool?) {
        guard let raw, case .object(let object) = raw else {
            throw BackendHTTPError.validation(
                "`fields` must be an object with at least one updatable property")
        }
        var categoryId: JSValue?
        // lint:allow raw-id the recipient id rides as the plain number the schema parses
        var recipientId: Int?
        var isActive: Bool?
        var present = 0
        if let value = object["category_id"] {
            if value == .null {
                categoryId = .null
                present += 1
            } else if let id = TransactionsArea.validId(value) {
                categoryId = .number(Double(id))
                present += 1
            } else {
                throw BackendHTTPError.validation(
                    "category_id: `fields.category_id` must be a positive integer or null")
            }
        }
        if let value = object["recipient_id"] {
            guard let id = TransactionsArea.validId(value) else {
                throw BackendHTTPError.validation(
                    "recipient_id: `fields.recipient_id` must be a positive integer")
            }
            recipientId = id
            present += 1
        }
        if let value = object["is_active"] {
            guard case .bool(let flag) = value else {
                throw BackendHTTPError.validation(
                    "is_active: `fields.is_active` must be a boolean")
            }
            isActive = flag
            present += 1
        }
        if present == 0 {
            throw BackendHTTPError.validation(
                "`fields` must contain at least one of: category_id, recipient_id, is_active")
        }
        return (categoryId, recipientId, isActive)
    }

    /// `bulkUpdateTransactions`: FK checks up front, one shared SET in one write transaction.
    static func update(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let body = try bulkBody(request)
        let fields = try updateFields(body.raw["fields"])
        let expected = try BulkSelection.expectedCount(body.expected, filter: body.filter)
        let txIds = try BulkSelection.resolve(
            session, ids: body.ids, filter: body.filter, allowEmpty: expected != nil)

        if let value = fields.categoryId, value != .null,
            let id = TransactionsArea.validId(value)
        {
            let category = try session.row(
                "SELECT id FROM categories WHERE id = ? AND is_active = 1", [.integer(Int64(id))])
            if category == nil {
                throw BackendHTTPError.validation(
                    "Category \(id) does not exist or is inactive")
            }
        }
        if let id = fields.recipientId {
            let recipient = try session.row(
                "SELECT id FROM recipients WHERE id = ? AND is_active = 1", [.integer(Int64(id))])
            if recipient == nil {
                throw BackendHTTPError.validation(
                    "Recipient \(id) does not exist or is inactive")
            }
        }

        // Presence drives the SET list; the write transaction replaces the account lock.
        var sets: [String] = []
        var arguments: [SQLValue] = []
        if let value = fields.categoryId {
            sets.append("category_id = ?")
            arguments.append(value == .null
                ? .null : .integer(Int64(TransactionsArea.validId(value) ?? 0)))
        }
        if let id = fields.recipientId {
            sets.append("recipient_id = ?")
            arguments.append(.integer(Int64(id)))
        }
        if let flag = fields.isActive {
            sets.append("is_active = ?")
            arguments.append(.integer(flag ? 1 : 0))
        }
        sets.append("updated_at = now()")
        let txText = JSValue.array(txIds.map { .int($0) }).jsonText
        let updated = try session.transaction { () -> Int in
            if fields.isActive != nil { try TransactionBulkArea.lockAccounts(session, txIds) }
            return try session.rows(
                """
                UPDATE transactions SET \(sets.joined(separator: ", "))
                WHERE id IN (SELECT value FROM json_each(?)) RETURNING id
                """, arguments + [.text(txText)]).count
        }
        return HandlerResult(data: .object([
            "updated": .int(updated),
            "requested": .int(expected ?? txIds.count),
            "matched": .int(txIds.count),
        ]))
    }

    // MARK: - The bulk delete

    /// `bulkDeleteTransactions`: the planned-execution guard and the hard delete in one write
    /// transaction, with the attachment files removed best-effort after the commit.
    static func delete(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let body = try bulkBody(request)
        let expected = try BulkSelection.expectedCount(body.expected, filter: body.filter)
        let txIds = try BulkSelection.resolve(
            session, ids: body.ids, filter: body.filter, allowEmpty: expected != nil)

        let txText = JSValue.array(txIds.map { .int($0) }).jsonText
        let paths = try session.rows(
            "SELECT stored_path FROM attachments WHERE transaction_id IN (SELECT value FROM json_each(?))",
            [.text(txText)]).compactMap { try? $0.optionalText("stored_path") }
        let deleted = try session.transaction { () -> Int in
            try TransactionBulkArea.lockAccounts(session, txIds)
            if !txIds.isEmpty {
                let linked = try session.row(
                    """
                    SELECT 1 FROM planned_transaction_executions
                    WHERE executed_transaction_id IN (SELECT value FROM json_each(?)) LIMIT 1
                    """, [.text(txText)])
                if linked != nil {
                    throw BackendHTTPError.conflict(
                        "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction")
                }
            }
            return try session.rows(
                "DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?)) RETURNING id",
                [.text(txText)]).count
        }
        for path in paths {
            try? FileManager.default.removeItem(atPath: path)
        }
        return HandlerResult(data: .object([
            "deleted": .int(deleted),
            "requested": .int(expected ?? txIds.count),
            "matched": .int(txIds.count),
        ]))
    }
}
