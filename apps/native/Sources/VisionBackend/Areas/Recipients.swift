import Foundation
import VisionNativeCore

/// An enriched `recipients` row (`enrichedRecipientRowSchema` of `database/rows/catalog.ts`).
struct RecipientRow: Equatable, Sendable {
    let id: RecipientID
    let name: String
    let normalizedName: String
    let defaultCategoryId: CategoryID?
    let primaryRecipientId: RecipientID?
    let notes: String?
    let isActive: Bool
    let createdAt: Instant?
    let updatedAt: Instant
    let defaultCategoryName: String?
    let primaryBankAccount: String?
    let primaryRecipientName: String?
    let aliasCount: Int

    init(_ row: SQLRow) throws {
        id = RecipientID(rawValue: try row.integerId("id"))
        name = try row.text("name")
        normalizedName = try row.text("normalized_name")
        defaultCategoryId = try CategoryRow.optionalId(row, "default_category_id")
        if try row.optionalInt64("primary_recipient_id") != nil {
            primaryRecipientId = RecipientID(rawValue: try row.integerId("primary_recipient_id"))
        } else {
            primaryRecipientId = nil
        }
        notes = try row.optionalText("notes")
        isActive = try row.bool("is_active")
        if try row.optionalText("created_at") != nil {
            createdAt = try row.instant("created_at")
        } else {
            createdAt = nil
        }
        updatedAt = try row.instant("updated_at")
        defaultCategoryName = try row.optionalText("default_category_name")
        primaryBankAccount = try row.optionalText("primary_bank_account")
        primaryRecipientName = try row.optionalText("primary_recipient_name")
        aliasCount = Int(try row.int64("alias_count"))
    }

    var json: [String: JSONValue] {
        func text(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        return [
            "id": .int(id.rawValue), "name": .string(name), "normalized_name": .string(normalizedName),
            "default_category_id": defaultCategoryId.map { JSONValue.int($0.rawValue) } ?? .null,
            "primary_recipient_id": primaryRecipientId.map { JSONValue.int($0.rawValue) } ?? .null,
            "notes": text(notes), "is_active": .bool(isActive),
            "created_at": createdAt.map { JSONValue.string($0.text) } ?? .null,
            "updated_at": .string(updatedAt.text), "default_category_name": text(defaultCategoryName),
            "primary_bank_account": text(primaryBankAccount), "primary_recipient_name": text(primaryRecipientName),
            "alias_count": .int(aliasCount),
        ]
    }
}

/// `routes/recipients.ts`, `repositories/recipientRepository.ts`,
/// `services/recipientMergeService.ts` and `services/recipientPatternService.ts` for the
/// operations the app calls: the list, one recipient, create, update, delete, merge and
/// unmerge, and the match patterns. The clusters, aliases and bank-account routes are not in
/// the generated client and stay on Bun.
///
/// Updates, deletes, merges and unmerges call `scheduleRefresh()` (`MaterializedViewRefresher`).
/// Regex patterns compile and match in JavaScriptCore, Bun's engine (`JavaScriptRegExp`).
enum RecipientsArea {
    static func register(
        _ backend: inout InProcessBackend, database: BackendDatabase, views: MaterializedViewRefresher
    ) {
        backend.serve(OpenAPIOperations.GetRecipients.self) { request in
            let filters = try RecipientsArea.listFilters(request)
            return try await database.run { session in try RecipientsArea.list(session, filters) }
        }
        backend.serve(OpenAPIOperations.GetRecipient.self) { request in
            let id = try RecipientsArea.pathId(request)
            return try await database.run { session in
                guard let recipient = try RecipientsArea.getById(session, id) else {
                    throw BackendHTTPError.notFound("Recipient not found")
                }
                return HandlerResult(data: .object(RecipientsArea.withLinks(recipient.json)))
            }
        }
        backend.serve(OpenAPIOperations.CreateRecipient.self) { request in
            let body = try RecipientsArea.parse(createSchema, try RequestBody.parseJavaScript(request.body))
            return try await database.run { session in try RecipientsArea.create(session, body) }
        }
        backend.serve(OpenAPIOperations.UpdateRecipient.self) { request in
            let id = try RecipientsArea.pathId(request)
            let body = try RecipientsArea.parse(updateSchema, try RequestBody.parseJavaScript(request.body))
            let result = try await database.run { session in
                guard let updated = try RecipientsArea.update(session, id, RecipientsArea.changes(body)) else {
                    throw BackendHTTPError.notFound("Recipient not found")
                }
                return HandlerResult(data: .object(RecipientsArea.withLinks(updated.json)))
            }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.DeleteRecipient.self) { request in
            let id = try RecipientsArea.pathId(request)
            let result = try await database.run { session in
                guard try session.row("DELETE FROM recipients WHERE id = ? RETURNING id", [id.sqlValue]) != nil else {
                    throw BackendHTTPError.notFound("Recipient not found")
                }
                return HandlerResult.noContent
            }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.MergeRecipient.self) { request in
            let id = try RecipientsArea.pathId(request)
            let body = try RecipientsArea.parse(mergeSchema, try RequestBody.parseJavaScript(request.body))
            let aliasIds = (body["alias_ids"].flatMap { value -> [JSValue]? in
                if case .array(let items) = value { return items }
                return nil
            } ?? []).compactMap { value -> RecipientID? in
                guard case .number(let number) = value, let raw = Int(exactly: number) else { return nil }
                return RecipientID(rawValue: raw)
            }
            let result = try await database.run { session in try RecipientsArea.merge(session, id, aliasIds) }
            views.schedule()
            return result
        }
        backend.serve(OpenAPIOperations.UnmergeRecipient.self) { request in
            let id = try RecipientsArea.pathId(request)
            let result = try await database.run { session in
                guard
                    try session.row(
                        "UPDATE recipients SET primary_recipient_id = NULL, updated_at = now() WHERE id = ? RETURNING id",
                        [id.sqlValue]) != nil
                else { throw BackendHTTPError.notFound("Recipient not found") }
                return HandlerResult(data: .object(RecipientsArea.withLinks(try RecipientsArea.getById(session, id)?.json ?? [:])))
            }
            views.schedule()
            return result
        }
        RecipientPatterns.register(&backend, database: database)
    }

    // MARK: - Request input

    /// `idSchema()`'s 400: `<key>: must be a positive integer`.
    static func idValue(_ raw: String?, _ key: String, issues: inout [String]) -> Int? {
        guard let raw, let id = RequestID.valid(.string(raw)) else {
            issues.append("\(key): must be a positive integer")
            return nil
        }
        return Int(id)
    }

    /// `parseInput(recipientIdParams, req.params)`.
    static func pathId(_ request: InProcessRequest) throws -> RecipientID {
        RecipientID(rawValue: try RequestID.pathParameter(request))
    }

    static func parse(_ schema: Zod, _ body: JSValue?) throws -> JSObject {
        try CategoriesArea.parse(schema, body)
    }

    static func withLinks(_ fields: [String: JSONValue]) -> [String: JSONValue] {
        var data = fields
        data["links"] = .array([])
        return data
    }

    /// `requiredString`: absent or `''` is missing, anything else not a string is the type 400.
    static let requiredString = Zod.transform(.unknown) { value, issues in
        guard let value else {
            issues.append(ZodIssue(message: "Missing required field"))
            return nil
        }
        guard case .string(let text) = value else {
            issues.append(ZodIssue(message: "must be a string"))
            return nil
        }
        if text.isEmpty {
            issues.append(ZodIssue(message: "Missing required field", continues: true))
            return nil
        }
        return value
    }

    /// `nullableEntityId`: null, or `idSchema()` piped into the brand; a union failure is the
    /// bare `Invalid input`.
    static let nullableCategoryId = Zod.transform(.unknown) { value, issues in
        guard let value, value != .null else { return value }
        guard let id = RequestID.valid(value) else {
            issues.append(ZodIssue(message: "Invalid input"))
            return nil
        }
        return .number(id)
    }.optional

    static let optionalText = Zod.string.nullable.optional

    static let createSchema = Zod.object(
        [("name", requiredString), ("default_category_id", nullableCategoryId), ("notes", optionalText)], .strip)

    static let updateSchema = Zod.object(
        [
            ("name", optionalText), ("default_category_id", nullableCategoryId), ("notes", optionalText),
            ("is_active", Zod.boolean.nullable.optional),
        ], .strip)

    private static let aliasMessage = "Missing required field: alias_ids (array of recipient IDs)"

    /// `z.array(recipientIdSchema(), { error }).min(1, error)`.
    static let mergeSchema = Zod.object(
        [
            (
                "alias_ids",
                Zod.transform(.unknown) { value, issues in
                    guard case .array(let items)? = value else {
                        issues.append(ZodIssue(message: aliasMessage))
                        return nil
                    }
                    var output: [JSValue] = []
                    for (index, item) in items.enumerated() {
                        if let id = RequestID.valid(item) {
                            output.append(.number(id))
                        } else {
                            issues.append(
                                ZodIssue(path: [.index(index)], message: "must be a positive integer", continues: true))
                        }
                    }
                    if items.isEmpty { issues.append(ZodIssue(message: aliasMessage, continues: true)) }
                    return issues.isEmpty ? .array(output) : nil
                }
            )
        ], .strip)

    // MARK: - GET /api/recipients

    struct ListFilters: Sendable {
        var limit: JavaScriptInteger
        var offset: JavaScriptInteger
        var name: String?
        var search: String?
        var sortBy: String?
        var sortDir: String?
        var defaultCategoryId: CategoryID?
        var active: Bool
        var uncategorized: Bool
    }

    /// `listQuery`: `singleQueryString` fields refuse a repeated key, in the schema's order.
    static func listFilters(_ request: InProcessRequest) throws -> ListFilters {
        var issues: [String] = []
        func single(_ key: String) -> String? {
            let values = request.queryItems.filter { $0.name == key }
            if values.count > 1 {
                issues.append("\(key): must be a single value")
                return nil
            }
            return values.first.map { $0.value ?? "" }
        }
        let name = single("name")
        let search = single("search")
        let sortBy = single("sort_by")
        let sortValues = request.queryItems.filter { $0.name == "sort_dir" }
        let sortDir = sortValues.count == 1 ? sortValues[0].value : nil
        var defaultCategoryId: CategoryID?
        let categoryValues = request.queryItems.filter { $0.name == "default_category_id" }
        if categoryValues.count > 1 || (categoryValues.count == 1 && !(categoryValues[0].value ?? "").isEmpty) {
            let raw = categoryValues.count == 1 ? categoryValues[0].value : nil
            if let id = idValue(raw, "default_category_id", issues: &issues) {
                defaultCategoryId = CategoryID(rawValue: id)
            }
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        let ordered = sortDir.flatMap { RecipientsArea.sortDirections.contains($0) ? $0 : nil }
        return ListFilters(
            limit: .clamped(request.query("limit"), min: 1, max: 1000, fallback: 50),
            offset: .clamped(request.query("offset"), min: 0, fallback: 0),
            name: name.flatMap { $0.isEmpty ? nil : $0 },
            search: search.flatMap { $0.isEmpty ? nil : String(decoding: Array($0.utf16.prefix(200)), as: UTF16.self) },
            sortBy: sortBy.flatMap { $0.isEmpty ? nil : $0 }, sortDir: ordered, defaultCategoryId: defaultCategoryId,
            active: QueryInput.boolean(request.query("active"), default: true),
            uncategorized: QueryInput.boolean(request.query("uncategorized"), default: false))
    }

    static let sortDirections: Set<String> = ["asc", "desc"]

    /// `RECIPIENT_SORT_COLUMNS`.
    static let sortColumns: [String: String] = [
        "name": "r.name",
        "default_category_name": "CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END",
        "primary_bank_account": "primary_bank_account",
        "alias_count": "alias_count",
        "notes": "r.notes",
        "is_active": "r.is_active",
    ]

    /// `Object.prototype`'s methods: a lookup of one in `RECIPIENT_SORT_COLUMNS` finds a
    /// function, which SQLite cannot bind (a 500). `__proto__` finds the prototype object,
    /// which binds as NULL, so it sorts like an unknown key.
    static let prototypeKeys: Set<String> = [
        "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__",
        "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString",
    ]

    struct UnbindableSortColumn: Error {}

    /// `ENRICHED_RECIPIENTS`.
    static let enriched = """
              SELECT r.*,
                     CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name,
                     (
                       SELECT rba.account_number
                       FROM recipient_bank_accounts rba
                       WHERE rba.recipient_id = r.id AND rba.is_active = true
                       ORDER BY rba.is_primary DESC
                       LIMIT 1
                     ) AS primary_bank_account,
                     pr.name AS primary_recipient_name,
                     COALESCE(ac.alias_count, 0) AS alias_count
              FROM recipients r
              LEFT JOIN categories c ON r.default_category_id = c.id
              LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
              LEFT JOIN (
                SELECT primary_recipient_id, count(*) AS alias_count
                FROM recipients
                WHERE primary_recipient_id IS NOT NULL
                GROUP BY primary_recipient_id
              ) ac ON ac.primary_recipient_id = r.id
        """

    /// `buildWhereClause`.
    static func whereClause(_ filters: ListFilters) -> (String, [SQLValue]) {
        var conditions = ["1=1"]
        var arguments: [SQLValue] = []
        if filters.active { conditions.append("r.is_active = true") }
        if let name = filters.name {
            conditions.append("r.name REGEXP ?")
            arguments.append(.text(RecipientText.unicodeIlikeRegex("%\(name)%")))
        }
        if filters.uncategorized {
            conditions.append(
                """
                r.default_category_id IS NULL
                             AND EXISTS (
                               SELECT 1 FROM transactions t
                               WHERE t.recipient_id = r.id
                                 AND t.is_active = true
                                 AND t.is_transfer = false
                                 AND t.currency IS NOT NULL
                             )
                """)
        } else if let category = filters.defaultCategoryId {
            conditions.append(
                "r.default_category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = ?)")
            arguments.append(category.sqlValue)
        }
        if let search = filters.search {
            let pattern = SQLValue.text(RecipientText.unicodeIlikeRegex("%\(search)%"))
            conditions.append(
                """
                (
                      r.name REGEXP ? OR
                      r.notes REGEXP ? OR
                      c.general REGEXP ? OR
                      c.detail REGEXP ? OR
                      EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number REGEXP ?)
                    )
                """)
            arguments += Array(repeating: pattern, count: 5)
        }
        return ("WHERE " + conditions.joined(separator: " AND "), arguments)
    }

    /// `getAll` and `getCount`.
    static func list(_ session: BackendSession, _ filters: ListFilters) throws -> HandlerResult {
        let (clause, arguments) = whereClause(filters)
        var orderBy = "r.name ASC"
        if let sortBy = filters.sortBy {
            if prototypeKeys.contains(sortBy) { throw UnbindableSortColumn() }
            if let column = sortColumns[sortBy] {
                let direction = filters.sortDir == "desc" ? "DESC NULLS FIRST" : "ASC NULLS LAST"
                orderBy = "\(column) \(direction), r.name ASC"
            }
        }
        let rows = try session.rows(
            "\(enriched)\n      \(clause)\n      ORDER BY \(orderBy) LIMIT ? OFFSET ?",
            arguments + [filters.limit.sqlValue, filters.offset.sqlValue]
        ).map(RecipientRow.init)
        guard
            let count = try session.row(
                """
                SELECT count(*) AS count FROM recipients r
                      LEFT JOIN categories c ON r.default_category_id = c.id
                      \(clause)
                """, arguments)
        else { throw SQLRowDecodingError(column: "count", problem: "no recipient count row") }
        return HandlerResult(
            data: .object([
                "items": .array(rows.map { .object(withLinks($0.json)) }), "total": .int(Int(try count.int64("count"))),
                "limit": filters.limit.json, "offset": filters.offset.json, "links": .array([]),
            ]))
    }

    static func getById(_ session: BackendSession, _ id: RecipientID) throws -> RecipientRow? {
        try session.row("\(enriched)\n      WHERE r.id = ?", [id.sqlValue]).map(RecipientRow.init)
    }

    // MARK: - Writes

    static let systemName = "SYSTEM"

    /// `makeValidationError`: a plain `Error` with a code, which the error handler answers as
    /// a masked 500.
    struct RepositoryValidationError: Error {
        let message: String
    }

    static func assertNotSystem(_ name: String) throws {
        if RecipientText.normalizeForMatching(name) == RecipientText.normalizeForMatching(systemName) {
            throw RepositoryValidationError(message: "\(systemName) is reserved for server-generated transactions")
        }
    }

    /// `createOrGet`, then the default category and notes; 201 when created.
    static func create(_ session: BackendSession, _ body: JSObject) throws -> HandlerResult {
        let name = body["name"]?.stringValue ?? ""
        let upperName = JavaScriptWhitespace.trim(name.uppercased())
        let normalized = RecipientText.normalizeForMatching(name)
        try assertNotSystem(name)
        let (recipientId, created) = try createOrGetId(session, upperName: upperName, normalized: normalized)
        // Only nil if the row vanished between the upsert and the read.
        guard let recipient = try getById(session, recipientId) else {
            throw BackendHTTPError.notFound("Recipient not found")
        }
        var final: RecipientRow? = recipient
        let category = body["default_category_id"]
        let notes = body["notes"]
        if (category != nil && category != .null) || (notes != nil && notes != .null) {
            var changes: [(String, SQLValue)] = []
            if let category { changes.append(("default_category_id", sqlValue(category))) }
            if let notes { changes.append(("notes", sqlValue(notes))) }
            final = try update(session, recipient.id, changes)
        }
        var data = final?.json ?? [:]
        data["created"] = .bool(created)
        data["links"] = .array([])
        return HandlerResult(status: created ? 201 : 200, data: .object(data))
    }

    /// The existing row's id without a write, else the insert's (or the concurrent winner's).
    static func createOrGetId(_ session: BackendSession, upperName: String, normalized: String) throws
        -> (RecipientID, Bool)
    {
        if let existing = try session.row("SELECT id FROM recipients WHERE normalized_name = ?", [.text(normalized)]) {
            return (RecipientID(rawValue: try existing.integerId("id")), false)
        }
        return try session.transaction { () throws -> (RecipientID, Bool) in
            if let inserted = try session.row(
                """
                INSERT INTO recipients (name, normalized_name, is_active) VALUES (?, ?, 1)
                ON CONFLICT (normalized_name) DO NOTHING RETURNING id
                """, [.text(upperName), .text(normalized)])
            {
                return (RecipientID(rawValue: try inserted.integerId("id")), true)
            }
            guard let winner = try session.row("SELECT id FROM recipients WHERE normalized_name = ?", [.text(normalized)])
            else { throw SQLRowDecodingError(column: "id", problem: "recipient upsert found no row") }
            return (RecipientID(rawValue: try winner.integerId("id")), false)
        }
    }

    static func sqlValue(_ value: JSValue) -> SQLValue {
        switch value {
        case .null: return .null
        case .bool(let flag): return .integer(flag ? 1 : 0)
        case .number(let number): return Int64(exactly: number).map(SQLValue.integer) ?? .real(number)
        case .string(let text): return .text(text)
        case .array, .object: return .text(value.jsonText)
        }
    }

    /// The update body as `recipientRepository.update` reads it: null name and is_active leave
    /// the column unchanged, a name also rewrites `normalized_name`.
    static func changes(_ body: JSObject) throws -> [(String, SQLValue)] {
        var changes: [(String, SQLValue)] = []
        if case .string(let name)? = body["name"] {
            try assertNotSystem(name)
            changes.append(("name", .text(JavaScriptWhitespace.trim(name.uppercased()))))
            changes.append(("normalized_name", .text(RecipientText.normalizeForMatching(name))))
        }
        if let category = body["default_category_id"] { changes.append(("default_category_id", sqlValue(category))) }
        if let notes = body["notes"] { changes.append(("notes", sqlValue(notes))) }
        if case .bool(let flag)? = body["is_active"] { changes.append(("is_active", .integer(flag ? 1 : 0))) }
        return changes
    }

    /// `recipientRepository.update`: the enriched row, or nil when absent.
    static func update(_ session: BackendSession, _ id: RecipientID, _ changes: [(String, SQLValue)]) throws
        -> RecipientRow?
    {
        if changes.isEmpty { return try getById(session, id) }
        return try session.transaction { () throws -> RecipientRow? in
            let assignments = changes.map { "\($0.0) = ?" }.joined(separator: ", ")
            guard
                try session.row(
                    "UPDATE recipients SET \(assignments), updated_at = now() WHERE id = ? RETURNING id",
                    changes.map(\.1) + [id.sqlValue]) != nil
            else { return nil }
            return try getById(session, id)
        }
    }

    // MARK: - POST /api/recipients/{id}/merge

    struct Reassigned {
        var transactions = 0
        var splits = 0
        var planned = 0
        var bankAccounts = 0

        var json: JSONValue {
            .object([
                "transactions": .int(transactions), "splits": .int(splits), "planned": .int(planned),
                "bankAccounts": .int(bankAccounts),
            ])
        }
    }

    /// `JSON.stringify(ids)` for `json_each`.
    static func jsonIds(_ ids: [RecipientID]) -> SQLValue {
        .text("[" + ids.map { String($0.rawValue) }.joined(separator: ",") + "]")
    }

    /// The number of rows one statement with `RETURNING id` wrote.
    static func count(_ session: BackendSession, _ sql: String, _ arguments: [SQLValue]) throws -> Int {
        try session.rows(sql, arguments).count
    }

    /// `mergeRecipients`: one transaction repoints every reference of the aliases to the
    /// primary and marks them as its aliases.
    static func mergeAtomic(_ session: BackendSession, _ primary: RecipientID, _ aliasIds: [RecipientID]) throws
        -> ([RecipientID], Reassigned)
    {
        let ids = aliasIds.filter { $0 != primary }
        if ids.isEmpty { return ([], Reassigned()) }
        return try session.transaction { () throws -> ([RecipientID], Reassigned) in
            let lockIds = Array(Set([primary] + ids)).sorted()
            let participants = try session.rows(
                """
                SELECT id, primary_recipient_id FROM recipients
                 WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id
                """, [jsonIds(lockIds)])
            guard let row = try participants.first(where: { try $0.integerId("id") == primary.rawValue }) else {
                throw BackendHTTPError.notFound("Primary recipient not found")
            }
            if try row.optionalInt64("primary_recipient_id") != nil {
                throw BackendHTTPError.conflict("Primary recipient is now an alias. Use its primary instead.")
            }
            let aliases = jsonIds(ids)
            var reassigned = Reassigned()
            reassigned.transactions = try count(
                session,
                """
                UPDATE transactions SET recipient_id = ?, updated_at = now()
                 WHERE recipient_id IN (SELECT value FROM json_each(?)) RETURNING id
                """, [primary.sqlValue, aliases])
            reassigned.splits = try count(
                session,
                """
                UPDATE transaction_splits SET recipient_id = ?, updated_at = now()
                 WHERE recipient_id IN (SELECT value FROM json_each(?)) RETURNING id
                """, [primary.sqlValue, aliases])
            if try session.row(
                "SELECT 1 AS present FROM pragma_table_info('planned_transactions') WHERE name = 'recipient_id' LIMIT 1")
                != nil
            {
                reassigned.planned = try count(
                    session,
                    """
                    UPDATE planned_transactions SET recipient_id = ?, updated_at = now()
                     WHERE recipient_id IN (SELECT value FROM json_each(?)) RETURNING id
                    """, [primary.sqlValue, aliases])
            }
            _ = try session.rows(
                """
                DELETE FROM recipient_bank_accounts
                 WHERE recipient_id IN (SELECT value FROM json_each(?))
                   AND EXISTS (SELECT keep.id FROM recipient_bank_accounts AS keep
                                WHERE keep.recipient_id = ?
                                  AND keep.account_number = recipient_bank_accounts.account_number)
                """, [aliases, primary.sqlValue])
            reassigned.bankAccounts = try count(
                session,
                """
                UPDATE recipient_bank_accounts SET recipient_id = ?, updated_at = now()
                 WHERE recipient_id IN (SELECT value FROM json_each(?)) RETURNING id
                """, [primary.sqlValue, aliases])
            let merged = try session.rows(
                """
                UPDATE recipients SET primary_recipient_id = ?, updated_at = now()
                 WHERE id IN (SELECT value FROM json_each(?)) AND id <> ? RETURNING id
                """, [primary.sqlValue, aliases, primary.sqlValue]
            ).map { RecipientID(rawValue: try $0.integerId("id")) }
            _ = try session.rows(
                """
                UPDATE recipients SET primary_recipient_id = ?, updated_at = now()
                 WHERE primary_recipient_id IN (SELECT value FROM json_each(?)) AND id <> ?
                """, [primary.sqlValue, aliases, primary.sqlValue])
            return (merged, reassigned)
        }
    }

    /// The merge route: the primary must exist and not be an alias; the answer carries the
    /// primary, the merged ids, the reassigned counts, its aliases and a pattern suggestion.
    static func merge(_ session: BackendSession, _ primaryId: RecipientID, _ aliasIds: [RecipientID]) throws
        -> HandlerResult
    {
        guard let primary = try getById(session, primaryId) else {
            throw BackendHTTPError.notFound("Primary recipient not found")
        }
        if primary.primaryRecipientId != nil {
            throw BackendHTTPError.validation(
                "Cannot merge into a recipient that is itself an alias. Use its primary instead.")
        }
        let (merged, reassigned) = try mergeAtomic(session, primaryId, aliasIds)
        guard let updated = try getById(session, primaryId) else {
            throw BackendHTTPError.notFound("Primary recipient not found")
        }
        let aliases = try session.rows(
            "SELECT id, name FROM recipients r WHERE r.primary_recipient_id = ? ORDER BY r.name", [primaryId.sqlValue])
        var aliasItems: [JSONValue] = []
        var mergedNames: [String] = []
        let mergedSet = Set(merged)
        for alias in aliases {
            let id = try alias.integerId("id")
            let name = try alias.text("name")
            aliasItems.append(.object(["id": .int(id), "name": .string(name)]))
            if mergedSet.contains(RecipientID(rawValue: id)) { mergedNames.append(name) }
        }
        var suggestion = JSONValue.null
        if let suggested = RecipientText.suggestPattern([updated.name] + mergedNames),
            let preview = try? RecipientPatterns.preview(
                session, pattern: suggested.pattern, kind: RecipientPatternKind.literalPrefix, caseSensitive: false)
        {
            suggestion = .object([
                "pattern": .string(suggested.pattern), "kind": .string(RecipientPatternKind.literalPrefix),
                "matchCount": .int(preview.ids.count), "confidence": .string(suggested.confidence),
            ])
        }
        return HandlerResult(
            data: .object([
                "primary": .object(withLinks(updated.json)), "merged_ids": .array(merged.map { .int($0.rawValue) }),
                "reassigned": reassigned.json, "aliases": .array(aliasItems), "patternSuggestion": suggestion,
            ]))
    }
}
