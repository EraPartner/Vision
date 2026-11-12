import Foundation
import VisionNativeCore

/// The match-pattern routes of `routes/recipients.ts` over `services/recipientPatternService.ts`:
/// list, create, preview, update and delete. Patterns do not feed the dashboard tables, so
/// none of them schedules a refresh.
enum RecipientPatterns {
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetRecipientPatterns.self) { request in
            let id = try RecipientsArea.pathId(request)
            return try await database.run { session in try RecipientPatterns.list(session, id) }
        }
        backend.serve(OpenAPIOperations.CreateRecipientPattern.self) { request in
            let id = try RecipientsArea.pathId(request)
            let body = try RecipientsArea.parse(createSchema, try RequestBody.parseJavaScript(request.body))
            return try await database.run { session in try RecipientPatterns.create(session, id, body) }
        }
        backend.serve(OpenAPIOperations.PreviewRecipientPattern.self) { request in
            _ = try RecipientsArea.pathId(request)
            let body = try RecipientsArea.parse(previewSchema, try RequestBody.parseJavaScript(request.body))
            let pattern = body["pattern"]?.stringValue ?? ""
            let kind = body["pattern_kind"]?.stringValue ?? RecipientPatternKind.literalPrefix
            let caseSensitive = body["case_sensitive"] == .bool(true)
            return try await database.run { session in
                let preview = try RecipientPatterns.preview(
                    session, pattern: pattern, kind: kind, caseSensitive: caseSensitive)
                return HandlerResult(data: preview.json)
            }
        }
        backend.serve(OpenAPIOperations.UpdateRecipientPattern.self) { request in
            let patternId = try RecipientPatterns.patternParams(request)
            let body = try RecipientsArea.parse(updateSchema, try RequestBody.parseJavaScript(request.body))
            return try await database.run { session in
                try RecipientPatterns.update(session, patternId, body)
                return HandlerResult(data: .object(["patternId": .int(patternId.rawValue)]))
            }
        }
        backend.serve(OpenAPIOperations.DeleteRecipientPattern.self) { request in
            let patternId = try RecipientPatterns.patternParams(request)
            return try await database.run { session in
                _ = try session.rows("DELETE FROM recipient_match_patterns WHERE id = ?", [patternId.sqlValue])
                return HandlerResult.noContent
            }
        }
    }

    // MARK: - Request input

    /// `patternParams`: `id` then `patternId`, both `idSchema()`.
    static func patternParams(_ request: InProcessRequest) throws -> RecipientPatternID {
        var issues: [String] = []
        _ = RecipientsArea.idValue(request.pathParameters["id"], "id", issues: &issues)
        let patternId = RecipientsArea.idValue(request.pathParameters["patternId"], "patternId", issues: &issues)
        guard issues.isEmpty, let patternId else {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        return RecipientPatternID(rawValue: patternId)
    }

    /// `z.int32()`: an integer from -2^31 to 2^31 - 1.
    static let int32 = Zod.checked(
        .number,
        [
            ZodCheck(when: nil) { value in
                guard case .number(let number)? = value else { return [] }
                guard number.isFinite, number.rounded(.towardZero) == number else {
                    return [ZodIssue(message: "Invalid input: expected int, received number", stops: true)]
                }
                if number < -2_147_483_648 {
                    return [ZodIssue(message: "Too small: expected number to be >=-2147483648", continues: true)]
                }
                if number > 2_147_483_647 {
                    return [ZodIssue(message: "Too big: expected number to be <=2147483647", continues: true)]
                }
                return []
            }
        ])

    static let kind = Zod.enumeration(RecipientPatternKind.all)

    /// `createPatternBody`: on create, null means "use the default".
    static let createSchema = Zod.object(
        [
            ("pattern", RecipientsArea.requiredString), ("pattern_kind", kind.nullish),
            ("case_sensitive", Zod.boolean.nullish), ("priority", int32.nullish), ("notes", Zod.string.nullable.optional),
        ], .strip)

    static let previewSchema = Zod.object(
        [
            ("pattern", RecipientsArea.requiredString), ("pattern_kind", kind.nullish),
            ("case_sensitive", Zod.boolean.nullish),
        ], .strip)

    /// `updatePatternBody`: these columns are NOT NULL, so null stays a 400.
    static let updateSchema = Zod.object(
        [
            ("pattern", Zod.string.optional), ("pattern_kind", kind.optional), ("case_sensitive", Zod.boolean.optional),
            ("priority", int32.optional), ("notes", Zod.string.nullable.optional), ("is_active", Zod.boolean.optional),
        ], .strip)

    // MARK: - Validation and matching

    /// `validatePattern`: the 400 of an empty, overlong, backtracking-prone or uncompilable
    /// pattern.
    static func validate(pattern: String, kind: String, caseSensitive: Bool) throws {
        if pattern.isEmpty || JavaScriptWhitespace.trim(pattern).isEmpty {
            throw BackendHTTPError.validation("Pattern must not be empty")
        }
        if pattern.utf16.count > 500 { throw BackendHTTPError.validation("Pattern must not exceed 500 characters") }
        if kind == RecipientPatternKind.regex, JavaScriptRegExp.shared.hasRedosRisk(pattern) {
            throw BackendHTTPError.validation(
                "Regex pattern contains nested quantifiers or quantified alternation that could cause catastrophic backtracking"
            )
        }
        if let message = JavaScriptRegExp.shared.compileError(
            RecipientText.patternSource(pattern, kind: kind), flags: caseSensitive ? "" : "i")
        {
            throw BackendHTTPError.validation("Invalid pattern: \(message)")
        }
    }

    struct Preview {
        let ids: [Int]
        let truncated: Bool?

        var json: JSONValue {
            var fields: [String: JSONValue] = ["matchCount": .int(ids.count), "recipientIds": .array(ids.map { .int($0) })]
            if let truncated { fields["truncated"] = .bool(truncated) }
            return .object(fields)
        }
    }

    /// `PREVIEW_REGEX_SCAN_CAP`.
    static let previewScanCap = 10_000

    /// `previewPatternMatches`: the active recipients whose upper-cased name matches. Regex
    /// patterns match in JavaScript over at most 10,000 rows; the others as SQL AREs.
    static func preview(_ session: BackendSession, pattern: String, kind: String, caseSensitive: Bool) throws
        -> Preview
    {
        try validate(pattern: pattern, kind: kind, caseSensitive: caseSensitive)
        if kind == RecipientPatternKind.regex {
            let rows = try session.rows(
                "SELECT id, name FROM recipients WHERE is_active = 1 ORDER BY id LIMIT ?", [.integer(Int64(previewScanCap + 1))])
            let truncated = rows.count > previewScanCap
            let scanned = Array(rows.prefix(previewScanCap))
            let names = try scanned.map { try $0.text("name") }
            let matches = JavaScriptRegExp.shared.test(pattern, flags: caseSensitive ? "" : "i", names, upperCased: true)
            var ids: [Int] = []
            for (row, matched) in zip(scanned, matches) where matched { ids.append(try row.integerId("id")) }
            return Preview(ids: ids, truncated: truncated)
        }
        let source = RecipientText.patternSource(pattern, kind: kind)
        let match = caseSensitive ? "UPPER(name) REGEXP ?" : "regexp_i(UPPER(name), ?)"
        let rows = try session.rows("SELECT id FROM recipients WHERE is_active = 1 AND \(match)", [.text(source)])
        return Preview(ids: try rows.map { try $0.integerId("id") }, truncated: nil)
    }

    // MARK: - Routes

    static func list(_ session: BackendSession, _ recipient: RecipientID) throws -> HandlerResult {
        let rows = try session.rows(
            """
            SELECT id, pattern, pattern_kind, case_sensitive, priority, is_active, source, notes, created_at, updated_at
              FROM recipient_match_patterns WHERE recipient_id = ? ORDER BY priority ASC, id ASC
            """, [recipient.sqlValue])
        let items = try rows.map { row -> JSONValue in
            .object([
                "id": .int(try row.integerId("id")), "pattern": .string(try row.text("pattern")),
                "pattern_kind": .string(try row.text("pattern_kind")),
                "case_sensitive": .bool(try row.bool("case_sensitive")), "priority": .int(Int(try row.int64("priority"))),
                "is_active": .bool(try row.bool("is_active")), "source": .string(try row.text("source")),
                "notes": try row.optionalText("notes").map(JSONValue.string) ?? .null,
                "created_at": .string(try row.instant("created_at").text),
                "updated_at": .string(try row.instant("updated_at").text),
            ])
        }
        return HandlerResult(data: .object(["items": .array(items), "total": .int(items.count)]))
    }

    /// `createPattern`: 201 with the new id.
    static func create(_ session: BackendSession, _ recipient: RecipientID, _ body: JSObject) throws -> HandlerResult {
        let pattern = body["pattern"]?.stringValue ?? ""
        let kind = body["pattern_kind"]?.stringValue ?? RecipientPatternKind.literalPrefix
        let caseSensitive = body["case_sensitive"] == .bool(true)
        try validate(pattern: pattern, kind: kind, caseSensitive: caseSensitive)
        var priority = SQLValue.integer(100)
        if case .number(let number)? = body["priority"] { priority = .integer(Int64(number)) }
        guard
            let row = try session.row(
                """
                INSERT INTO recipient_match_patterns (recipient_id, pattern, pattern_kind, case_sensitive, priority,
                  source, notes) VALUES (?, ?, ?, ?, ?, 'user', ?) RETURNING id
                """,
                [
                    recipient.sqlValue, .text(pattern), .text(kind), .integer(caseSensitive ? 1 : 0), priority,
                    body["notes"]?.stringValue.map(SQLValue.text) ?? .null,
                ])
        else { throw SQLRowDecodingError(column: "id", problem: "recipient pattern insert returned no row") }
        return HandlerResult(status: 201, data: .object(["id": .int(try row.integerId("id"))]))
    }

    /// `updatePattern`: a change to the definition is validated merged with the stored row.
    static func update(_ session: BackendSession, _ patternId: RecipientPatternID, _ body: JSObject) throws {
        if body.has("pattern") || body.has("pattern_kind") || body.has("case_sensitive") {
            guard
                let stored = try session.row(
                    "SELECT pattern, pattern_kind, case_sensitive FROM recipient_match_patterns WHERE id = ?",
                    [patternId.sqlValue])
            else { throw BackendHTTPError.notFound("Pattern \(patternId.rawValue) not found") }
            var caseSensitive = try stored.bool("case_sensitive")
            if case .bool(let flag)? = body["case_sensitive"] { caseSensitive = flag }
            try validate(
                pattern: body["pattern"]?.stringValue ?? (try stored.text("pattern")),
                kind: body["pattern_kind"]?.stringValue ?? (try stored.text("pattern_kind")), caseSensitive: caseSensitive)
        }
        var changes: [(String, SQLValue)] = []
        for column in ["pattern", "pattern_kind", "case_sensitive", "priority", "is_active", "notes"] {
            if let value = body[column] { changes.append((column, RecipientsArea.sqlValue(value))) }
        }
        if changes.isEmpty { return }
        _ = try session.rows(
            "UPDATE recipient_match_patterns SET \(changes.map { "\($0.0) = ?" }.joined(separator: ", ")), updated_at = now() WHERE id = ?",
            changes.map(\.1) + [patternId.sqlValue])
    }
}
