import Foundation
import VisionNativeCore

/// `parserConfigRoutes.ts` as `routes/importRoutes.ts` registers it for the transaction
/// kind: the saved-parser-config CRUD over `customParserConfigRepository`
/// (`custom_parser_configs`). The portfolio kind (P18) registers the same handlers on
/// the portfolio router and shares `normalizeParserName`, the shared
/// `parserBodySchemas` and the `(name, kind)` unique conflict.
enum ImportParsersArea {
    /// `COLUMNS` of `customParserConfigRepository.ts`, in its order.
    static let columns = "id, name, kind, config_json, created_at, updated_at"

    /// `normalizeCsvEncoding`'s accepted encodings, by their normalized name.
    static let utf8Encodings = ["", "utf-8", "utf8"]
    static let latin1Encodings = ["latin1", "latin-1", "iso-8859-1"]
    static let windowsEncodings = ["windows-1252"]
    static let csvNumberFormats = ["auto", "decimal_dot", "decimal_comma"]
    /// The SQLSTATE of a unique-constraint violation, `isParserNameConflict`'s `code === "23505"`.
    static let uniqueViolationCodes = ["23505"]
    /// The table whose (name, kind) unique index the conflict is.
    static let parserConfigTable = ["custom_parser_configs"]

    // MARK: - Body parsing

    /// The body as `req.body ?? {}` sees it: nil without a body, else strict JSON.
    static func bodyObject(_ request: InProcessRequest) throws -> JSObject {
        guard let body = try RequestBody.parseJavaScript(request.body) else { return JSObject() }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation("Invalid input: expected object, received \(body.zodTypeName)")
        }
        return object
    }

    /// `parseInput`'s report: the messages joined with `"; "`.
    static func validation(_ issues: [String]) -> BackendHTTPError {
        BackendHTTPError.validation(issues.joined(separator: "; "))
    }

    /// `normalizeParserName`: trimmed text, or one `ValidationError`.
    static func normalizeName(_ value: JSValue?) throws -> String? {
        guard case .string(let text)? = value else { return nil }
        let trimmed = JavaScriptWhitespace.trim(text)
        guard !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// `normalizeCsvEncoding`: the accepted encodings and their aliases. The guard's
    /// message becomes one issue of the enclosing parse, so other fields' issues keep it.
    static func normalizeEncoding(_ value: JSValue, issues: inout [String]) -> String {
        guard case .string(let raw) = value else {
            issues.append("Unsupported CSV encoding")
            return "utf-8"
        }
        let encoding = JavaScriptWhitespace.trim(raw.lowercased())
        if utf8Encodings.contains(encoding) { return "utf-8" }
        if latin1Encodings.contains(encoding) { return "latin1" }
        if windowsEncodings.contains(encoding) { return "windows-1252" }
        issues.append("Unsupported CSV encoding \"\(raw)\"")
        return "utf-8"
    }

    /// `String(value)` over a JSValue, for `parseInt(String(value), 10)`.
    static func javaScriptText(_ value: JSValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return SQLArguments.javaScriptText(number)
        case .string(let text): return text
        case .array(let items):
            return "[" + items.map { javaScriptText($0) }.joined(separator: ",") + "]"
        case .object(let object):
            return "{" + object.entries.map { "\($0.0):" + javaScriptText($0.1) }
                .joined(separator: ",") + "}"
        }
    }

    /// The required columns of `parserConfigSchema`: `config.<key> is required`.
    static func requiredColumn(_ object: JSObject, _ key: String) -> (String, Bool) {
        guard case .string(let text)? = object[key] else { return ("", false) }
        let trimmed = JavaScriptWhitespace.trim(text)
        return trimmed.isEmpty ? ("", false) : (trimmed, true)
    }

    /// `parserConfigSchema` (`normalizeParserConfig`): a strip-mode zod object, its
    /// leaves in shape order, each with the normalised default. The first issue's
    /// "Invalid option" wording for `number_format` is zod's enum message.
    static func normalizeConfig(_ value: JSValue, issues: inout [String]) throws -> JSObject? {
        guard case .object(let input) = value else {
            issues.append("Missing or invalid \"config\"")
            return nil
        }
        var output = JSObject()
        for key in ["dateColumn", "recipientColumn", "amountColumn"] {
            let (trimmed, ok) = requiredColumn(input, key)
            if ok {
                output[key] = .string(trimmed)
            } else {
                issues.append("config.\(key) is required")
            }
        }
        // memoColumn: a string trimmed, anything else (and an absent key) the empty string.
        if case .string(let memo)? = input["memoColumn"] {
            output["memoColumn"] = .string(JavaScriptWhitespace.trim(memo))
        } else {
            output["memoColumn"] = .string("")
        }
        // dateFormat: a non-empty string, else %Y-%m-%d.
        if case .string(let format)? = input["dateFormat"], !JavaScriptWhitespace.trim(format).isEmpty {
            output["dateFormat"] = .string(JavaScriptWhitespace.trim(format))
        } else {
            output["dateFormat"] = .string("%Y-%m-%d")
        }
        // separator: any non-empty string, else a comma.
        if case .string(let separator)? = input["separator"], !separator.isEmpty {
            output["separator"] = .string(separator)
        } else {
            output["separator"] = .string(",")
        }
        // encoding: absent/"" normalize to utf-8 inside normalizeCsvEncoding.
        let encoding: String
        switch input["encoding"] {
        case .none, .null:
            encoding = "utf-8"
        case .some(let present):
            encoding = normalizeEncoding(present, issues: &issues)
        }
        output["encoding"] = .string(encoding)
        // number_format: the enum, with zod's message for anything else.
        switch input["number_format"] {
        case .none, .null:
            output["number_format"] = .string("auto")
        case .some(let present):
            if case .string(let choice) = present, csvNumberFormats.contains(choice) {
                output["number_format"] = .string(choice)
            } else {
                issues.append(
                    "Invalid option: expected one of \"auto\"|\"decimal_dot\"|\"decimal_comma\"")
                output["number_format"] = .string("auto")
            }
        }
        // skipRows: parseInt(String(value), 10), kept when positive.
        let skipRows: Double
        if case .some(let present)? = input["skipRows"] {
            skipRows = BankImportText.parseInt(javaScriptText(present))
        } else {
            skipRows = .nan
        }
        output["skipRows"] =
            skipRows.isFinite && skipRows > 0 ? JSValue.int(Int(skipRows)) : JSValue.int(0)
        return output
    }

    /// `parseInput(bodySchemas.create, ...)`: both fields required, name first.
    static func createBody(_ request: InProcessRequest) throws -> (name: String, config: JSObject) {
        let object = try bodyObject(request)
        var issues: [String] = []
        var name: String?
        if let trimmed = try normalizeName(object["name"]) {
            name = trimmed
        } else {
            issues.append("Missing or invalid \"name\"")
        }
        let config = try normalizeConfig(object["config"] ?? .null, issues: &issues)
        guard issues.isEmpty, let name, let config else { throw validation(issues) }
        return (name: name, config: config)
    }

    /// `parseInput(bodySchemas.update, ...)`: an absent field stays unchanged.
    static func updateBody(_ request: InProcessRequest) throws -> (name: String?, config: JSObject?) {
        let object = try bodyObject(request)
        var issues: [String] = []
        var name: String?
        if let rawName = object["name"] {
            if let trimmed = try normalizeName(rawName) {
                name = trimmed
            } else {
                issues.append("Missing or invalid \"name\"")
            }
        }
        var config: JSObject?
        if let rawConfig = object["config"] {
            config = try normalizeConfig(rawConfig, issues: &issues)
        }
        if !issues.isEmpty { throw validation(issues) }
        return (name, config)
    }

    // MARK: - Rows

    /// `mapRow`: the stored jsonb echoed as `JSON.parse` reads it.
    static func parserJSON(_ row: SQLRow) throws -> [String: JSONValue] {
        guard let config = JSValue.parse(try row.text("config_json")) else {
            throw SQLRowDecodingError(column: "config_json", problem: "not JSON")
        }
        return [
            "id": .int(try row.integerId("id")),
            "name": .string(try row.text("name")),
            "kind": .string(try row.text("kind")),
            "config": config.envelopeValue,
            "created_at": .string(try row.instant("created_at").text),
            "updated_at": .string(try row.instant("updated_at").text),
        ]
    }

    /// `isParserNameConflict`: the (name, kind) unique violation of this table. The
    /// translated error carries the SQLSTATE and the table; the constraint name is only
    /// resolved when the connection wires the schema resolver in, so the table is the
    /// stable witness (the pkey never conflicts here: the id is the autoincrement's).
    static func writeError(_ error: any Error, name: String?) -> any Error {
        if let databaseError = error as? DatabaseError,
            uniqueViolationCodes.contains(databaseError.code),
            parserConfigTable.contains(databaseError.table ?? "")
        {
            // `conflictMessage(name)`: undefined prints as the literal text in JS.
            let label = name ?? "undefined"
            return BackendHTTPError.conflict("A parser named \"\(label)\" already exists")
        }
        return error
    }

    // MARK: - Handlers

    /// `GET /parsers` (`getAll(kind)`): the rows by name, with the collection shape.
    static func list(_ session: BackendSession) throws -> HandlerResult {
        let rows = try session.rows(
            "SELECT \(columns) FROM custom_parser_configs WHERE kind = ? ORDER BY name", [
                .text("transaction"),
            ])
        let items = try rows.map { row -> JSONValue in .object(try parserJSON(row)) }
        return HandlerResult(
            data: .object(["items": .array(items), "total": .int(items.count)]))
    }

    /// `POST /parsers` (`create`): 201 with the new row.
    static func create(_ session: BackendSession, _ body: (name: String, config: JSObject)) throws
        -> HandlerResult
    {
        do {
            let row = try session.row(
                """
                INSERT INTO custom_parser_configs (name, kind, config_json)
                VALUES (?, ?, vision_jsonb(?))
                RETURNING \(columns)
                """,
                [.text(body.name), .text("transaction"), .text(JSValue.object(body.config).jsonText)])
            guard let row else { throw SQLRowDecodingError(column: "id", problem: "insert returned no row") }
            return HandlerResult(
                status: 201, data: .object(try parserJSON(row)))
        } catch let error {
            throw writeError(error, name: body.name)
        }
    }

    /// `PATCH /parsers/:id` (`update`): the row, a 404 when it does not exist. An absent
    /// field stays unchanged; an empty PATCH still bumps nothing but re-reads the row.
    static func update(_ session: BackendSession, id: Int, _ body: (name: String?, config: JSObject?)) throws
        -> HandlerResult
    {
        if body.name == nil && body.config == nil {
            guard let row = try byId(session, id) else {
                throw BackendHTTPError.notFound("Parser config not found")
            }
            return HandlerResult(data: .object(try parserJSON(row)))
        }
        var arguments: [SQLValue] = []
        var sets: [String] = []
        if let name = body.name {
            sets.append("name = ?")
            arguments.append(.text(name))
        }
        if let config = body.config {
            sets.append("config_json = vision_jsonb(?)")
            arguments.append(.text(JSValue.object(config).jsonText))
        }
        arguments.append(.integer(Int64(id)))
        do {
            let written = try session.row(
                "UPDATE custom_parser_configs SET \(sets.joined(separator: ", ")) WHERE id = ? RETURNING id",
                arguments)
            guard written != nil else { throw BackendHTTPError.notFound("Parser config not found") }
            // RETURNING shows the row as the UPDATE left it, before the AFTER UPDATE
            // trigger stamped `updated_at = now()`; the type re-reads the row.
            guard let row = try byId(session, id) else {
                throw BackendHTTPError.notFound("Parser config not found")
            }
            return HandlerResult(data: .object(try parserJSON(row)))
        } catch let error {
            throw writeError(error, name: body.name)
        }
    }

    static func byId(_ session: BackendSession, _ id: Int) throws -> SQLRow? {
        try session.row("SELECT \(columns) FROM custom_parser_configs WHERE id = ?", [
            .integer(Int64(id)),
        ])
    }

    /// `DELETE /parsers/:id` (`delete`): 204, or the 404.
    static func delete(_ session: BackendSession, id: Int) throws -> HandlerResult {
        let deleted = try session.row(
            "DELETE FROM custom_parser_configs WHERE id = ? RETURNING id", [.integer(Int64(id))])
        guard deleted != nil else { throw BackendHTTPError.notFound("Parser config not found") }
        return HandlerResult.noContent
    }

    // MARK: - Registration

    /// `validateId` over the `:id` path segment, as `validateIdParam` runs it at the edge.
    static func pathId(_ request: InProcessRequest) throws -> Int {
        guard let raw = request.pathParameters["id"], let id = TransactionsArea.validId(.string(raw))
        else { throw BackendHTTPError.validation("id must be a positive integer") }
        return id
    }

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetCustomParsers.self) { _ in
            try await database.run { session in try ImportParsersArea.list(session) }
        }
        backend.serve(OpenAPIOperations.CreateCustomParser.self) { request in
            let body = try ImportParsersArea.createBody(request)
            return try await database.run { session in try ImportParsersArea.create(session, body) }
        }
        backend.serve(OpenAPIOperations.UpdateCustomParser.self) { request in
            let id = try ImportParsersArea.pathId(request)
            let body = try ImportParsersArea.updateBody(request)
            return try await database.run { session in
                try ImportParsersArea.update(session, id: id, body)
            }
        }
        backend.serve(OpenAPIOperations.DeleteCustomParser.self) { request in
            let id = try ImportParsersArea.pathId(request)
            return try await database.run { session in
                try ImportParsersArea.delete(session, id: id)
            }
        }
    }
}
