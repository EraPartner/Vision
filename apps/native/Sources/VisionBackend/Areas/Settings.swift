import Foundation
import VisionNativeCore

/// `routes/settings.ts` and `repositories/settingsRepository.ts` for the operations the app
/// calls: the list, one key, and the conditional single and bulk saves. `DELETE /:key` is not
/// in the generated client, so it stays on Bun.
///
/// Values are handled as JavaScript holds them (`JSValue`): a write stores
/// `vision_jsonb(JSON.stringify(value))` and the optimistic-concurrency baseline compares
/// canonical jsonb text, so the text must be JavaScript's. Bun keeps no cache over
/// `user_settings` that a write clears (ADR-270 decision 4).
enum SettingsArea {
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetSettings.self) { request in
            let withBaselines = try SettingsArea.listQuery(request.queryItems.filter { $0.name == "withBaselines" })
            return try await database.run { session in
                HandlerResult(data: try SettingsArea.list(session, withBaselines: withBaselines).envelopeValue)
            }
        }
        backend.serve(OpenAPIOperations.GetSetting.self) { request in
            let key = request.pathParameters["key"] ?? ""
            return try await database.run { session in
                HandlerResult(data: try SettingsArea.get(session, key: key).envelopeValue)
            }
        }
        backend.serve(OpenAPIOperations.SaveSetting.self) { request in
            let key = request.pathParameters["key"] ?? ""
            try SettingsArea.checkWriteKey(key)
            let (value, expected) = try SettingsArea.putBody(try RequestBody.parseJavaScript(request.body))
            let validated = try SettingsArea.validate(key: key, value: value)
            return try await database.run { session -> HandlerResult in
                let saved = try SettingsArea.replace(session, key: key, value: validated, expected: expected)
                return HandlerResult(data: saved.envelopeValue)
            }
        }
        backend.serve(OpenAPIOperations.SaveSettings.self) { request in
            let (settings, expected) = try SettingsArea.bulkBody(try RequestBody.parseJavaScript(request.body))
            var validated = JSObject()
            for (key, value) in settings.entries { validated[key] = try SettingsArea.validate(key: key, value: value) }
            let entries = validated
            try await database.run { session in
                try SettingsArea.replaceMany(session, entries, expected: expected)
            }
            return HandlerResult(data: .object(["saved": .int(entries.count)]))
        }
    }

    /// The baseline a conditional write expects: `{ exists: false }` or `{ exists: true, value }`.
    struct Expectation: Sendable {
        let value: JSValue?

        var json: JSValue {
            guard let value else { return .object(JSObject([("exists", .bool(false))])) }
            return .object(JSObject([("exists", .bool(true)), ("value", value)]))
        }

        /// `isSettingExpectation`: a plain object whose keys are only `exists` (a boolean) and
        /// `value`, with `value` present exactly when `exists` is true.
        init?(_ raw: JSValue?) {
            guard let object = raw?.objectValue, case .bool(let exists)? = object["exists"],
                object.keys.allSatisfy({ $0 == "exists" || $0 == "value" }), object.has("value") == exists
            else { return nil }
            value = exists ? object["value"] : nil
        }

        init(stored value: JSValue?) { self.value = value }

        static let absent = Expectation(stored: nil)
    }

    // MARK: - Request validation

    /// `listQuerySchema`: an absent `withBaselines`, or exactly "true" or "false" (a repeated
    /// parameter is an array, which fails too).
    static func listQuery(_ items: [URLQueryItem]) throws -> Bool {
        guard !items.isEmpty else { return false }
        let value: String? = items.count == 1 ? items[0].value ?? "" : nil
        guard value == "true" || value == "false" else {
            throw BackendHTTPError.validation("withBaselines must be true or false")
        }
        return value == "true"
    }

    private static let forbiddenKeys: Set<String> = ["__proto__", "constructor", "prototype"]

    /// `assertSettingKeyLength`: the forbidden prototype keys, then 100 UTF-16 units at most.
    static func checkKeyShape(_ key: String, naming: Bool) throws {
        if forbiddenKeys.contains(key) { throw BackendHTTPError.validation("Setting key '\(key)' is not allowed") }
        if key.utf16.count > 100 {
            throw BackendHTTPError.validation(
                naming ? "Setting key '\(key)' too long (max 100 chars)" : "Setting key too long (max 100 chars)")
        }
    }

    /// `assertKnownSettingKey`.
    static func checkKnown(_ key: String) throws {
        guard SettingSchemas.knownKeys.contains(key) else {
            throw BackendHTTPError.validation(
                "Unknown setting key '\(key)'. Known keys: \(SettingSchemas.knownKeysText)")
        }
    }

    /// `writeKeyParamsSchema`.
    static func checkWriteKey(_ key: String) throws {
        try checkKeyShape(key, naming: false)
        try checkKnown(key)
    }

    /// `putSettingBodySchema`: a body that is not an object reads as `{}`; both messages are
    /// reported, value first.
    static func putBody(_ body: JSValue?) throws -> (JSValue, Expectation) {
        let object = body?.objectValue ?? JSObject()
        var messages: [String] = []
        let value = object["value"]
        if value == nil { messages.append("Missing \"value\" in request body") }
        let expected = Expectation(object["expected"])
        if expected == nil { messages.append("Missing or invalid expected setting baseline") }
        guard let value, let expected else { throw BackendHTTPError.validation(messages.joined(separator: "; ")) }
        return (value, expected)
    }

    /// `bulkSettingsBodySchema`: the `settings` guard (an object of known keys), the `expected`
    /// guard (an object), and only when both pass, one valid baseline per settings key.
    static func bulkBody(_ body: JSValue?) throws -> (JSObject, [String: Expectation]) {
        let object = body?.objectValue ?? JSObject()
        var messages: [String] = []
        var settings: JSObject?
        if let candidate = object["settings"]?.objectValue {
            do {
                for key in candidate.keys {
                    try checkKeyShape(key, naming: true)
                    try checkKnown(key)
                }
                settings = candidate
            } catch let error as BackendHTTPError {
                messages.append(error.message)
            }
        } else {
            messages.append("Body must be a JSON object of key→value pairs")
        }
        let expectedObject = object["expected"]?.objectValue
        if expectedObject == nil { messages.append("Missing expected settings baselines") }
        guard let settings, let expectedObject else {
            throw BackendHTTPError.validation(messages.joined(separator: "; "))
        }
        var expected: [String: Expectation] = [:]
        for key in settings.keys {
            guard let baseline = Expectation(expectedObject[key]) else {
                throw BackendHTTPError.validation("Missing or invalid expected setting baseline")
            }
            expected[key] = baseline
        }
        return (settings, expected)
    }

    /// `validateSettingValue`: the schema's output for a schema'd key, else the value as sent.
    static func validate(key: String, value: JSValue) throws -> JSValue {
        guard let schema = SettingSchemas.schemas[key] else { return value }
        switch schema.parse(value) {
        case .success(let output): return output ?? value
        case .failure(let failure): throw BackendHTTPError.validation("Invalid \(key): \(failure.message)")
        }
    }

    // MARK: - Reads

    /// A stored jsonb text as `JSON.parse` reads it.
    static func stored(_ row: SQLRow) throws -> JSValue {
        let text = try row.text("value")
        guard let value = JSValue.parse(text) else {
            throw SQLRowDecodingError(column: "value", problem: "not JSON")
        }
        return value
    }

    /// `reviveLegacyJsonString`: a string value of a key that is not string-valued is parsed
    /// as JSON when it parses.
    static func revive(key: String, _ value: JSValue) -> JSValue {
        guard case .string(let text) = value, key != "cost_basis_method" else { return value }
        return JSValue.parse(text) ?? value
    }

    /// `GET /api/settings`: every row by key, with the stored baselines on request.
    static func list(_ session: BackendSession, withBaselines: Bool) throws -> JSValue {
        let rows = try session.rows("SELECT key, value FROM user_settings ORDER BY key")
        var settings = JSObject()
        var expected = JSObject()
        for row in rows {
            let key = try row.text("key")
            let value = try stored(row)
            settings[key] = revive(key: key, value)
            expected[key] = Expectation(stored: value).json
        }
        guard withBaselines else { return .object(settings) }
        return .object(JSObject([("settings", .object(settings)), ("expected", .object(expected))]))
    }

    /// `GET /api/settings/:key`: the stored value, else the key's default, else a 404.
    static func get(_ session: BackendSession, key: String) throws -> JSValue {
        if let row = try session.row("SELECT value FROM user_settings WHERE key = ?", [.text(key)]) {
            let value = try stored(row)
            return .object(
                JSObject([
                    ("key", .string(key)), ("value", revive(key: key, value)),
                    ("expected", Expectation(stored: value).json),
                ]))
        }
        guard let fallback = SettingSchemas.defaults[key] else {
            throw BackendHTTPError.notFound("Setting '\(key)' not found")
        }
        return .object(
            JSObject([
                ("key", .string(key)), ("value", fallback), ("expected", Expectation.absent.json),
            ]))
    }

    // MARK: - Writes

    static let conflictMessage = "Settings changed. Reload before saving again."

    /// `replace`: an update guarded by the baseline's canonical jsonb text, or an insert that
    /// does nothing when the key exists; no row written is a 409.
    static func replace(_ session: BackendSession, key: String, value: JSValue, expected: Expectation) throws -> JSValue {
        let written: SQLRow?
        if let baseline = expected.value {
            written = try session.row(
                """
                UPDATE user_settings SET value = vision_jsonb(?), updated_at = NOW() \
                WHERE key = ? AND value = vision_jsonb(?) RETURNING key
                """,
                [.text(value.jsonText), .text(key), .text(baseline.jsonText)])
        } else {
            written = try session.row(
                """
                INSERT INTO user_settings (key, value, updated_at) VALUES (?, vision_jsonb(?), NOW()) \
                ON CONFLICT (key) DO NOTHING RETURNING key
                """,
                [.text(key), .text(value.jsonText)])
        }
        guard written != nil else { throw BackendHTTPError.conflict(conflictMessage) }
        return .object(
            JSObject([
                ("key", .string(key)), ("value", value), ("expected", Expectation(stored: value).json),
            ]))
    }

    /// `replaceMany`: every key in sorted order in one transaction, all or nothing.
    static func replaceMany(_ session: BackendSession, _ settings: JSObject, expected: [String: Expectation]) throws {
        try session.transaction {
            for key in settings.keys.sorted() {
                guard let value = settings[key], let baseline = expected[key] else {
                    throw SQLRowDecodingError(column: key, problem: "missing expected baseline")
                }
                _ = try replace(session, key: key, value: value, expected: baseline)
            }
        }
    }
}
