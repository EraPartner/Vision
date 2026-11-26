import CryptoKit
import Foundation
import VisionNativeCore

/// `routes/importRoutes.ts`'s upload half: the multipart CSV endpoints the client writes by
/// hand — `importCsv`, `importCsvCustom`, the SSE `importCsvStream`, and the simple
/// `importRecipients` / `importCategories` uploads. The batch, review and commit routes live
/// in the other `Import*` areas; the parses in `BankAdapters` and `CSVParse`.
enum ImportUploadsArea {
    /// `BankImportText`, the shared adapter text helpers of `BankImportShared.swift`.
    private typealias Text = BankImportText

    // MARK: - The upload form

    /// `multer`'s `req.file` for `csvUpload.single("file")`.
    struct UploadedFile {
        let originalName: String
        let mimetype: String
        let bytes: [UInt8]
        var size: Int { bytes.count }
    }

    /// The parsed form: the file part and the text fields (`req.body`) as a `JSObject`, a
    /// repeated field arriving as an array exactly as multer leaves it.
    static func form(_ request: InProcessRequest) -> (file: UploadedFile?, fields: JSObject) {
        let parts = MultipartParts.parse(headers: request.headers, body: request.body) ?? []
        var file: UploadedFile? = nil
        var fields = JSObject()
        for part in parts {
            if let filename = part.filename {
                // `single("file")`: the first file part named `file` is the upload; the
                // corpus never sends another file field.
                if part.name == "file", file == nil {  // lint:allow string-literal-compare the upload form field name, as multer reads it
                    file = UploadedFile(
                        originalName: filename, mimetype: part.contentType,
                        bytes: [UInt8](part.data))
                }
            } else {
                let value = JSValue.string(String(decoding: part.data, as: UTF8.self))
                if let existing = fields[part.name] {
                    if case .array(var items) = existing {
                        items.append(value)
                        fields[part.name] = .array(items)
                    } else {
                        fields[part.name] = .array([existing, value])
                    }
                } else {
                    fields[part.name] = value
                }
            }
        }
        return (file, fields)
    }

    /// `isLikelyCsvFile`: the `csvUpload` fileFilter reads the part's own name and type.
    static func isLikelyCsvFile(name: String, contentType: String) -> Bool {
        let original = JavaScriptCase.lowercased(name)
        let mime = JavaScriptCase.lowercased(contentType)
        let hasCsvExtension = original.hasSuffix(".csv")
        let hasLikelyCsvMimeType = mime.contains("csv")  // lint:allow string-literal-compare the fileFilter's MIME key, as csvUpload reads it
            || mime.contains("text/plain")  // lint:allow string-literal-compare the fileFilter's MIME key, as csvUpload reads it
            || mime.contains("application/vnd.ms-excel")  // lint:allow string-literal-compare the fileFilter's MIME key, as csvUpload reads it
            || mime == "application/octet-stream"  // lint:allow string-literal-compare the fileFilter's MIME key, as csvUpload reads it
            || mime.isEmpty
        return hasCsvExtension && hasLikelyCsvMimeType
    }

    /// `csvUpload.single("file")`: the fileFilter runs while multer streams the part, so
    /// "File must be a CSV" precedes every route check.
    static func csvUpload(_ file: UploadedFile?) throws -> UploadedFile? {
        guard let file else { return nil }
        guard isLikelyCsvFile(name: file.originalName, contentType: file.mimetype) else {
            throw BackendHTTPError.validation("File must be a CSV")
        }
        return file
    }

    /// The routes' "No file uploaded" message; the stream route's is its own.
    static func requireFile(_ file: UploadedFile?, stream: Bool) throws -> UploadedFile {
        guard let file else {
            throw BackendHTTPError.validation(
                stream ? "No file uploaded."
                    : "No file uploaded. Send a CSV file as multipart form-data with field name \"file\".")
        }
        return file
    }

    /// `bankNameBodySchema`: one required text field; anything but a non-empty string
    /// (absent, empty or a repeated field's array) is the one message.
    static func bankName(_ fields: JSObject, _ message: String) throws -> String {
        guard case .string(let name)? = fields["bank_name"], !name.isEmpty else {
            throw BackendHTTPError.validation(message)
        }
        return name
    }

    /// `multipartTextField`: a falsy value normalizes to undefined, a truthy non-string
    /// (a repeated field) is a clean 400 carrying the field's name.
    static func textField(_ fields: JSObject, _ name: String, _ issues: inout [String]) -> String? {
        guard let value = fields[name] else { return nil }
        if case .string(let text) = value { return text.isEmpty ? nil : text }
        if value.isFalsy { return nil }
        issues.append("\(name) must be a string")
        return nil
    }

    /// `csvImportOptionsInput`: the `separator` and `encoding` multipart fields, in that
    /// issue order.
    static func csvImportOptions(_ fields: JSObject) throws -> (separator: String, encoding: String) {
        var issues: [String] = []
        // separator: `looseText(value || ",")`, one UTF-16 unit.
        let separator: String
        if let value = fields["separator"], !value.isFalsy {
            separator = AccountsArea.looseText(value)
        } else {
            separator = ","
        }
        if separator.utf16.count != 1 {
            issues.append("separator must be a single character")
        }
        // encoding: `csvEncodingField`, whose normalized value the readers default.
        var encoding = "utf-8"
        if let value = fields["encoding"] {
            encoding = ImportParsersArea.normalizeEncoding(value, issues: &issues)
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return (separator, encoding)
    }

    // MARK: - The custom setup (`POST /csv/custom`)

    struct CustomSetup {
        let adapterName: String
        let config: CustomBankParserConfig
    }

    /// `customCsvImportSchema`: the flattened multipart fields into `{ adapterName,
    /// customConfig }`, the issues in the schema's field order. Any field issue answers
    /// alone; the superRefine's missing-parameters message runs only on an otherwise valid
    /// parse.
    static func buildCustomCsvConfig(_ fields: JSObject) throws -> CustomSetup {
        var issues: [String] = []
        let bankName = textField(fields, "bank_name", &issues)
        let dateFormat = textField(fields, "date_format", &issues)
        let dateColumn = textField(fields, "date_column", &issues)
        let recipientColumn = textField(fields, "recipient_column", &issues)
        let amountColumn = textField(fields, "amount_column", &issues)
        let memoColumn = textField(fields, "memo_column", &issues)
        var encoding: String? = nil
        if let value = fields["encoding"] {
            encoding = ImportParsersArea.normalizeEncoding(value, issues: &issues)
        }
        var numberFormat: String? = nil
        if let value = fields["number_format"] {
            if case .string(let format) = value,
                format == "auto" || format == "decimal_dot" || format == "decimal_comma" {  // lint:allow string-literal-compare CSV_NUMBER_FORMATS, the enum the schema accepts
                numberFormat = format
            } else {
                issues.append("Invalid option: expected one of \"auto\"|\"decimal_dot\"|\"decimal_comma\"")
            }
        }
        // separator: `value != null ? looseText(value) : ""`, an issue only when the
        // result is truthy and not one UTF-16 unit.
        var separator = ","
        if let value = fields["separator"], !value.isNull {
            let text = AccountsArea.looseText(value)
            if text.isEmpty {
                separator = ","
            } else if text.utf16.count != 1 {
                issues.append("separator must be a single character")
            } else {
                separator = text
            }
        }
        // skip_rows: `nanToZero(parseInt(String(value), 10))`; only a negative fails.
        var skipRows = 0
        if let value = fields["skip_rows"] {
            let parsed = JavaScriptInteger.parse(value.javaScriptString) ?? 0
            let zeroed = parsed.isNaN ? 0 : parsed
            skipRows = Int(zeroed)
        }
        if skipRows < 0 {
            issues.append("skip_rows must be zero or a positive integer")
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        guard let bankName, let dateFormat, let dateColumn, let recipientColumn, let amountColumn else {
            throw BackendHTTPError.validation(
                "Missing required parameters: bank_name, date_format, date_column, recipient_column, amount_column"
            )
        }
        var config = CustomBankParserConfig(
            columns: CustomBankParserConfig.Columns(
                date: JavaScriptWhitespace.trim(dateColumn),
                recipient: JavaScriptWhitespace.trim(recipientColumn),
                amount: JavaScriptWhitespace.trim(amountColumn),
                memo: memoColumn.map { JavaScriptWhitespace.trim($0) } ?? ""))
        config.bankName = JavaScriptWhitespace.trim(bankName)
        config.dateFormat = JavaScriptWhitespace.trim(dateFormat)
        config.encoding = encoding ?? "utf-8"
        config.numberFormat = .string(numberFormat ?? "auto")
        config.separator = separator
        config.skipRows = skipRows
        return CustomSetup(adapterName: bankName, config: config)
    }

    /// `runImportPipeline`'s flat `Error`s the route inspects.
    struct PipelineFailure: Error { let text: String }

    /// The two CSV routes' catch of "No configuration found" around the pipeline.
    static func pipelineAnswer(_ body: () throws -> HandlerResult) throws -> HandlerResult {
        do {
            return try body()
        } catch let error as PipelineFailure {
            if error.text.contains("No configuration found") {
                throw BackendHTTPError.validation("Invalid bank configuration: \(error.text)")
            }
            throw error
        }
    }

    /// `buildImportResult`'s tail, for the completion answer.
    static func pipelineResult(_ result: PipelineResult) throws -> HandlerResult {
        if result.requiresReview {
            let answer: [String: JSONValue] = [
                "batch_id": .int(result.batchId),
                "requires_review": .bool(true),
                "match_source_counts": matchSourceCountsJSON(result.matchSourceCounts),
            ]
            return HandlerResult(status: 202, data: .object(answer))
        }
        let answer: [String: JSONValue] = [
            "total": .int(result.total),
            "imported": .int(result.imported ?? 0),
            "duplicates": .int(result.duplicates ?? 0),
            "errors": .int(result.errors ?? 0),
            "batch_id": .int(result.batchId),
            "auto_linked_count": .int(result.autoLinkedCount ?? 0),
            "status": .string((result.errors ?? 0) > 0 ? "completed_with_errors" : "completed"),
            "error_message": .null,
            "links": .array([]),
        ]
        return HandlerResult(status: 201, data: .object(answer))
    }

    /// `matchSourceCounts` for the envelope.
    static func matchSourceCountsJSON(_ counts: MatchSourceCounts) -> JSONValue {
        let answer: [String: JSONValue] = [
            "pattern": .int(counts.pattern),
            "exact": .int(counts.exact),
            "fuzzy": .int(counts.fuzzy),
            "new": .int(counts.new),
        ]
        return .object(answer)
    }

    /// `match_source_counts` for the raw SSE frames, where key order is the answer.
    static func matchSourceCountsJSValue(_ counts: MatchSourceCounts) -> JSValue {
        var fields = JSObject()
        fields["pattern"] = .number(Double(counts.pattern))
        fields["exact"] = .number(Double(counts.exact))
        fields["fuzzy"] = .number(Double(counts.fuzzy))
        fields["new"] = .number(Double(counts.new))
        return .object(fields)
    }

    // MARK: - The simple imports

    struct SimpleImportResults: Sendable {
        var totalProcessed = 0
        var imported = 0
        var skipped = 0
        var errors = 0
        var bankAccountErrors = 0
    }

    /// `POST /recipients`: the file, the options, then `importRecipientsCSV`; the route
    /// answers `{...result, status}` with 201.
    static func recipients(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let form = ImportUploadsArea.form(request)
        let file = try requireFile(try csvUpload(form.file), stream: false)
        let options = try csvImportOptions(form.fields)
        let result = try importRecipientsCSV(
            session, bytes: file.bytes, separator: options.separator, encoding: options.encoding)
        let answer: [String: JSONValue] = [
            "total_processed": .int(result.totalProcessed),
            "imported": .int(result.imported),
            "skipped": .int(result.skipped),
            "errors": .int(result.errors),
            "bank_account_errors": .int(result.bankAccountErrors),
            "status": .string(result.errors > 0 ? "completed_with_errors" : "completed"),
        ]
        return HandlerResult(status: 201, data: .object(answer))
    }

    /// `POST /categories`: the same shape without the bank-account counter.
    static func categories(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let form = ImportUploadsArea.form(request)
        let file = try requireFile(try csvUpload(form.file), stream: false)
        let options = try csvImportOptions(form.fields)
        let result = try importCategoriesCSV(
            session, bytes: file.bytes, separator: options.separator, encoding: options.encoding)
        let answer: [String: JSONValue] = [
            "total_processed": .int(result.totalProcessed),
            "imported": .int(result.imported),
            "skipped": .int(result.skipped),
            "errors": .int(result.errors),
            "status": .string(result.errors > 0 ? "completed_with_errors" : "completed"),
        ]
        return HandlerResult(status: 201, data: .object(answer))
    }

    // MARK: - `POST /csv/stream`

    /// `progressToPercent` (`lib/importProgress.ts`): the banding that maps the phases onto
    /// one 0-100 run.
    static func progressToPercent(_ progress: PipelineProgress) -> (payload: JSValue, percent: Int) {
        let frac = progress.total > 0 ? Double(progress.current) / Double(progress.total) : 0
        let percent: Double
        switch progress.phase {
        case "staging": percent = (frac * 40).rounded()  // lint:allow string-literal-compare the pipeline's phase, as progressToPercent reads it
        case "validating": percent = 40 + (frac * 15).rounded()  // lint:allow string-literal-compare the pipeline's phase, as progressToPercent reads it
        case "matching": percent = 55 + (frac * 15).rounded()  // lint:allow string-literal-compare the pipeline's phase, as progressToPercent reads it
        case "committing": percent = 70 + (frac * 30).rounded()  // lint:allow string-literal-compare the pipeline's phase, as progressToPercent reads it
        default: percent = 100
        }
        var fields = JSObject()
        fields["phase"] = .string(progress.phase)
        fields["current"] = .number(Double(progress.current))
        fields["total"] = .number(Double(progress.total))
        fields["imported"] = .number(Double(progress.imported ?? 0))
        fields["duplicates"] = .number(Double(progress.duplicates ?? 0))
        fields["errors"] = .number(Double(progress.errors ?? 0))
        fields["percent"] = .number(percent)
        return (JSValue.object(fields), Int(percent))
    }

    /// `streamImport`: the SSE stream of one synchronous pipeline run. A validation
    /// failure writes an `error` frame; the SSE headers commit only after multer and the
    /// field checks passed, so those answer as envelopes.
    static func stream(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let form = ImportUploadsArea.form(request)
        let file = try requireFile(try csvUpload(form.file), stream: true)
        let bankName = try bankName(form.fields, "Missing required parameter: bank_name")
        var frames: [(String, JSValue)] = []
        var percent = 0
        let result: PipelineResult
        do {
            result = try runPipeline(
                session, file: file, adapterName: bankName, customConfig: nil,
                filename: file.originalName, size: file.size, onProgress: { progress in
                    let next = progressToPercent(progress)
                    percent = next.percent
                    frames.append(("progress", next.payload))
                })
        } catch let error as BackendHTTPError {
            return errorFrame(error)
        } catch {
            return errorFrame(
                BackendHTTPError(status: 500, code: "INTERNAL_SERVER_ERROR", message: "Import failed"))
        }
        if result.requiresReview {
            // `skipped` is undefined for the transaction pipeline, so it never serialises.
            var reviewFields = JSObject()
            reviewFields["batch_id"] = .number(Double(result.batchId))
            reviewFields["match_source_counts"] = matchSourceCountsJSValue(result.matchSourceCounts)
            reviewFields["percent"] = .number(Double(percent))
            frames.append(("review_required", .object(reviewFields)))
        } else {
            var completeFields = JSObject()
            completeFields["total_processed"] = .number(Double(result.total))
            completeFields["imported"] = .number(Double(result.imported ?? 0))
            completeFields["duplicates"] = .number(Double(result.duplicates ?? 0))
            completeFields["errors"] = .number(Double(result.errors ?? 0))
            completeFields["batch_id"] = .number(Double(result.batchId))
            completeFields["auto_linked_count"] = .number(Double(result.autoLinkedCount ?? 0))
            completeFields["status"] = .string((result.errors ?? 0) > 0 ? "completed_with_errors" : "completed")
            completeFields["percent"] = .number(100)
            frames.append(("complete", .object(completeFields)))
        }
        return HandlerResult.fileAnswer(
            Data(sseText(frames).utf8), headers: ["Content-Type": "text/event-stream"])
    }

    /// `streamImport`'s error frame: a validation failure carries its message; anything
    /// else stays generic.
    static func errorFrame(_ error: BackendHTTPError) -> HandlerResult {
        let expected = error.status == 400 && error.code == "VALIDATION_ERROR"  // lint:allow string-literal-compare the typed ValidationError streamImport checks for
        let detail = expected ? error.message : "Import failed"
        let code = expected ? error.code : "INTERNAL_SERVER_ERROR"
        var fields = JSObject()
        fields["detail"] = .string(detail)
        fields["code"] = .string(code)
        let payload = JSValue.object(fields)
        return HandlerResult.fileAnswer(
            Data(sseText([("error", payload)]).utf8),
            headers: ["Content-Type": "text/event-stream"])
    }

    /// `createSseWriter`: the padding comment, then one `event:`/`data:` block per frame.
    static func sseText(_ frames: [(String, JSValue)]) -> String {
        var text = ":" + String(repeating: " ", count: 2048) + "\n\n"
        for (name, payload) in frames {
            text += "event: \(name)\n"
            text += "data: \(payload.jsonText)\n"
            text += "\n"
        }
        return text
    }

    // MARK: - The pipeline (`services/importPipeline/index.ts`)

    struct PipelineProgress: Sendable {
        var phase: String
        var current: Int
        var total: Int
        var imported: Int?
        var duplicates: Int?
        var errors: Int?
    }

    struct MatchSourceCounts: Sendable {
        var pattern = 0
        var exact = 0
        var fuzzy = 0
        var new = 0
    }

    struct PipelineResult: Sendable {
        var batchId: Int  // lint:allow raw-id an import_batches id inside the pipeline's own result, ADR-252 has no dedicated type
        var total: Int
        var requiresReview: Bool
        var imported: Int?
        var duplicates: Int?
        var errors: Int?
        var matchSourceCounts: MatchSourceCounts
        var autoLinkedCount: Int?
        var validateErrors: Int = 0
    }

    /// `runImportPipeline`: create the batch, prepare it (stage + validate + match), then
    /// auto-commit when every row resolved exactly. The transfer reconcile, the
    /// forecast-cache clear and the materialized-view refresh that follow a commit have no
    /// answer the corpus observes (`ImportCommitArea.commit`'s tail shares the decision).
    static func runPipeline(
        _ session: BackendSession, file: UploadedFile, adapterName: String,
        customConfig: CustomBankParserConfig?, filename: String, size: Int,
        onProgress: ((PipelineProgress) -> Void)?
    ) throws -> PipelineResult {
        let batchId = try createBatch(
            session, adapterName: adapterName, filename: filename, sizeBytes: size,
            customConfig: customConfig)
        do {
            let prepared = try prepareImport(
                session, batchId: batchId, file: file, adapterName: adapterName,
                customConfig: customConfig, onProgress: onProgress)
            if prepared.requiresReview {
                return PipelineResult(
                    batchId: batchId, total: prepared.rowsTotal, requiresReview: true,
                    imported: nil, duplicates: nil, errors: nil,
                    matchSourceCounts: prepared.matchSourceCounts,
                    autoLinkedCount: nil, validateErrors: prepared.validateErrors)
            }
            let committed = try ImportCommitArea.commitBatch(session, batch: batchId)
            _ = try session.row(
                "UPDATE import_batches SET status = 'complete', completed_at = NOW() WHERE id = ? RETURNING id",
                [.integer(Int64(batchId))])
            let totalErrors = prepared.validateErrors + committed.errors
            _ = try session.row(
                "UPDATE import_batches SET rows_error = ? WHERE id = ? RETURNING id",
                [.integer(Int64(totalErrors)), .integer(Int64(batchId))])
            return PipelineResult(
                batchId: batchId, total: prepared.rowsTotal, requiresReview: false,
                imported: committed.imported, duplicates: committed.duplicates,
                errors: totalErrors, matchSourceCounts: prepared.matchSourceCounts,
                autoLinkedCount: committed.autoLinked, validateErrors: prepared.validateErrors)
        } catch let error {
            // The failing batch keeps the pipeline's summary, its message truncated to 2000.
            let summary = String(errorMessage(error).prefix(2000))
            _ = try? session.row(
                "UPDATE import_batches SET status = 'failed', completed_at = NOW(), error_summary = ? " +
                    "WHERE id = ? RETURNING id",
                [.text(summary), .integer(Int64(batchId))])
            throw error
        }
    }

    /// `String((err && err.message) || err)`.
    static func errorMessage(_ error: Error) -> String {
        if let failure = error as? PipelineFailure { return failure.text }
        if let http = error as? BackendHTTPError { return http.message }
        return String(describing: error)
    }

    /// `createBatch` (`stage.ts`): the `import_batches` row in one statement.
    static func createBatch(
        _ session: BackendSession, adapterName: String, filename: String?, sizeBytes: Int?,
        customConfig: CustomBankParserConfig?
    ) throws -> Int {
        let configJSON: String?
        if let customConfig {
            let config = customConfigJSON(customConfig)
            var custom = JSObject()
            custom["bank_name"] = .string(config.bankName)
            custom["date_format"] = .string(config.dateFormat)
            custom["encoding"] = .string(config.encoding)
            custom["number_format"] = .string(config.numberFormat)
            custom["separator"] = .string(config.separator)
            custom["skip_rows"] = .number(Double(config.skipRows))
            var mapping = JSObject()
            mapping["date"] = .string(config.dateColumn)
            mapping["recipient"] = .string(config.recipientColumn)
            mapping["amount"] = .string(config.amountColumn)
            mapping["memo"] = .string(config.memoColumn)
            custom["column_mapping"] = .object(mapping)
            configJSON = JSValue.object(custom).jsonText
        } else {
            configJSON = nil
        }
        let row = try session.row(
            """
            INSERT INTO import_batches (adapter_name, source_filename, source_size_bytes, custom_config,
                                         status, started_at)
            VALUES (?, ?, ?, ?, 'pending', NOW()) RETURNING id
            """,
            [
                .text(adapterName),
                filename.map { SQLValue.text($0) } ?? .null,
                sizeBytes.map { SQLValue.integer(Int64($0)) } ?? .null,
                configJSON.map { SQLValue.text($0) } ?? .null,
            ])
        guard let row else { throw PipelineFailure(text: "import_batches insert returned no row") }
        return Int(try row.int64("id"))
    }

    /// The `custom_config` the route stores (`JSON.stringify(customConfig)` of the schema's
    /// transformed output).
    struct CustomSetupJSON {
        var bankName: String
        var dateFormat: String
        var encoding: String
        var numberFormat: String
        var separator: String
        var skipRows: Int
        var dateColumn: String
        var recipientColumn: String
        var amountColumn: String
        var memoColumn: String
    }

    static func customConfigJSON(_ config: CustomBankParserConfig) -> CustomSetupJSON {
        func text(_ value: String?) -> String { value ?? "" }
        var numberFormat = "auto"
        if case .string(let format)? = config.numberFormat { numberFormat = format }
        return CustomSetupJSON(
            bankName: text(config.bankName), dateFormat: text(config.dateFormat),
            encoding: text(config.encoding), numberFormat: numberFormat,
            separator: text(config.separator), skipRows: config.skipRows,
            dateColumn: config.columns.date, recipientColumn: config.columns.recipient,
            amountColumn: config.columns.amount, memoColumn: config.columns.memo ?? "")
    }

    struct PreparedImport: Sendable {
        var batchId: Int  // lint:allow raw-id an import_batches id inside the pipeline's own result, ADR-252 has no dedicated type
        var rowsTotal: Int
        var requiresReview: Bool
        var matchSourceCounts: MatchSourceCounts
        var validateErrors: Int
    }

    /// `prepareImport`: stage, validate, match, then the awaiting_review decision.
    static func prepareImport(
        _ session: BackendSession, batchId: Int, file: UploadedFile, adapterName: String,  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
        customConfig: CustomBankParserConfig?, onProgress: ((PipelineProgress) -> Void)?
    ) throws -> PreparedImport {
        let staged = try stageBatch(
            session, batchId: batchId, file: file, adapterName: adapterName,
            customConfig: customConfig, onProgress: onProgress)
        let validated = try validateBatch(session, batchId: batchId, onProgress: onProgress)
        let matched = try matchBatch(session, batchId: batchId, onProgress: onProgress)
        let requiresReview =
            matched.matchSourceCounts.fuzzy > 0 || matched.matchSourceCounts.pattern > 0
            || matched.matchSourceCounts.new > 0 || matched.unresolved > 0
        if requiresReview {
            _ = try session.row(
                "UPDATE import_batches SET status = 'awaiting_review' WHERE id = ? RETURNING id",
                [.integer(Int64(batchId))])
        }
        return PreparedImport(
            batchId: batchId, rowsTotal: staged.rowsTotal, requiresReview: requiresReview,
            matchSourceCounts: matched.matchSourceCounts, validateErrors: validated.errors)
    }

    /// `stageBatch` (`stage.ts`): the adapter parse, the rejected-row rejection, then the
    /// chunked staging inserts of `runImportStageLifecycle`.
    static func stageBatch(
        _ session: BackendSession, batchId: Int, file: UploadedFile, adapterName: String,  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
        customConfig: CustomBankParserConfig?, onProgress: ((PipelineProgress) -> Void)?
    ) throws -> (rowsTotal: Int, rowsSkipped: Int) {
        _ = try session.row(
            "UPDATE import_batches SET status = 'staging' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        // The adapter (`stageBatch`'s choice): a customConfig only reaches the generic
        // adapter (parseWithConfig) for a label the registry does not hold; a
        // registry-named label keeps the bank's own parse, the config unread.
        let parsed: ParsedBankTransactions
        if let bank = BankAdapters.bank(named: adapterName) {
            parsed = try BankAdapters.parse(bank, file.bytes)
        } else if let customConfig {
            parsed = try BankAdapters.parse(custom: customConfig, file.bytes)
        } else {
            throw PipelineFailure(text: "Unknown adapter: \(adapterName)")
        }
        let rejected = (parsed.skipped ?? 0) - (parsed.excluded ?? 0)
        if rejected > 0 {
            var message =
                "Import stopped: \(rejected) source row(s) could not be parsed. No transactions were imported."
            if let issues = parsed.issues, !issues.isEmpty {
                let joined = issues.joined(separator: "; ")
                message += " \(joined)."
            }
            message += " Correct the invalid dates, amounts or CSV structure and import the file again."
            throw BackendHTTPError(
                status: 400, code: "VALIDATION_ERROR", message: message,
                details: .object([
                    "rejected_rows": .int(rejected),
                    "parsed_rows": .int(parsed.rows.count),
                ]))
        }
        let total = parsed.rows.count
        _ = try session.row(
            "UPDATE import_batches SET rows_total = ? WHERE id = ? RETURNING id",
            [.integer(Int64(total)), .integer(Int64(batchId))])
        onProgress?(PipelineProgress(phase: "staging", current: 0, total: total, imported: nil, duplicates: nil, errors: nil))
        var start = 0
        while start < total {
            let end = min(start + 500, total)
            try session.transaction {
                try insertStagingChunk(session, batchId: batchId, rows: Array(parsed.rows[start..<end]), startIndex: start)
            }
            onProgress?(PipelineProgress(phase: "staging", current: end, total: total, imported: nil, duplicates: nil, errors: nil))
            start = end
        }
        return (total, parsed.skipped ?? 0)
    }

    /// `insertStagingChunk` (`stage.ts`): one multi-VALUES statement, the columns in the
    /// values() order of the source.
    static func insertStagingChunk(
        _ session: BackendSession, batchId: Int, rows: [ParsedBankTransaction], startIndex: Int  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
    ) throws {
        guard !rows.isEmpty else { return }
        let columns = 18
        var sql =
            "INSERT INTO import_staging_rows (batch_id, row_index, status, tx_date, bank_account, " +
            "recipient_raw, memo, amount, currency, balance, recipient_account, recipient_address, " +
            "recipient_bank_name, comment, raw_data, source_transaction_id, source_account_identity, " +
            "bank_sequence) VALUES "
        var arguments: [SQLValue] = []
        var first = true
        for (index, row) in rows.enumerated() {
            if !first { sql += ", " }
            first = false
            // `amount` and `balance` are the two DECIMAL_TEXT(20, 4) columns the write
            // plugin rounded with `canonicalDecimal` (`canonicalDecimal`: a number is its
            // `String(n)` text, then the scale rounding of `vision_numeric(?)` — the CHECK
            // refuses a raw REAL).
            var placeholders: [String] = Array(repeating: "?", count: columns)
            placeholders[7] = "vision_numeric(?, 20, 4)"
            placeholders[9] = "vision_numeric(?, 20, 4)"
            sql += "(" + placeholders.joined(separator: ", ") + ")"
            arguments.append(.integer(Int64(batchId)))
            arguments.append(.integer(Int64(startIndex + index)))
            arguments.append(.text("pending"))
            // parsedDateToYmd(r.date) ?? null
            arguments.append(.text(ymd(day: row.day)))
            arguments.append(row.bankAccount.isEmpty ? .null : .text(row.bankAccount))
            arguments.append(row.recipient.isEmpty ? .null : .text(row.recipient))
            arguments.append(row.memo.isEmpty ? .null : .text(row.memo))
            arguments.append(.text(SQLArguments.javaScriptText(row.amount)))
            arguments.append(row.currency.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.balance.map { SQLValue.text(SQLArguments.javaScriptText($0)) } ?? .null)
            arguments.append(row.recipientAccount.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.recipientAddress.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.recipientBankName.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.comment.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.rawData.isEmpty ? .null : .text(row.rawData))
            arguments.append(sourceIdValue(row))
            arguments.append(row.bankAccount.isEmpty ? .null : .text(row.bankAccount))
            arguments.append(bankSequenceValue(row))
        }
        _ = try session.rows(sql, arguments)
    }

    /// `parsedDateToYmd` of an adapter's day (a UTC-midnight `Date` in TS).
    static func ymd(day: Int) -> String {
        let utc = SQLTimestamps(timeZone: TimeZone(secondsFromGMT: 0) ?? .current)
        return SQLTimestamps.formatDate(utc.localDate(of: SQLTimestamps.Instant(ms: Int64(day) * 86_400_000)))
    }

    /// `r.sourceId || null`.
    static func sourceIdValue(_ row: ParsedBankTransaction) -> SQLValue {
        guard let outer = row.sourceReference, let id = outer, !id.isEmpty else { return .null }
        return .text(id)
    }

    /// `r.bankSequence ?? null`.
    static func bankSequenceValue(_ row: ParsedBankTransaction) -> SQLValue {
        guard let outer = row.bankSequence, let sequence = outer else { return .null }
        return .text(sequence)
    }

    // MARK: - VALIDATE (`services/importPipeline/validate.ts`)

    /// One row of the phase's projection (`pendingStagingRowSchema`); `tx_date` is
    /// `to_char`-ed text and `amount` arrives as SQLite stored it (REAL or text).
    struct StagedValidateRow: Sendable {
        var id: Int64
        var status: String
        var txDate: String?
        var amountText: String?
        var amountNumber: Double?
        var recipientRaw: String?
        var memo: String?
        var currency: String?
        var rawData: String?
        var bankAccount: String?
        var recipientAccount: String?
        var sourceId: String?  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
        var adapterName: String
    }

    struct ValidatedBatch: Sendable {
        var validated: Int
        var duplicates: Int
        var errors: Int
    }

    static func validateBatch(
        _ session: BackendSession, batchId: Int, onProgress: ((PipelineProgress) -> Void)?  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
    ) throws -> ValidatedBatch {
        _ = try session.row(
            "UPDATE import_batches SET status = 'validating' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        let batchRows = try session.rows(
            """
            SELECT s.id, s.row_index, s.status, to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date,
                   s.amount, s.recipient_raw, s.memo, s.currency, s.raw_data,
                   s.bank_account, s.recipient_account, s.source_transaction_id AS source_id,
                   b.adapter_name
              FROM import_staging_rows s
              JOIN import_batches b ON b.id = s.batch_id
             WHERE s.batch_id = ?
             ORDER BY s.row_index ASC
            """,
            [.integer(Int64(batchId))]).map { row -> StagedValidateRow in
                var staged = StagedValidateRow(
                    id: try row.int64("id"), status: try row.text("status"),
                    txDate: try row.optionalText("tx_date"),
                    amountText: nil, amountNumber: nil,
                    recipientRaw: try row.optionalText("recipient_raw"),
                    memo: try row.optionalText("memo"),
                    currency: try row.optionalText("currency"),
                    rawData: try row.optionalText("raw_data"),
                    bankAccount: try row.optionalText("bank_account"),
                    recipientAccount: try row.optionalText("recipient_account"),
                    sourceId: try row.optionalText("source_id"),
                    adapterName: try row.text("adapter_name"))
                if let number = try row.optionalDouble("amount") {
                    staged.amountNumber = number
                } else if let text = try row.optionalText("amount") {
                    staged.amountText = text
                }
                return staged
            }
        let pending = batchRows.filter { $0.status == "pending" }  // lint:allow string-literal-compare the staging status the phase reads
        let total = pending.count
        onProgress?(PipelineProgress(phase: "validating", current: 0, total: total, imported: nil, duplicates: nil, errors: nil))
        let identities = ImportIdentity.assignIdentities(rows: batchRows)
        var identityById: [Int64: ImportIdentity.Value] = [:]
        for (row, identity) in zip(batchRows, identities) { identityById[row.id] = identity }

        var errors = 0
        var seen = 0
        for start in stride(from: 0, to: total, by: 500) {
            let chunk = pending[start..<min(start + 500, total)]
            var updateValues: [JSValue] = []
            for row in chunk {
                guard let identity = identityById[row.id] else {
                    throw PipelineFailure(text: "every pending row is one of batchRows, which keyed identityById")
                }
                var fields = JSObject()
                if let issue = validateRow(row) {
                    errors += 1
                    fields["status"] = .string("error")
                    fields["fingerprint"] = .null
                    fields["source_record_hash"] = identity.sourceRecordHash.map(JSValue.string) ?? .null
                    fields["fingerprint_version"] = .null
                    fields["occurrence"] = .null
                    fields["error_message"] = .string(issue)
                } else {
                    fields["status"] = .string("validated")
                    fields["fingerprint"] = .string(identity.fingerprint)
                    fields["source_record_hash"] = identity.sourceRecordHash.map(JSValue.string) ?? .null
                    fields["fingerprint_version"] = .number(Double(identity.version))
                    fields["occurrence"] = .number(Double(identity.occurrence))
                    fields["error_message"] = .null
                }
                fields["id"] = .number(Double(row.id))
                updateValues.append(.object(fields))
            }
            // One statement per chunk: the rows travel as one JSON array.
            let array = JSValue.array(updateValues).jsonText
            _ = try session.rows(
                """
                UPDATE import_staging_rows
                      SET status = v.status,
                          source_record_hash = v.source_record_hash,
                          dedup_fingerprint = v.fingerprint,
                          dedup_fingerprint_version = v.fingerprint_version,
                          dedup_occurrence = v.occurrence,
                          error_message = v.error_message,
                          updated_at = now()
                 FROM (SELECT CAST(value ->> 'id' AS INTEGER) AS id,
                              value ->> 'status' AS status,
                              value ->> 'fingerprint' AS fingerprint,
                              value ->> 'source_record_hash' AS source_record_hash,
                              value ->> 'fingerprint_version' AS fingerprint_version,
                              value ->> 'occurrence' AS occurrence,
                              value ->> 'error_message' AS error_message
                         FROM json_each(?)) AS v
                WHERE import_staging_rows.id = v.id
                """,
                [.text(array)])
            seen += chunk.count
            onProgress?(PipelineProgress(phase: "validating", current: seen, total: total, imported: nil, duplicates: nil, errors: nil))
        }
        let validated = total - errors
        return ValidatedBatch(validated: validated, duplicates: 0, errors: errors)
    }

    /// `validateRow`: the first issue of `usableStagingRowSchema` is the stored reason.
    static func validateRow(_ row: StagedValidateRow) -> String? {
        guard let txDate = row.txDate, !txDate.isEmpty else { return "missing tx_date" }
        if row.amountText == nil && row.amountNumber == nil { return "missing amount" }
        let number: Double
        if let text = row.amountText {
            number = JavaScriptNumber.fromString(text)
        } else {
            number = row.amountNumber ?? Double.nan
        }
        guard !number.isNaN, number.isFinite else { return "invalid amount" }
        return nil
    }

    // MARK: - MATCH (`services/importPipeline/match.ts`)

    struct MatchedBatch: Sendable {
        var matched: Int
        var unresolved: Int
        var matchSourceCounts: MatchSourceCounts
    }

    struct RecipientResolution: Sendable {
        var recipientId: Int64
        var matchSource: String
        var matchSimilarity: Double?
        var matchedPatternId: Int64?
    }

    static func matchBatch(
        _ session: BackendSession, batchId: Int, onProgress: ((PipelineProgress) -> Void)?  // lint:allow raw-id an import_batches/source id inside one pipeline pass, ADR-252 has no dedicated type
    ) throws -> MatchedBatch {
        _ = try session.row(
            "UPDATE import_batches SET status = 'matching' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        let staged = try session.rows(
            "SELECT id, recipient_raw FROM import_staging_rows WHERE batch_id = ? AND status = 'validated' ORDER BY row_index ASC",
            [.integer(Int64(batchId))])
        let total = staged.count
        onProgress?(PipelineProgress(phase: "matching", current: 0, total: total, imported: nil, duplicates: nil, errors: nil))
        var distinctRaw: [String] = []
        var seenRaw: Set<String> = []
        for row in staged {
            guard let raw = try row.optionalText("recipient_raw"), !JavaScriptWhitespace.trim(raw).isEmpty else { continue }
            if !seenRaw.contains(raw) {
                seenRaw.insert(raw)
                distinctRaw.append(raw)
            }
        }

        // Phase 1: patterns. Phase 2: exact/fuzzy for the rest.
        let patternMatches = try applyPatterns(session, distinctRaw)
        let unpatterned = distinctRaw.filter { patternMatches[$0] == nil }
        let fuzzyMatches = try findBestRecipientMatches(session, unpatterned)

        var resolved: [String: RecipientResolution] = [:]
        for (raw, match) in patternMatches {
            resolved[raw] = RecipientResolution(
                recipientId: match.recipientId, matchSource: "pattern", matchSimilarity: nil,
                matchedPatternId: match.patternId)
        }
        for (raw, match) in fuzzyMatches {
            resolved[raw] = RecipientResolution(
                recipientId: match.recipientId,
                matchSource: match.exact ? "exact" : "fuzzy",
                matchSimilarity: match.exact ? nil : match.similarity,
                matchedPatternId: nil)
        }

        // Phase 3: upsert new recipients for the names nothing resolved.
        var toUpsert: [(raw: String, upper: String, normalized: String)] = []
        for raw in distinctRaw where resolved[raw] == nil {
            let normalized = RecipientText.normalizeForMatching(raw)
            if !normalized.isEmpty {
                toUpsert.append(
                    (raw, JavaScriptWhitespace.trim(JavaScriptCase.uppercased(raw)), normalized))
            }
        }
        if !toUpsert.isEmpty {
            let insert = JSValue.array(
                toUpsert.map { JSValue.array([.string($0.upper), .string($0.normalized)]) }).jsonText
            let inserted = try session.rows(
                """
                INSERT INTO recipients (name, normalized_name, is_active)
                SELECT n.value ->> 0, n.value ->> 1, 1
                  FROM json_each(?) AS n
                 WHERE true
                 ORDER BY n.key
                ON CONFLICT (normalized_name) DO NOTHING
                RETURNING id, normalized_name
                """,
                [.text(insert)])
            var insertedByNorm: [String: Int64] = [:]
            for row in inserted {
                insertedByNorm[try row.text("normalized_name")] = try row.int64("id")
            }
            let conflicted = toUpsert.map { $0.normalized }.filter { insertedByNorm[$0] == nil }
            if !conflicted.isEmpty {
                let existing = try session.rows(
                    "SELECT id, normalized_name FROM recipients WHERE normalized_name IN (SELECT value FROM json_each(?))",
                    [.text(JSValue.array(conflicted.map { JSValue.string($0) }).jsonText)])
                for row in existing {
                    insertedByNorm[try row.text("normalized_name")] = try row.int64("id")
                }
            }
            for entry in toUpsert {
                if let id = insertedByNorm[entry.normalized] {
                    resolved[entry.raw] = RecipientResolution(
                        recipientId: id, matchSource: "new", matchSimilarity: nil, matchedPatternId: nil)
                }
            }
        }

        // Chunked staging updates; an unresolved row is 'matched' with a NULL recipient.
        var matched = 0
        var unresolved = 0
        var seen = 0
        for start in stride(from: 0, to: staged.count, by: 500) {
            let chunk = staged[start..<min(start + 500, staged.count)]
            var updateValues: [JSValue] = []
            for row in chunk {
                let raw = try row.optionalText("recipient_raw")
                var fields = JSObject()
                fields["id"] = .number(Double(try row.int64("id")))
                if let raw, let info = resolved[raw] {
                    matched += 1
                    fields["recipient_id"] = .number(Double(info.recipientId))
                    fields["match_source"] = .string(info.matchSource)
                    fields["match_similarity"] = info.matchSimilarity.map { JSValue.number(SQLText.float4Value($0)) } ?? .null
                    fields["matched_pattern_id"] = info.matchedPatternId.map { JSValue.number(Double($0)) } ?? .null
                } else {
                    unresolved += 1
                    fields["recipient_id"] = .null
                    fields["match_source"] = .null
                    fields["match_similarity"] = .null
                    fields["matched_pattern_id"] = .null
                }
                updateValues.append(.object(fields))
            }
            let array = JSValue.array(updateValues).jsonText
            _ = try session.rows(
                """
                UPDATE import_staging_rows
                      SET status = 'matched',
                          resolved_recipient_id = v.recipient_id,
                          match_source = v.match_source,
                          match_similarity = v.match_similarity,
                          matched_pattern_id = v.matched_pattern_id,
                          updated_at = now()
                 FROM (SELECT CAST(value ->> 'id' AS INTEGER) AS id,
                              value ->> 'recipient_id' AS recipient_id,
                              value ->> 'match_source' AS match_source,
                              value ->> 'match_similarity' AS match_similarity,
                              value ->> 'matched_pattern_id' AS matched_pattern_id
                         FROM json_each(?)) AS v
                WHERE import_staging_rows.id = v.id
                """,
                [.text(array)])
            seen += chunk.count
            onProgress?(PipelineProgress(phase: "matching", current: seen, total: total, imported: nil, duplicates: nil, errors: nil))
        }

        var counts = MatchSourceCounts()
        for info in resolved.values {
            switch info.matchSource {
            case "pattern": counts.pattern += 1  // lint:allow string-literal-compare the match source, as matchBatch stamps it
            case "exact": counts.exact += 1  // lint:allow string-literal-compare the match source, as matchBatch stamps it
            case "fuzzy": counts.fuzzy += 1  // lint:allow string-literal-compare the match source, as matchBatch stamps it
            default: counts.new += 1
            }
        }
        return MatchedBatch(matched: matched, unresolved: unresolved, matchSourceCounts: counts)
    }

    struct PatternMatch: Sendable {
        var recipientId: Int64
        var patternId: Int64
    }

    struct ActivePattern: Sendable {
        var id: Int64
        var recipientId: Int64
        var pattern: String
        var patternKind: String
        var caseSensitive: Bool
    }

    /// `loadActivePatterns` + `applyPatterns` (`recipientPatternService.ts`): the first
    /// matching pattern wins, evaluated against the uppercase trimmed raw value.
    static func applyPatterns(_ session: BackendSession, _ distinctRaw: [String]) throws -> [String: PatternMatch] {
        var result: [String: PatternMatch] = [:]
        guard !distinctRaw.isEmpty else { return result }
        let patterns = try session.rows(
            "SELECT id, recipient_id, pattern, pattern_kind, case_sensitive FROM recipient_match_patterns " +
                "WHERE is_active = 1 ORDER BY priority ASC, id ASC"
        ).map { row -> ActivePattern in
            ActivePattern(
                id: try row.int64("id"), recipientId: try row.int64("recipient_id"),
                pattern: try row.text("pattern"), patternKind: try row.text("pattern_kind"),
                caseSensitive: try row.bool("case_sensitive"))
        }
        guard !patterns.isEmpty else { return result }
        for raw in distinctRaw {
            guard !raw.isEmpty else { continue }
            let upper = JavaScriptCase.uppercased(JavaScriptWhitespace.trim(raw))
            for pattern in patterns {
                guard let regex = patternRegExp(pattern) else { continue }
                let matches = JavaScriptRegExp.shared.test(
                    regex.pattern, flags: regex.flags, [upper], upperCased: false)
                if matches.first == true {
                    result[raw] = PatternMatch(recipientId: pattern.recipientId, patternId: pattern.id)
                    break
                }
            }
        }
        return result
    }

    /// `buildPatternRegExp` (`RecipientText.buildSqlRegexPattern` underlies it).
    static func patternRegExp(_ pattern: ActivePattern) -> (pattern: String, flags: String)? {
        let flags = pattern.caseSensitive ? "" : "i"
        switch pattern.patternKind {
        case "literal_prefix":  // lint:allow string-literal-compare the pattern kind, as loadActivePatterns reads it
            return ("^" + RecipientText.escapeRegExp(pattern.pattern, escapeWildcards: true), flags)
        case "glob":  // lint:allow string-literal-compare the pattern kind, as loadActivePatterns reads it
            return ("^" + RecipientText.escapeRegExp(pattern.pattern, escapeWildcards: false) + "$", flags)
        default:
            return (pattern.pattern, flags)
        }
    }

    struct RecipientMatch: Sendable {
        var recipientId: Int64
        var similarity: Double
        var exact: Bool
    }

    /// `findBestRecipientMatches` (`services/calculations/normalization.ts`): an exact
    /// normalized hit preferred, else the best trigram similarity above 0.7 (with pg_trgm's
    /// 0.3 floor), ties to the lowest recipient id.
    static func findBestRecipientMatches(
        _ session: BackendSession, _ names: [String]
    ) throws -> [String: RecipientMatch] {
        var out: [String: RecipientMatch] = [:]
        var normalizedByRaw: [String: String] = [:]
        for raw in names {
            let norm = RecipientText.normalizeForMatching(raw)
            if !norm.isEmpty { normalizedByRaw[raw] = norm }
        }
        guard !normalizedByRaw.isEmpty else { return out }
        let recipients = try session.rows("SELECT id, normalized_name FROM recipients", [])
        for raw in normalizedByRaw.keys.sorted() {
            guard let norm = normalizedByRaw[raw] else { continue }
            if let exact = recipients.first(where: { (try? $0.text("normalized_name")) == norm }),
                let id = try? exact.int64("id") {
                out[raw] = RecipientMatch(recipientId: id, similarity: 1, exact: true)
                continue
            }
            var best: (id: Int64, similarity: Double)? = nil
            for row in recipients {
                guard let name = try? row.text("normalized_name"), name != norm else { continue }
                let similarity = SQLText.float4Value(SQLText.similarity(name, norm))
                guard similarity >= 0.3, similarity >= SQLText.float4Value(0.7) else { continue }
                guard let id = try? row.int64("id") else { continue }
                if let current = best {
                    if similarity > current.similarity || (similarity == current.similarity && id < current.id) {
                        best = (id, similarity)
                    }
                } else {
                    best = (id, similarity)
                }
            }
            if let best {
                out[raw] = RecipientMatch(recipientId: best.id, similarity: best.similarity, exact: false)
            }
        }
        return out
    }

    // MARK: - The simple CSV importers (`services/dataImportService.ts`)

    struct CategoryPair: Sendable {
        var general: String
        var detail: String
    }

    struct ResolvedRecipient: Sendable {
        var id: Int64
        var created: Bool
        var notes: String?
        var defaultCategoryId: Int64?
    }

    /// One parsed CSV row the recipient importer reads (`recipientCsvRowSchema`).
    struct RecipientCsvRow: Sendable {
        var name: String
        var bankAccount: String
        var address: String
        var categoryStr: String
    }

    /// csv-parse's `columns: true, skip_empty_lines: true, trim: true,
    /// relax_column_count: true` read.
    static func headerRecords(_ content: String, separator: String) throws -> (records: [CSVParse.Record], columns: [String?]) {
        var options = CSVParse.Options()
        options.columns = .firstRecord
        options.skipEmptyLines = true
        options.trim = true
        options.relaxColumnCount = true
        options.delimiter = separator
        let output = try Text.records(content, options)
        return (output.records, output.columns ?? [])
    }

    /// `importRecipientsCSV`.
    static func importRecipientsCSV(
        _ session: BackendSession, bytes: [UInt8], separator: String, encoding: String
    ) throws -> SimpleImportResults {
        let content = try Text.decode(bytes, try Text.encoding(encoding))
        var results = SimpleImportResults()
        let parsed: (records: [CSVParse.Record], columns: [String?])
        do {
            parsed = try headerRecords(content, separator: separator)
        } catch {
            throw PipelineFailure(text: "CSV parse error: \(String(describing: error))")
        }
        results.totalProcessed = parsed.records.count
        guard !parsed.records.isEmpty else { return results }

        var rows: [RecipientCsvRow] = []
        let keys = parsed.columns.compactMap { $0 }
        func value(of record: CSVParse.Record, name: String) -> String {
            guard let match = keys.first(where: { JavaScriptWhitespace.trim(JavaScriptCase.lowercased($0)) == name }),
                let cell = record[match]
            else { return "" }
            return JavaScriptWhitespace.trim(cell)
        }
        for record in parsed.records {
            let name = value(of: record, name: "name")
            if name.isEmpty {
                results.errors += 1
                continue
            }
            var bankAccount = value(of: record, name: "bank_account")
            if bankAccount.isEmpty { bankAccount = value(of: record, name: "account_number") }
            rows.append(RecipientCsvRow(
                name: name, bankAccount: bankAccount,
                address: value(of: record, name: "address"),
                categoryStr: value(of: record, name: "category")))
        }
        guard !rows.isEmpty else { return results }
        try importRecipientRowsBatched(session, rows, &results)
        return results
    }

    struct CustomCategoryRow: Sendable {
        var raw: String
        var general: String
        var detail: String
    }

    /// `importCategoriesCSV`.
    static func importCategoriesCSV(
        _ session: BackendSession, bytes: [UInt8], separator: String, encoding: String
    ) throws -> SimpleImportResults {
        let content = try Text.decode(bytes, try Text.encoding(encoding))
        var results = SimpleImportResults()
        let parsed: (records: [CSVParse.Record], columns: [String?])
        do {
            parsed = try headerRecords(content, separator: separator)
        } catch {
            throw PipelineFailure(text: "CSV parse error: \(String(describing: error))")
        }
        results.totalProcessed = parsed.records.count
        guard let firstRecord = parsed.records.first else { return results }

        // Prefer a "category" header, else the first column.
        let keys = parsed.columns.compactMap { $0 }
        let categoryKey =
            keys.first { JavaScriptWhitespace.trim(JavaScriptCase.lowercased($0)) == "category" }  // lint:allow string-literal-compare the header the importer prefers, as the route reads it
                ?? keys.first
        var rows: [CustomCategoryRow] = []
        for record in parsed.records {
            // A header row without column names no key: every cell reads as missing.
            let cell = categoryKey.flatMap { record[$0] } ?? ""
            _ = firstRecord
            let trimmed = JavaScriptWhitespace.trim(cell)
            if trimmed.isEmpty {
                results.errors += 1
                continue
            }
            guard trimmed.contains(":") else {
                results.errors += 1
                continue
            }
            let pair = parseCategoryPair(trimmed)
            if pair.general.isEmpty || pair.detail.isEmpty {
                results.errors += 1
                continue
            }
            rows.append(CustomCategoryRow(raw: trimmed, general: pair.general, detail: pair.detail))
        }
        guard !rows.isEmpty else { return results }
        try importCategoryRowsBatched(session, rows, &results)
        return results
    }

    /// `parseCategoryPair` (`parseCategoryName` + `toUpperCase`): without a colon the
    /// whole text is the general half and `detail` is empty.
    static func parseCategoryPair(_ text: String) -> CategoryPair {
        if let colon = text.firstIndex(of: ":") {
            let general = JavaScriptWhitespace.trim(String(text[..<colon]))
            let detail = JavaScriptWhitespace.trim(String(text[text.index(after: colon)...]))
            return CategoryPair(
                general: JavaScriptCase.uppercased(general), detail: JavaScriptCase.uppercased(detail))
        }
        return CategoryPair(
            general: JavaScriptCase.uppercased(JavaScriptWhitespace.trim(text)), detail: "")
    }

    /// `resolveCategories` (`selectCategories` + the upsert): the alias-merging select, the
    /// `ON CONFLICT DO NOTHING` insert and the raced re-select.
    static func resolveCategories(
        _ session: BackendSession, _ pairs: [CategoryPair]
    ) throws -> [String: (id: Int64, created: Bool)] {
        var resolved: [String: (id: Int64, created: Bool)] = [:]
        guard !pairs.isEmpty else { return resolved }
        func select(_ json: String) throws -> [SQLRow] {
            try session.rows(
                """
                WITH want AS (
                     SELECT p.value ->> 0 AS general, p.value ->> 1 AS detail
                       FROM json_each(?) AS p
                   )
                   SELECT COALESCE(c.id, a.target_category_id) AS id,
                          want.general, want.detail
                     FROM want
                     LEFT JOIN categories c
                       ON c.general = want.general AND c.detail = want.detail
                     LEFT JOIN category_merge_aliases a
                       ON a.general = want.general AND a.detail = want.detail
                    WHERE c.id IS NOT NULL OR a.target_category_id IS NOT NULL
                """,
                [.text(json)])
        }
        let pairsJSON = { (list: [CategoryPair]) in
            JSValue.array(list.map { JSValue.array([.string($0.general), .string($0.detail)]) }).jsonText
        }
        for row in try select(pairsJSON(pairs)) {
            resolved[categoryKey(try row.text("general"), try row.text("detail"))] = (try row.int64("id"), false)
        }
        let missing = pairs.filter { resolved[categoryKey($0.general, $0.detail)] == nil }
        if missing.isEmpty { return resolved }
        let inserted = try session.rows(
            """
            INSERT INTO categories (general, detail, description, is_active)
            SELECT p.value ->> 0, p.value ->> 1, NULL, 1
              FROM json_each(?) AS p
             WHERE true
             ORDER BY p.key
            ON CONFLICT (general, detail) DO NOTHING
            RETURNING id, general, detail
            """,
            [.text(pairsJSON(missing))])
        for row in inserted {
            resolved[categoryKey(try row.text("general"), try row.text("detail"))] = (try row.int64("id"), true)
        }
        let raced = missing.filter { resolved[categoryKey($0.general, $0.detail)] == nil }
        if !raced.isEmpty {
            for row in try select(pairsJSON(raced)) {
                resolved[categoryKey(try row.text("general"), try row.text("detail"))] = (try row.int64("id"), false)
            }
        }
        return resolved
    }

    static func categoryKey(_ general: String, _ detail: String) -> String {
        "\(general)\u{0}\(detail)"
    }

    /// `resolveRecipients`: the same resolve over `normalized_name`.
    static func resolveRecipients(
        _ session: BackendSession, _ names: [(upper: String, normalized: String)]
    ) throws -> [String: ResolvedRecipient] {
        var resolved: [String: ResolvedRecipient] = [:]
        guard !names.isEmpty else { return resolved }
        func select(_ normalized: [String]) throws -> [SQLRow] {
            try session.rows(
                "SELECT id, normalized_name, notes, default_category_id FROM recipients " +
                    "WHERE normalized_name IN (SELECT value FROM json_each(?))",
                [.text(JSValue.array(normalized.map { JSValue.string($0) }).jsonText)])
        }
        for row in try select(names.map { $0.normalized }) {
            resolved[try row.text("normalized_name")] = ResolvedRecipient(
                id: try row.int64("id"), created: false,
                notes: try row.optionalText("notes"),
                defaultCategoryId: try row.optionalInt64("default_category_id"))
        }
        let missing = names.filter { resolved[$0.normalized] == nil }
        if missing.isEmpty { return resolved }
        let inserted = try session.rows(
            """
            INSERT INTO recipients (name, normalized_name, is_active)
            SELECT n.value ->> 0, n.value ->> 1, 1
              FROM json_each(?) AS n
             WHERE true
             ORDER BY n.key
            ON CONFLICT (normalized_name) DO NOTHING
            RETURNING id, normalized_name
            """,
            [.text(JSValue.array(missing.map { JSValue.array([.string($0.upper), .string($0.normalized)]) }).jsonText)])
        for row in inserted {
            resolved[try row.text("normalized_name")] = ResolvedRecipient(
                id: try row.int64("id"), created: true, notes: nil, defaultCategoryId: nil)
        }
        let raced = missing.filter { resolved[$0.normalized] == nil }
        if !raced.isEmpty {
            for row in try select(raced.map { $0.normalized }) {
                resolved[try row.text("normalized_name")] = ResolvedRecipient(
                    id: try row.int64("id"), created: false,
                    notes: try row.optionalText("notes"),
                    defaultCategoryId: try row.optionalInt64("default_category_id"))
            }
        }
        return resolved
    }

    /// `importRecipientRowsBatched`: the resolves in one transaction, then the per-row fold
    /// with the notes flush, the per-account `createOrGet` and the default-category flush.
    static func importRecipientRowsBatched(
        _ session: BackendSession, _ rows: [RecipientCsvRow], _ results: inout SimpleImportResults
    ) throws {
        var distinctNames: [String: (upper: String, normalized: String)] = [:]
        var orderedNames: [(upper: String, normalized: String)] = []
        var distinctPairs: [String: CategoryPair] = [:]
        var orderedPairs: [CategoryPair] = []
        for row in rows {
            let normalized = RecipientText.normalizeForMatching(row.name)
            if distinctNames[normalized] == nil {
                let stored = (JavaScriptWhitespace.trim(JavaScriptCase.uppercased(row.name)), normalized)
                distinctNames[normalized] = stored
                orderedNames.append(stored)
            }
            if !row.categoryStr.isEmpty {
                let pair = parseCategoryPair(row.categoryStr)
                if !pair.general.isEmpty && !pair.detail.isEmpty {
                    let key = categoryKey(pair.general, pair.detail)
                    if distinctPairs[key] == nil {
                        distinctPairs[key] = pair
                        orderedPairs.append(pair)
                    }
                }
            }
        }
        // The resolve phases run in one transaction, as `withTransaction` wraps them.
        let (recipients, categories) = try session.transaction {
            (try resolveRecipients(session, orderedNames), try resolveCategories(session, orderedPairs))
        }
        try importRecipientRowsFold(session, rows, recipients, categories, &results)
    }

    private static func importRecipientRowsFold(
        _ session: BackendSession, _ rows: [RecipientCsvRow],
        _ resolvedRecipients: [String: ResolvedRecipient],
        _ resolvedCategories: [String: (id: Int64, created: Bool)],
        _ results: inout SimpleImportResults
    ) throws {
        enum Outcome { case imported, skipped, error }
        var recipients = resolvedRecipients
        var outcomes = [Outcome?](repeating: nil, count: rows.count)
        var notesUpdates: [(rowIndex: Int, id: Int64, notes: String)] = []
        var categoryUpdates: [(rowIndex: Int, id: Int64, categoryId: Int64)] = []
        var bankAccounts: [(rowIndex: Int, id: Int64, accountNumber: String)] = []
        var counted: Set<Int64> = []

        for (index, row) in rows.enumerated() {
            let normalized = RecipientText.normalizeForMatching(row.name)
            guard var recipient = recipients[normalized] else {
                outcomes[index] = .error
                continue
            }
            if !row.address.isEmpty, recipient.notes == nil {
                notesUpdates.append((index, recipient.id, row.address))
                recipient.notes = row.address
                recipients[normalized] = recipient
            }
            if !row.bankAccount.isEmpty {
                bankAccounts.append((index, recipient.id, row.bankAccount))
            }
            if !row.categoryStr.isEmpty {
                let pair = parseCategoryPair(row.categoryStr)
                if !pair.general.isEmpty && !pair.detail.isEmpty {
                    guard let category = resolvedCategories[categoryKey(pair.general, pair.detail)] else {
                        outcomes[index] = .error
                        continue
                    }
                    if recipient.defaultCategoryId == nil {
                        categoryUpdates.append((index, recipient.id, category.id))
                        recipient.defaultCategoryId = category.id
                        recipients[normalized] = recipient
                    }
                }
            }
            let firstOccurrence = !counted.contains(recipient.id)
            counted.insert(recipient.id)
            outcomes[index] = recipient.created && firstOccurrence ? .imported : .skipped
        }

        // Notes, then bank accounts, then default categories, as the loop ordered them.
        if !notesUpdates.isEmpty {
            let updates = JSValue.array(
                notesUpdates.map { JSValue.array([.number(Double($0.id)), .string($0.notes)]) }).jsonText
            _ = try session.rows(
                """
                UPDATE recipients SET notes = u.notes
                   FROM (SELECT j.value ->> 0 AS id, j.value ->> 1 AS notes
                           FROM json_each(?) AS j) AS u
                 WHERE recipients.id = u.id
                """,
                [.text(updates)])
        }
        for account in bankAccounts {
            guard outcomes[account.rowIndex] != .error else { continue }
            do {
                try createOrGetBankAccount(session, recipientId: account.id, accountNumber: account.accountNumber)
            } catch {
                results.bankAccountErrors += 1
            }
        }
        let payableCategoryUpdates = categoryUpdates.filter { outcomes[$0.rowIndex] != .error }
        if !payableCategoryUpdates.isEmpty {
            let updates = JSValue.array(
                payableCategoryUpdates.map { JSValue.array([.number(Double($0.id)), .number(Double($0.categoryId))]) }).jsonText
            _ = try session.rows(
                """
                UPDATE recipients SET default_category_id = u.category_id
                   FROM (SELECT j.value ->> 0 AS id, j.value ->> 1 AS category_id
                           FROM json_each(?) AS j) AS u
                 WHERE recipients.id = u.id AND recipients.default_category_id IS NULL
                """
                [.text(updates)])
        }
        for outcome in outcomes {
            switch outcome {
            case .imported: results.imported += 1
            case .skipped: results.skipped += 1
            default: results.errors += 1
            }
        }
    }

    /// `recipientBankAccountRepository.createOrGet` with `setAsPrimary: false` — the only
    /// shape the importer calls.
    static func createOrGetBankAccount(
        _ session: BackendSession, recipientId: Int64, accountNumber: String
    ) throws {
        guard !accountNumber.isEmpty else { throw PipelineFailure(text: "Account number is required") }
        let normalized = JavaScriptCase.uppercased(JavaScriptWhitespace.trim(accountNumber))
        _ = normalized
        if let _ = try session.row(
            "SELECT id FROM recipient_bank_accounts WHERE account_number = ?", [.text(normalized)]) {
            return
        }
        let existingAccounts = try session.rows(
            "SELECT id FROM recipient_bank_accounts WHERE recipient_id = ?", [.integer(recipientId)])
        let willBePrimary = existingAccounts.isEmpty
        if willBePrimary {
            _ = try session.rows(
                "UPDATE recipient_bank_accounts SET is_primary = 0, updated_at = now() " +
                    "WHERE recipient_id = ? AND is_primary = 1",
                [.integer(recipientId)])
        }
        _ = try session.rows(
            "INSERT INTO recipient_bank_accounts (recipient_id, account_number, is_primary, is_active) VALUES (?, ?, ?, 1)",
            [.integer(recipientId), .text(normalized), .integer(willBePrimary ? 1 : 0)])
    }

    /// `importCategoryRowsBatched`.
    static func importCategoryRowsBatched(
        _ session: BackendSession, _ rows: [CustomCategoryRow], _ results: inout SimpleImportResults
    ) throws {
        var distinct: [String: CategoryPair] = [:]
        var ordered: [CategoryPair] = []
        for row in rows {
            let key = categoryKey(row.general, row.detail)
            if distinct[key] == nil {
                let pair = CategoryPair(general: row.general, detail: row.detail)
                distinct[key] = pair
                ordered.append(pair)
            }
        }
        let resolved = try session.transaction {
            try resolveCategories(session, ordered)
        }
        var counted: Set<String> = []
        for row in rows {
            let key = categoryKey(row.general, row.detail)
            guard let category = resolved[key] else {
                results.errors += 1
                continue
            }
            let firstOccurrence = !counted.contains(key)
            counted.insert(key)
            if category.created && firstOccurrence {
                results.imported += 1
            } else {
                results.skipped += 1
            }
        }
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(NativeOnboardingImportRequest.self) { request in
            try await database.run { session in
                let form = ImportUploadsArea.form(request)
                let file = try ImportUploadsArea.requireFile(
                    try ImportUploadsArea.csvUpload(form.file), stream: false)
                let bankName = try ImportUploadsArea.bankName(
                    form.fields, "Missing required multipart field: bank_name")
                return try ImportUploadsArea.pipelineAnswer {
                    let result = try ImportUploadsArea.runPipeline(
                        session, file: file, adapterName: bankName, customConfig: nil,
                        filename: file.originalName, size: file.size, onProgress: nil)
                    return try ImportUploadsArea.pipelineResult(result)
                }
            }
        }
        backend.serve(ImportCsvCustomRequest.self) { request in
            try await database.run { session in
                let form = ImportUploadsArea.form(request)
                let file = try ImportUploadsArea.requireFile(
                    try ImportUploadsArea.csvUpload(form.file), stream: false)
                let built = try ImportUploadsArea.buildCustomCsvConfig(form.fields)
                return try ImportUploadsArea.pipelineAnswer {
                    let result = try ImportUploadsArea.runPipeline(
                        session, file: file, adapterName: built.adapterName,
                        customConfig: built.config,
                        filename: file.originalName, size: file.size, onProgress: nil)
                    return try ImportUploadsArea.pipelineResult(result)
                }
            }
        }
        backend.serve(ImportRecipientsRequest.self) { request in
            try await database.run { session in
                try ImportUploadsArea.recipients(session, request: request)
            }
        }
        backend.serve(ImportCategoriesRequest.self) { request in
            try await database.run { session in
                try ImportUploadsArea.categories(session, request: request)
            }
        }
        backend.serve(ImportCsvStreamRequest.self) { request in
            try await database.run { session in
                try ImportUploadsArea.stream(session, request: request)
            }
        }
    }
}

/// `POST /api/import/csv/stream` (operationId `importCsvStream`): the SSE route the client
/// calls by path, not through a generated operation.
struct ImportCsvStreamRequest: APIOperation {
    public typealias Response = JSONValue
    public static let operationId = "importCsvStream"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/csv/stream"
    public var path: String { Self.pathTemplate }
    public var queryItems: [URLQueryItem] { [] }
    public func encodedBody() throws -> Data? { nil }
    public var contentType: String { "application/json" }
}

/// JavaScript truthiness of a `JSValue`.
extension JSValue {
    var isFalsy: Bool {
        switch self {
        case .null: return true
        case .bool(let flag): return !flag
        case .number(let value): return value == 0 || value.isNaN
        case .string(let text): return text.isEmpty
        case .array, .object: return false
        }
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

/// The staged identity of the pipeline (`services/importIdentity.ts`): the source-record
/// hash, the versioned fingerprint and the occurrence ordinal.
enum ImportIdentity {
    static let version = 1

    struct Value: Sendable {
        var sourceRecordHash: String?
        var fingerprint: String
        var version: Int
        var occurrence: Int
    }

    /// sha256 hex of the utf-8 text.
    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// `normalizeIdentityText`: NFKC, JS trim, collapsed whitespace, upper case.
    static func normalizeIdentityText(_ text: String) -> String {
        var normalized = JavaScriptWhitespace.trim(text.precomposedStringWithCompatibilityMapping)
        var collapsed = ""
        var inRun = false
        for scalar in normalized.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !inRun { collapsed.append(" ") }
                inRun = true
            } else {
                inRun = false
                collapsed.unicodeScalars.append(scalar)
            }
        }
        return JavaScriptCase.uppercased(collapsed)
    }

    /// `normalizeIdentityDecimal`: the canonical decimal form, or the source text.
    static func normalizeIdentityDecimal(_ text: String) -> String {
        let source = JavaScriptWhitespace.trim(text)
        guard !source.isEmpty else { return "" }
        let scalars = Array(source.unicodeScalars)
        var index = 0
        var sign = ""
        if index < scalars.count, scalars[index] == "+" || scalars[index] == "-" {  // lint:allow string-literal-compare the decimal sign, as the regex reads it
            if scalars[index] == "-" { sign = "-" }  // lint:allow string-literal-compare the decimal sign, as the regex reads it
            index += 1
        }
        var digits = ""
        var hasDigits = false
        while index < scalars.count, (0x30...0x39).contains(scalars[index].value) {
            digits.unicodeScalars.append(scalars[index])
            hasDigits = true
            index += 1
        }
        var fractionDigits = ""
        var hasFraction = false
        if index < scalars.count, scalars[index] == "." {  // lint:allow string-literal-compare the decimal point, as the regex reads it
            hasFraction = true
            index += 1
            while index < scalars.count, (0x30...0x39).contains(scalars[index].value) {
                fractionDigits.unicodeScalars.append(scalars[index])
                index += 1
            }
        }
        guard hasDigits || hasFraction else { return source }
        guard index == scalars.count else { return source }
        if !hasDigits { digits = "0" }
        while digits.count > 1, digits.hasPrefix("0") { digits.removeFirst() }
        while fractionDigits.hasSuffix("0") { fractionDigits.removeLast() }
        if digits == "0" && fractionDigits.isEmpty { return "0" }  // lint:allow string-literal-compare the canonical zero the normalizer returns
        return sign + digits + (fractionDigits.isEmpty ? "" : "." + fractionDigits)
    }

    /// `canonicalTuple([values])`: `JSON.stringify` of the values, null for nil.
    static func canonicalTuple(_ values: [String?]) -> String {
        JSValue.array(values.map { $0.map(JSValue.string) ?? .null }).jsonText
    }

    /// `budgetingIdentityBase` of one row of the validate projection.
    static func budgetingIdentityBase(_ row: ImportUploadsArea.StagedValidateRow) -> (base: String, sourceId: String) {  // lint:allow raw-id the staged source_transaction_id, as budgetingIdentityBase reads it
        let sourceId = normalizeIdentityText(row.sourceId ?? "")
        let bankAccount = normalizeIdentityText(row.bankAccount ?? "")
        var currency = normalizeIdentityText(row.currency ?? "")
        if currency.isEmpty { currency = "EUR" }
        if !sourceId.isEmpty {
            return (
                canonicalTuple(["vision-import", "\(version)", "budgeting", bankAccount, currency, "source-id", sourceId]),
                sourceId
            )
        }
        return (
            canonicalTuple([
                "vision-import", "\(version)", "budgeting", bankAccount, currency, "fields",
                row.txDate ?? "", normalizeIdentityDecimal(amountText(row)),
                normalizeIdentityText(row.recipientAccount ?? ""),
                normalizeIdentityText(row.recipientRaw ?? ""),
                normalizeIdentityText(row.memo ?? ""),
            ]),
            sourceId
        )
    }

    private static func amountText(_ row: ImportUploadsArea.StagedValidateRow) -> String {
        if let text = row.amountText { return text }
        if let number = row.amountNumber { return SQLArguments.javaScriptText(number) }
        return ""
    }

    /// `assignImportIdentities`: rows sharing no source id receive stable occurrence
    /// ordinals per canonical identity.
    static func assignIdentities(rows: [ImportUploadsArea.StagedValidateRow]) -> [Value] {
        var occurrenceByBase: [String: Int] = [:]
        return rows.map { row in
            let base = budgetingIdentityBase(row)
            let occurrence: Int
            if !base.sourceId.isEmpty {
                occurrence = 1
            } else {
                let next = (occurrenceByBase[base.base] ?? 0) + 1
                occurrenceByBase[base.base] = next
                occurrence = next
            }
            return Value(
                sourceRecordHash: row.rawData.map { sha256Hex($0) },
                fingerprint: sha256Hex(canonicalTuple([base.base, "occurrence", String(occurrence)])),
                version: version,
                occurrence: occurrence)
        }
    }
}
