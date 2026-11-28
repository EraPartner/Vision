import Foundation
import VisionNativeCore

/// `routes/portfolioImportRoutes.ts`'s upload half (ADR-270): the two hand-written
/// multipart endpoints that run the portfolio import pipeline — `POST /csv/custom`
/// (one-shot, 202 when review is needed) and `POST /csv/stream` (SSE progress), with
/// the flattened request schema, the brokerage/account guards, the workbook sniff of
/// `uploadSupport.ts`, and the pipeline's stage → validate → match phases.
enum PortfolioImportUploadsArea {
    typealias UploadedFile = ImportUploadsArea.UploadedFile
    typealias PipelineProgress = ImportUploadsArea.PipelineProgress

    /// `portfolioUpload.single("file")`: the fileFilter's message precedes the route checks.
    static func uploadedFile(_ file: UploadedFile?) throws -> UploadedFile? {
        guard let file else { return nil }
        guard PortfolioUpload.isLikelyStatement(name: file.originalName, mimeType: file.mimetype)
        else {
            throw BackendHTTPError.validation(
                "File must be a CSV, XLSX or supported XLS workbook")
        }
        return file
    }

    /// `!req.file`: the portfolio routes' own message.
    static func requireFile(_ file: UploadedFile?) throws -> UploadedFile {
        guard let file else { throw BackendHTTPError.validation("No file uploaded.") }
        return file
    }

    // MARK: - The flattened request schema

    /// `parseTypeMapping`: an object passes through, a JSON string parses, else `{}`.
    static func parseTypeMapping(_ value: JSValue) -> [String: String] {
        var object: JSObject?
        if case .object(let fields) = value {
            object = fields
        } else if case .string(let text) = value, let parsed = JSValue.parse(text),
            case .object(let fields) = parsed
        {
            object = fields
        }
        guard let object else { return [:] }
        var mapping: [String: String] = [:]
        for (key, value) in object.entries {
            mapping[key] = ImportParsersArea.javaScriptText(value)
        }
        return mapping
    }

    /// `portfolioImportConfigSchema`'s parse: the flattened multipart fields into the
    /// batch's stored config JSON, the parser config the adapters read, and the batch
    /// defaults, the issues in the schema's field order.
    struct BuiltConfig {
        var parser: PortfolioParserConfig
        var configJSON: String
        var defaultAssetClass: String
        var defaultType: String
        var adapterName: String
        var includedSymbols: [String]?
        var typeMapping: [String: String]
        var transferDestinationAccount: Int?
        var transferOriginAccount: Int?
    }

    /// The issues of one parse, joined as `bareMessages` does, never returning.
    static func throwIssues(_ issues: [String]) throws -> BuiltConfig {
        throw BackendHTTPError.validation(issues.joined(separator: "; "))
    }

    static func buildConfig(_ fields: JSObject) throws -> BuiltConfig {
        var issues: [String] = []
        func trimOrEmpty(_ name: String) -> String {
            guard case .string(let text)? = fields[name] else { return "" }
            return JavaScriptWhitespace.trim(text)
        }
        func defaulted(_ name: String, _ fallback: String) -> String {
            guard let value = fields[name], !value.isFalsy else { return fallback }
            let text = AccountsArea.looseText(value)
            let trimmed = JavaScriptWhitespace.trim(text)
            return trimmed.isEmpty ? fallback : trimmed
        }

        // date_column: a non-empty trimmed string.
        var dateColumn: String? = nil
        if let value = fields["date_column"], !value.isFalsy {
            let text = AccountsArea.looseText(value)
            let trimmed = JavaScriptWhitespace.trim(text)
            if !trimmed.isEmpty { dateColumn = trimmed }
        }
        if dateColumn == nil { issues.append("date_column is required") }

        let typeColumn = trimOrEmpty("type_column")
        let symbolColumn = trimOrEmpty("symbol_column")
        let nameColumn = trimOrEmpty("name_column")
        let unitsColumn = trimOrEmpty("units_column")
        let priceColumn = trimOrEmpty("price_column")
        let amountColumn = trimOrEmpty("amount_column")
        let feesColumn = trimOrEmpty("fees_column")
        let taxesColumn = trimOrEmpty("taxes_column")
        let currencyColumn = trimOrEmpty("currency_column")
        let fxRateColumn = trimOrEmpty("fx_rate_column")
        let noteColumn = trimOrEmpty("note_column")

        // source_id/source_account: trimmed strings capped at 200, '' stays absent.
        func optionalSourceColumn(_ name: String) -> String? {
            guard let value = fields[name], !value.isFalsy else { return nil }
            guard case .string(let text) = value else {
                issues.append("\(name) must be a string")
                return nil
            }
            let trimmed = JavaScriptWhitespace.trim(text)
            if trimmed.isEmpty { return nil }
            if trimmed.utf16.count > 200 {
                issues.append("Too big: expected string to have <=200 characters")
                return nil
            }
            return trimmed
        }
        let sourceIdColumn = optionalSourceColumn("source_id_column")
        let sourceAccountColumn = optionalSourceColumn("source_account_column")

        // default_asset_class: the enum's one message.
        let validAssetClasses: Set<String> = [
            "stock", "bond", "etf", "fund", "crypto", "metals", "real_estate", "cash", "other",
        ]
        var defaultAssetClass: String? = nil
        if let value = fields["default_asset_class"], !value.isFalsy {
            let text = AccountsArea.looseText(value)
            if validAssetClasses.contains(text) {
                defaultAssetClass = text
            } else {
                issues.append(
                    "default_asset_class is required and must be a valid asset class")
            }
        } else {
            issues.append(
                "default_asset_class is required and must be a valid asset class")
        }

        // default_type: falsy stays absent; a present value must be canonical.
        var defaultType: String? = nil
        if let value = fields["default_type"], !value.isFalsy {
            let text = AccountsArea.looseText(value)
            if PortfolioTypeNormalizer.validTypes.contains(text) {
                defaultType = text
            } else {
                issues.append(
                    "default_type \"\(text)\" is not a valid transaction type")
            }
        }

        // separator: one UTF-16 unit, '' falls back to ','.
        var separator = ","
        if let value = fields["separator"], !value.isFalsy {
            let text = AccountsArea.looseText(value)
            if text.isEmpty {
                separator = ","
            } else if text.utf16.count != 1 {
                issues.append("separator must be a single character")
            } else {
                separator = text
            }
        }

        let dateFormat = defaulted("date_format", "%Y-%m-%d")

        var encoding = "utf-8"
        if let value = fields["encoding"] {
            encoding = ImportParsersArea.normalizeEncoding(value, issues: &issues)
        }

        var numberFormat: JSValue = .string("auto")
        if let value = fields["number_format"], !value.isFalsy {
            guard case .string(let text) = value,
                ["auto", "decimal_dot", "decimal_comma"].contains(text)
            else {
                issues.append(
                    "Invalid option: expected one of \"auto\"|\"decimal_dot\"|\"decimal_comma\"")
            }
            if case .string(let text) = value {
                numberFormat = .string(text)
            }
        }

        // skip_rows: parseInt, NaN reads as 0, negative rejected.
        var skipRows = 0
        if let value = fields["skip_rows"], !value.isFalsy {
            let parsed = parseIntRadix10(AccountsArea.looseText(value))
            skipRows = parsed
            if skipRows < 0 {
                issues.append("skip_rows must be zero or a positive integer")
            }
        }

        var typeMapping: [String: String] = [:]
        if let value = fields["type_mapping"], !value.isFalsy {
            typeMapping = parseTypeMapping(value)
        }

        let adapterName = defaulted("adapter_name", "portfolio_generic")

        func optionalAccountId(_ name: String) -> Int? {
            guard let value = fields[name], value != .null else { return nil }
            if case .string(let text) = value, text.isEmpty { return nil }
            if let id = TransactionsArea.validId(value) {
                return id
            }
            issues.append("\(name) must be a positive integer")
            return nil
        }
        let transferDestinationAccount = optionalAccountId("transfer_destination_account_id")
        let transferOriginAccount = optionalAccountId("transfer_origin_account_id")

        // included_symbols: one comma list, upper-cased, deduplicated, pattern-checked.
        var includedSymbols: [String]? = nil
        if let value = fields["included_symbols"], !value.isFalsy {
            guard case .string(let text) = value else {
                issues.append("Invalid input: expected string, received \(value.zodTypeName)")
                return try throwIssues(issues)
            }
            let trimmed = JavaScriptWhitespace.trim(text)
            if trimmed.isEmpty {
                issues.append("Too small: expected string to have >=1 characters")
            } else if trimmed.utf16.count > 500 {
                issues.append("Too big: expected string to have <=500 characters")
            } else {
                var symbols: [String] = []
                for symbol in trimmed.split(separator: ",", omittingEmptySubsequences: false) {
                    symbols.append(
                        JavaScriptWhitespace.trim(String(symbol)).uppercased())
                }
                var unique: [String] = []
                for symbol in symbols where !unique.contains(symbol) {
                    unique.append(symbol)
                }
                if unique.count > 30 {
                    issues.append("Too big: expected array to have <=30 items")
                }
                for symbol in unique {
                    if !symbolMatchesPattern(symbol) {
                        issues.append(
                            "Invalid string: must match pattern /^[A-Z0-9][A-Z0-9._-]{0,29}$/")
                        break
                    }
                }
                if issues.isEmpty { includedSymbols = unique }
            }
        }

        var yieldBasisPolicy = false
        if let value = fields["yield_basis_policy"], !value.isFalsy {
            if case .string(let text) = value, text == "zero" {  // lint:allow string-literal-compare the yield_basis_policy literal the schema accepts
                yieldBasisPolicy = true
            } else {
                issues.append("Invalid input: expected \"zero\"")
            }
        }

        var format: PortfolioParserConfig.Format? = nil
        if let value = fields["portfolio_format"], !value.isFalsy {
            let text = AccountsArea.looseText(value)
            if let parsed = PortfolioParserConfig.Format(rawValue: text) {
                format = parsed
            } else {
                issues.append("portfolio_format must be a supported portfolio format")
            }
        }

        if issues.isEmpty, symbolColumn.isEmpty, nameColumn.isEmpty {
            issues.append("map at least one of symbol_column or name_column")
        }
        if !issues.isEmpty { return try throwIssues(issues) }

        var parser = PortfolioParserConfig()
        parser.format = format
        parser.dateFormat = dateFormat
        parser.separator = separator
        parser.skipRows = skipRows
        parser.encoding = encoding
        parser.numberFormat = numberFormat
        parser.zeroYieldBasis = yieldBasisPolicy
        parser.transferOriginAccount = transferOriginAccount.map(Double.init)
        parser.columns = PortfolioParserConfig.Columns(
            date: dateColumn,
            type: typeColumn,
            symbol: symbolColumn,
            name: nameColumn,
            units: unitsColumn,
            price: priceColumn,
            amount: amountColumn,
            fees: feesColumn,
            taxes: taxesColumn,
            currency: currencyColumn,
            fxRate: fxRateColumn,
            note: noteColumn,
            sourceAccount: sourceAccountColumn,
            sourceReference: sourceIdColumn)

        // The stored config JSON, in the TypeScript transform's key order.
        var config = JSObject()
        config["date_format"] = .string(dateFormat)
        config["separator"] = .string(separator)
        config["encoding"] = .string(encoding)
        config["number_format"] = numberFormat
        config["skip_rows"] = .number(Double(skipRows))
        config["default_asset_class"] = .string(defaultAssetClass ?? "")
        config["default_type"] = .string(defaultType ?? "buy")
        var mapping = JSObject()
        for (key, value) in typeMapping.sorted(by: { $0.key < $1.key }) {
            mapping[key] = .string(value)
        }
        config["type_mapping"] = .object(mapping)
        if let transferDestinationAccount {
            config["transfer_destination_account_id"] = .number(Double(transferDestinationAccount))
        }
        if let transferOriginAccount {
            config["transfer_origin_account_id"] = .number(Double(transferOriginAccount))
        }
        if let includedSymbols {
            config["included_symbols"] = .array(includedSymbols.map { JSValue.string($0) })
        }
        if yieldBasisPolicy {
            config["yield_basis_policy"] = .string("zero")
        }
        if let format {
            config["format"] = .string(format.rawValue)
        }
        config["column_mapping"] = .object(columnMappingObject(
            dateColumn, typeColumn, symbolColumn, nameColumn, unitsColumn, priceColumn,
            amountColumn, feesColumn, taxesColumn, currencyColumn, fxRateColumn, noteColumn,
            sourceIdColumn, sourceAccountColumn))

        return BuiltConfig(
            parser: parser,
            configJSON: JSValue.object(config).jsonText,
            defaultAssetClass: defaultAssetClass ?? "",
            defaultType: defaultType ?? "buy",
            adapterName: adapterName,
            includedSymbols: includedSymbols,
            typeMapping: typeMapping,
            transferDestinationAccount: transferDestinationAccount,
            transferOriginAccount: transferOriginAccount)
    }

    /// `/^[A-Z0-9][A-Z0-9._-]{0,29}$/` of the included_symbols array.
    static func symbolMatchesPattern(_ symbol: String) -> Bool {
        var scalars = Array(symbol.unicodeScalars)
        guard !scalars.isEmpty, scalars.count <= 30 else { return false }
        let first = scalars.removeFirst()
        guard (48...57).contains(first.value) || (65...90).contains(first.value) else { return false }
        return scalars.allSatisfy { scalar in
            (48...57).contains(scalar.value) || (65...90).contains(scalar.value)
                || scalar == "." || scalar == "_" || scalar == "-" // lint:allow string-literal-compare the pattern's symbol characters
        }
    }

    /// `parseInt(String(value), 10)`: the leading integer run, NaN reads as 0.
    static func parseIntRadix10(_ text: String) -> Int {
        let trimmed = JavaScriptWhitespace.trim(text)
        var digits = ""
        var index = trimmed.startIndex
        if index < trimmed.endIndex, trimmed[index] == "+" || trimmed[index] == "-" { // lint:allow string-literal-compare parseInt's sign characters
            digits.append(trimmed[index])
            index = trimmed.index(after: index)
        }
        while index < trimmed.endIndex, trimmed[index].isNumber, trimmed[index].isASCII {
            digits.append(trimmed[index])
            index = trimmed.index(after: index)
        }
        guard let value = Int(digits) else { return 0 }
        return value
    }

    /// `column_mapping`, in the TypeScript transform's key order.
    static func columnMappingObject(
        _ date: String?, _ type: String?, _ symbol: String?, _ name: String?,
        _ units: String?, _ price: String?, _ amount: String?, _ fees: String?,
        _ taxes: String?, _ currency: String?, _ fxRate: String?, _ note: String?,
        _ sourceId: String?, _ sourceAccount: String?  // lint:allow raw-id the column names the mapping records
    ) -> JSObject {
        var object = JSObject()
        func put(_ key: String, _ value: String?) {
            object[key] = value.map { JSValue.string($0) } ?? .null
        }
        put("date", date)
        put("type", type)
        put("symbol", symbol)
        put("name", name)
        put("units", units)
        put("price", price)
        put("amount", amount)
        put("fees", fees)
        put("taxes", taxes)
        put("currency", currency)
        put("fx_rate", fxRate)
        put("note", note)
        put("source_id", sourceId)
        put("source_account", sourceAccount)
        return object
    }

    // MARK: - Brokerage parameters and account guards

    /// `brokerageParamsSchema`: the flag coerced from multipart text, the account id
    /// through `validateId`, and the sleeve requirement.
    static func brokerageParams(_ fields: JSObject) throws -> (isBrokerage: Bool, accountId: Int?) {  // lint:allow raw-id the sleeve account the request names
        var isBrokerage = false
        if let value = fields["is_brokerage"] {
            if case .bool(let flag) = value { isBrokerage = flag }
            if case .string(let text) = value, text == "true" {  // lint:allow string-literal-compare the multipart flag the schema coerces
                isBrokerage = true
            }
        }
        var accountId: Int? = nil  // lint:allow raw-id the sleeve account the request names
        var issues: [String] = []
        if let value = fields["account_id"], value != .null, !value.isFalsy {
            if case .string(let text) = value, text.isEmpty {
                // '' is undefined for the optional account id field.
            } else if let id = TransactionsArea.validId(value) {
                accountId = id
            } else {
                issues.append("account_id must be a positive integer")
            }
        }
        if isBrokerage, accountId == nil {
            issues.append(
                "A brokerage import requires account_id (the sleeve cash + trades land on)")
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return (isBrokerage, accountId)
    }

    /// `assertPortfolioFormatBrokerage`: a maintained transaction-history format names
    /// its broker; both halves of the routing contract must be present.
    static func assertFormatBrokerage(
        _ format: PortfolioParserConfig.Format?, _ brokerage: (isBrokerage: Bool, accountId: Int?)  // lint:allow raw-id the sleeve account the format requires
    ) throws {
        let formatNames: [String: String] = [
            "ibkr_transaction_history": "IBKR",
            "ibkr_funding_history": "IBKR",
            "kinesis_transaction_history": "Kinesis",
            "nexo_transaction_history": "Nexo",
            "nexo_pro_spot_history": "Nexo Pro Spot",
            "saxo_transaction_history": "Saxo",
        ]
        guard let format, let name = formatNames[format.rawValue],
            !brokerage.isBrokerage || brokerage.accountId == nil
        else { return }
        throw BackendHTTPError.validation(
            "\(name) Transaction History requires is_brokerage=true and account_id")
    }

    // MARK: - Upload support

    /// `assertPortfolioUploadSupported`: the workbook sniff, before any batch is made.
    static func assertUploadSupported(
        _ bytes: [UInt8], _ format: PortfolioParserConfig.Format?
    ) throws {
        if format == .ibkrFundingHistory {
            throw BackendHTTPError(
                status: 500, code: "INTERNAL_SERVER_ERROR",
                message: "IBKR funding workbooks are not read by the Swift backend yet")
        }
        let detected = PortfolioUpload.format(of: bytes)
        if detected == .csv { return }
        if detected != .xlsx || format != .saxoTransactionHistory {
            throw BackendHTTPError.validation(
                "Portfolio workbooks require supported Saxo XLSX transaction history"
                    + " or IBKR XLS/XLSX funding history")
        }
        _ = try SaxoStatement.parseWorkbook(bytes)
    }

    // MARK: - The pipeline: create + stage

    /// `createBatch` of `stage.ts`: the pending batch row, its id as a number.
    static func createBatch(
        _ session: BackendSession, adapterName: String, filename: String?, size: Int?,  // lint:allow raw-id the batch the pipeline creates
        configJSON: String, defaultAssetClass: String?, defaultType: String?,
        isBrokerage: Bool, accountId: Int?  // lint:allow raw-id the sleeve account the batch stamps
    ) throws -> Int {
        let inserted = try session.row(
            """
            INSERT INTO portfolio_import_batches
                 (adapter_name, source_filename, source_size_bytes, custom_config,
                  default_asset_class, default_type, is_brokerage, account_id, status, started_at)
             VALUES (?, ?, ?, vision_jsonb(?), ?, ?, ?, ?, 'pending', now())
             RETURNING id
            """,
            [.text(adapterName),
             filename.map { SQLValue.text($0) } ?? .null,
             size.map { SQLValue.integer(Int64($0)) } ?? .null,
             .text(configJSON),
             defaultAssetClass.map { SQLValue.text($0) } ?? .null,
             defaultType.map { SQLValue.text($0) } ?? .null,
             .integer(isBrokerage ? 1 : 0),
             accountId.map { SQLValue.integer(Int64($0)) } ?? .null])
        guard let id = try inserted?.optionalInt64("id") else {
            throw PortfolioImportReconciliationArea.RequiredValueError(
                message: "INSERT ... RETURNING without ON CONFLICT yields exactly one row")
        }
        return Int(id)
    }

    /// `stageBatch`: parse the file, scope it, bulk-insert the staged rows.
    static func stageBatch(
        _ session: BackendSession, batchId: Int, file: UploadedFile, built: BuiltConfig  // lint:allow raw-id the staged batch the phase writes
    ) throws -> (rowsTotal: Int, rowsSkipped: Int) {
        _ = try session.row(
            "UPDATE portfolio_import_batches SET status = 'staging' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        if built.parser.format == .ibkrFundingHistory, built.includedSymbols != nil {
            throw PortfolioImportReconciliationArea.RequiredValueError(
                message: "IBKR funding history cannot be filtered by investment symbol")
        }
        let parsed = try PortfolioAdapters.parse(file.bytes, built.parser)
        let rows = try applyAssetScope(parsed, built.includedSymbols)
        if built.includedSymbols != nil {
            try mergeBatchConfig(
                session, batchId, key: "scope_excluded_rows",
                value: .int(parsed.rows.count - rows.rows.count))
        }
        if let sourceColumns = rows.sourceColumns {
            try mergeBatchConfig(
                session, batchId, key: "source_columns",
                value: .array(sourceColumns.map { JSONValue.string($0) }))
        }
        let total = rows.rows.count
        _ = try session.row(
            "UPDATE portfolio_import_batches SET rows_total = ? WHERE id = ? RETURNING id",
            [.integer(Int64(total)), .integer(Int64(batchId))])
        var start = 0
        while start < total {
            let end = min(start + 500, total)
            try session.transaction {
                try insertStagingChunk(
                    session, batchId: batchId, rows: Array(rows.rows[start..<end]),
                    startIndex: start)
            }
            start = end
        }
        return (total, parsed.skipped ?? 0)
    }

    /// `mergeBatchConfig`: one key merged into the stored config.
    static func mergeBatchConfig(
        _ session: BackendSession, _ batchId: Int, key: String, value: JSONValue  // lint:allow raw-id the staged batch the phase writes
    ) throws {
        _ = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET custom_config = vision_jsonb(json_set(COALESCE(custom_config, '{}'), ?, ?))
             WHERE id = ?
            """,
            [.text("$.\(key)"), .text(String(decoding: try JSONEncoder().encode(value), as: UTF8.self)), .integer(Int64(batchId))])
    }

    /// `applyPortfolioAssetScope`: the selected symbols' rows, their cash legs, and the
    /// recorded error for a symbol the statement does not carry.
    static func applyAssetScope(
        _ parsed: ParsedPortfolioRows, _ symbols: [String]?
    ) throws -> ParsedPortfolioRows {
        guard let symbols, !symbols.isEmpty else { return parsed }
        let selected = Set(symbols)
        var found = Set<String>()
        for row in parsed.rows {
            let symbol = row.symbolRaw.uppercased()
            if !symbol.isEmpty { found.insert(symbol) }
        }
        for symbol in selected where !found.contains(symbol) {
            throw PortfolioImportReconciliationArea.RequiredValueError(
                message: "Selected asset \(symbol) is absent from the statement")
        }
        let records = Set(parsed.rows.filter { selected.contains($0.symbolRaw.uppercased()) }
            .map { $0.rawData })
        let scoped = parsed.rows.filter { row in
            selected.contains(row.symbolRaw.uppercased())
                || (row.symbolRaw.isEmpty && records.contains(row.rawData))
        }
        return ParsedPortfolioRows(
            rows: scoped, skipped: parsed.skipped, sourceColumns: parsed.sourceColumns)
    }

    /// `insertStagingChunk`: one multi-VALUES statement, the columns in the source's order.
    static func insertStagingChunk(
        _ session: BackendSession, batchId: Int, rows: [ParsedPortfolioRow], startIndex: Int  // lint:allow raw-id the staged batch the phase writes
    ) throws {
        guard !rows.isEmpty else { return }
        var sql =
            "INSERT INTO portfolio_import_staging_rows (batch_id, row_index, tx_date, type_raw, " +
            "symbol_raw, name_raw, units, price_per_unit, amount, fees, taxes, currency, " +
            "fx_rate_to_eur, note, raw_data, source_transaction_id, source_account_identity, " +
            "asset_transfer_details, asset_adjustment_details) VALUES "
        var arguments: [SQLValue] = []
        var first = true
        for (index, row) in rows.enumerated() {
            if !first { sql += ", " }
            first = false
            // batch_id, row_index, tx_date, type_raw, symbol_raw, name_raw, units, price,
            // amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data, source refs,
            // then the two details columns.
            var placeholders: [String] = Array(repeating: "?", count: 18)
            placeholders[6] = "vision_numeric(?, 18, 8)"
            placeholders[7] = "vision_numeric(?, 18, 6)"
            placeholders[8] = "vision_numeric(?, 18, 4)"
            placeholders[9] = "vision_numeric(?, 18, 4)"
            placeholders[10] = "vision_numeric(?, 18, 4)"
            placeholders[12] = "vision_numeric(?, 20, 10)"
            sql += "(" + placeholders.joined(separator: ", ") + ", ?)"
            arguments.append(.integer(Int64(batchId)))
            arguments.append(.integer(Int64(startIndex + index)))
            arguments.append(row.day.map { SQLValue.text(ImportUploadsArea.ymd(day: $0)) } ?? .null)
            arguments.append(row.typeRaw.isEmpty ? .null : .text(row.typeRaw))
            arguments.append(row.symbolRaw.isEmpty ? .null : .text(row.symbolRaw))
            arguments.append(row.nameRaw.isEmpty ? .null : .text(row.nameRaw))
            arguments.append(numberValue(row.units))
            arguments.append(numberValue(row.pricePerUnit))
            arguments.append(numberValue(row.amount))
            arguments.append(numberValue(row.fees))
            arguments.append(numberValue(row.taxes))
            arguments.append(row.currency.map { SQLValue.text($0) } ?? .null)
            arguments.append(numberValue(row.fxRateToEur))
            arguments.append(row.note.isEmpty ? .null : .text(row.note))
            arguments.append(row.rawData.isEmpty ? .null : .text(row.rawData))
            arguments.append(row.sourceReference.map { SQLValue.text($0) } ?? .null)
            arguments.append(row.sourceAccountIdentity.map { SQLValue.text($0) } ?? .null)
            arguments.append(detailsValue(row.assetTransfer))
            arguments.append(detailsValue(row.assetAdjustment))
        }
        _ = try session.rows(sql, arguments)
    }

    /// A parsed numeric as the staged column's decimal text.
    static func numberValue(_ value: Double?) -> SQLValue {
        guard let value else { return .null }
        return .text(SQLArguments.javaScriptText(value))
    }

    /// `json(value)`: the transfer details JSON text, or NULL when absent.
    static func detailsValue(_ details: ParsedPortfolioRow.AssetTransfer?) -> SQLValue {
        guard let details else { return .null }
        var object = JSObject([
            ("direction", .string(details.direction.rawValue)),
            ("basisStatus", .string(details.basisStatus.rawValue)),
        ])
        if let fee = details.feeUnits { object["feeUnits"] = .string(fee) }
        if let received = details.receivedUnits { object["receivedUnits"] = .string(received) }
        return .text(JSValue.object(object).jsonText)
    }

    /// `json(value)`: the adjustment details JSON text, or NULL when absent.
    static func detailsValue(_ details: ParsedPortfolioRow.AssetAdjustment?) -> SQLValue {
        guard let details else { return .null }
        return .text(JSValue.object(JSObject([
            ("kind", .string(details.kind.rawValue)),
            ("basisPolicy", .string(details.basisPolicy.rawValue)),
        ])).jsonText)
    }

    // MARK: - The pipeline: validate

    /// One pending staging row of the validate projection.
    struct StagedPendingRow: Sendable {
        var id: Int64  // lint:allow raw-id the staged rows the phase marks
        var status: String
        var txDate: String?
        var typeRaw: String?
        var symbolRaw: String?
        var nameRaw: String?
        var units: String?
        var pricePerUnit: String?
        var amount: String?
        var fees: String?
        var taxes: String?
        var currency: String?
        var note: String?
        var rawData: String?
        var sourceReference: String?
        var sourceAccountIdentity: String?
        var transferDirection: String?
        var adjustmentKind: String?
    }

    /// One row's type/route resolution.
    struct RowResolution: Sendable {
        var type: String?
        var route: String?
        var error: String?
    }

    /// `validateBatch`: normalize each pending row's type, pre-check its numbers, and
    /// stamp its identity, in 500-row JSON-array chunks.
    static func validateBatch(
        _ session: BackendSession, batchId: Int, typeMapping: [String: String]  // lint:allow raw-id the staged batch the phase validates
    ) throws -> (validated: Int, duplicates: Int, errors: Int) {
        _ = try session.row(
            "UPDATE portfolio_import_batches SET status = 'validating' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        let batch = try session.row(
            """
            SELECT b.default_asset_class, b.default_type, b.is_brokerage,
                   a.import_identity AS account_import_identity
              FROM portfolio_import_batches b
              LEFT JOIN accounts a ON a.id = b.account_id
             WHERE b.id = ?
            """,
            [.integer(Int64(batchId))])
        let defaultAssetClass = try batch?.optionalText("default_asset_class")
        let defaultType = try batch?.optionalText("default_type")
        let isBrokerage = (try batch?.optionalInt64("is_brokerage") ?? 0) != 0
        let accountIdentity = try batch?.optionalText("account_import_identity") ?? "UNASSIGNED"
        let unitBased = defaultAssetClass.map {
            PortfolioTransactionsArea.unitBasedAssetClasses.contains($0)
        } ?? false

        let rows = try session.rows(
            """
            SELECT id, status, to_char(tx_date, 'YYYY-MM-DD') AS tx_date, type_raw, symbol_raw,
                   name_raw, units, price_per_unit, amount, fees, taxes, currency, note,
                   raw_data, source_transaction_id, source_account_identity,
                   asset_transfer_details, asset_adjustment_details
              FROM portfolio_import_staging_rows
             WHERE batch_id = ?
             ORDER BY row_index
            """,
            [.integer(Int64(batchId))])
        let all: [StagedPendingRow] = try rows.map { row in
            StagedPendingRow(
                id: try row.int64("id"),
                status: try row.text("status"),
                txDate: try row.optionalText("tx_date"),
                typeRaw: try row.optionalText("type_raw"),
                symbolRaw: try row.optionalText("symbol_raw"),
                nameRaw: try row.optionalText("name_raw"),
                units: try row.optionalText("units"),
                pricePerUnit: try row.optionalText("price_per_unit"),
                amount: try row.optionalText("amount"),
                fees: try row.optionalText("fees"),
                taxes: try row.optionalText("taxes"),
                currency: try row.optionalText("currency"),
                note: try row.optionalText("note"),
                rawData: try row.optionalText("raw_data"),
                sourceReference: try row.optionalText("source_transaction_id"),
                sourceAccountIdentity: try row.optionalText("source_account_identity"),
                transferDirection: try PortfolioImportReconciliationArea.jsonObject(
                    row, "asset_transfer_details")?["direction"]?.stringValue,
                adjustmentKind: try PortfolioImportReconciliationArea.jsonObject(
                    row, "asset_adjustment_details")?["kind"]?.stringValue)
        }
        let today = session.today()
        let pending = all.filter { $0.status == "pending" }  // lint:allow string-literal-compare the staged row statuses the phase reads
        let total = pending.count

        var identityById: [Int64: ImportIdentity.Value] = [:]
        var occurrenceByBase: [String: Int] = [:]
        for row in all {
            let resolution = resolveAndCheck(
                row,
                typeMapping: typeMapping, defaultType: defaultType, unitBased: unitBased,
                isBrokerage: isBrokerage, today: today)
            let base = portfolioIdentityBase(row, resolution: resolution, accountIdentity: accountIdentity)
            let occurrence: Int
            if !base.sourceId.isEmpty {
                occurrence = 1
            } else {
                let next = (occurrenceByBase[base.base] ?? 0) + 1
                occurrenceByBase[base.base] = next
                occurrence = next
            }
            identityById[row.id] = ImportIdentity.Value(
                sourceRecordHash: row.rawData.map { ImportIdentity.sha256Hex($0) },
                fingerprint: ImportIdentity.sha256Hex(
                    ImportIdentity.canonicalTuple([.string(base.base), .string("occurrence"), .number(Double(occurrence))])),
                version: ImportIdentity.version,
                occurrence: occurrence)
        }

        var errors = 0
        for start in stride(from: 0, to: total, by: 500) {
            let chunk = pending[start..<min(start + 500, total)]
            var updates: [JSValue] = []
            for row in chunk {
                guard let identity = identityById[row.id] else {
                    throw PortfolioImportReconciliationArea.RequiredValueError(
                        message: "identityById holds every staging row of the batch")
                }
                let resolution = resolveAndCheck(
                    row,
                    typeMapping: typeMapping, defaultType: defaultType, unitBased: unitBased,
                    isBrokerage: isBrokerage, today: today)
                if let error = resolution.error {
                    errors += 1
                    updates.append(.object(JSObject([
                        ("id", .int(Int(row.id))),
                        ("status", .string("error")),
                        ("type", .null),
                        ("route", .null),
                        ("fingerprint", .null),
                        ("source_record_hash", identity.sourceRecordHash
                            .map { JSValue.string($0) } ?? .null),
                        ("fingerprint_version", .null),
                        ("occurrence", .null),
                        ("error_message", .string(error)),
                    ])))
                    continue
                }
                updates.append(.object(JSObject([
                    ("id", .int(Int(row.id))),
                    ("status", .string("validated")),
                    ("type", resolution.type.map { JSValue.string($0) } ?? .null),
                    ("route", resolution.route.map { JSValue.string($0) } ?? .null),
                    ("fingerprint", .string(identity.fingerprint)),
                    ("source_record_hash", identity.sourceRecordHash
                        .map { JSValue.string($0) } ?? .null),
                    ("fingerprint_version", .int(identity.version)),
                    ("occurrence", .int(identity.occurrence)),
                    ("error_message", .null),
                ])))
            }
            _ = try session.rows(
                """
                WITH v AS (
                    SELECT CAST(value ->> 'id' AS INTEGER) AS id,
                           value ->> 'status' AS status,
                           value ->> 'type' AS type,
                           value ->> 'route' AS route,
                           value ->> 'fingerprint' AS fingerprint,
                           value ->> 'source_record_hash' AS source_record_hash,
                           CAST(value ->> 'fingerprint_version' AS INTEGER) AS fingerprint_version,
                           CAST(value ->> 'occurrence' AS INTEGER) AS occurrence,
                           value ->> 'error_message' AS error_message
                      FROM json_each(?)
                )
                UPDATE portfolio_import_staging_rows
                   SET status = v.status,
                       type = v.type,
                       route = v.route,
                       source_record_hash = v.source_record_hash,
                       dedup_fingerprint = v.fingerprint,
                       dedup_fingerprint_version = v.fingerprint_version,
                       dedup_occurrence = v.occurrence,
                       error_message = v.error_message
                  FROM v
                 WHERE portfolio_import_staging_rows.id = v.id
                """,
                [.text(JSValue.array(updates).jsonText)])
        }
        if errors > 0 {
            _ = try session.rows(
                "UPDATE portfolio_import_batches SET rows_error = COALESCE(rows_error, 0) + ? WHERE id = ?",
                [.integer(Int64(errors)), .integer(Int64(batchId))])
        }
        return (total - errors, 0, errors)
    }

    /// `resolveAndCheck`: one staging row's canonical type and brokerage route.
    static func resolveAndCheck(
        _ row: StagedPendingRow,
        typeMapping: [String: String], defaultType: String?, unitBased: Bool,
        isBrokerage: Bool, today: String
    ) -> RowResolution {
        guard let txDate = row.txDate, !txDate.isEmpty else {
            return RowResolution(type: nil, route: nil, error: "missing date")
        }
        if !today.isEmpty, txDate > today {
            return RowResolution(type: nil, route: nil, error: "transaction date is in the future")
        }
        if row.typeRaw == "AssetAdjustment",  // lint:allow string-literal-compare the staged custody label, as the TypeScript phase reads it
            row.adjustmentKind == "yield_reversal" // lint:allow string-literal-compare the staged adjustment detail kinds
                || row.adjustmentKind == "asset_fee" // lint:allow string-literal-compare the staged adjustment detail kinds
        {
            if (row.symbolRaw ?? "").isEmpty || !positiveUnits(row.units) {
                return RowResolution(
                    type: nil, route: nil,
                    error: "asset adjustment requires an instrument and positive units")
            }
            return RowResolution(type: nil, route: "asset_adjustment", error: nil)
        }
        if row.typeRaw == "AssetTransfer",  // lint:allow string-literal-compare the staged custody label, as the TypeScript phase reads it
            row.transferDirection == "in" || row.transferDirection == "out" // lint:allow string-literal-compare the staged transfer directions
        {
            if (row.symbolRaw ?? "").isEmpty || !positiveUnits(row.units) {
                return RowResolution(
                    type: nil, route: nil,
                    error: "asset transfer requires an instrument and positive units")
            }
            return RowResolution(type: nil, route: "asset_transfer", error: nil)
        }
        if row.typeRaw == "InternalMovement", row.transferDirection == "internal" {  // lint:allow string-literal-compare the staged custody label, as the TypeScript phase reads it
            return RowResolution(type: nil, route: "account_internal", error: nil)
        }

        let normalized = PortfolioTypeNormalizer.normalize(
            row.typeRaw, mapping: typeMapping, defaultType: defaultType)
        switch normalized {
        case .error(let message):
            if isBrokerage, classifyCashTarget(kind: row.typeRaw, hasInstrument: nil) == "cash" { // lint:allow string-literal-compare the routing target the D6 branch dispatches on
                if row.amount == nil {
                    return RowResolution(type: nil, route: nil, error: "cash row requires an amount")
                }
                return RowResolution(type: nil, route: "cash", error: nil)
            }
            return RowResolution(type: nil, route: nil, error: message)
        case .type(let type):
            let hasUnits = row.units != nil
            let hasPrice = row.pricePerUnit != nil
            let hasAmount = row.amount != nil
            if (type == "buy" || type == "sell") && unitBased {  // lint:allow string-literal-compare the stored wire value the TypeScript phase dispatches on
                if (hasUnits ? 1 : 0) + (hasPrice ? 1 : 0) + (hasAmount ? 1 : 0) < 2 {
                    return RowResolution(
                        type: nil, route: nil,
                        error: "provide at least two of units, price, amount")
                }
            } else if type == "gift" {  // lint:allow string-literal-compare the stored wire value the TypeScript phase dispatches on
                if !hasUnits {
                    return RowResolution(type: nil, route: nil, error: "gift requires units")
                }
            } else if !hasAmount {
                return RowResolution(type: nil, route: nil, error: "missing amount")
            }
            if isBrokerage {
                let hasInstrument =
                    !(row.symbolRaw ?? "").isEmpty || !(row.nameRaw ?? "").isEmpty
                if classifyCashTarget(kind: type, hasInstrument: hasInstrument) == "cash" { // lint:allow string-literal-compare the routing target the D6 branch dispatches on
                    return RowResolution(type: type, route: "cash", error: nil)
                }
                return RowResolution(type: type, route: "portfolio", error: nil)
            }
            return RowResolution(type: type, route: nil, error: nil)
        }
    }

    /// `toDecimal(row.units || 0).gt(0)`: a staged magnitude is positive.
    static func positiveUnits(_ text: String?) -> Bool {
        (try? DecimalJS.from(text ?? "0").gt(DecimalJS.zero)) ?? false
    }

    /// `classifyBrokerageRow`'s target: the row's ledger.
    static func classifyCashTarget(kind rawKind: String?, hasInstrument: Bool?) -> String {
        let kind = JavaScriptWhitespace.trim((rawKind ?? "").lowercased())
        let cashInflowKinds: Set<String> = [
            "deposit", "deposits", "cash deposit", "transfer in", "storting", "inleg",
            "terugbetaling", "einzahlung",
        ]
        let cashOutflowKinds: Set<String> = [
            "withdrawal", "withdrawals", "cash withdrawal", "transfer out", "opname", "auszahlung",
        ]
        let portfolioKinds: Set<String> = ["buy", "sell", "dividend", "interest", "fee", "tax"]
        if cashInflowKinds.contains(kind) || cashOutflowKinds.contains(kind) {
            return "cash"
        }
        if portfolioKinds.contains(kind) {
            if hasInstrument == false {
                if ["dividend", "interest"].contains(kind) { return "cash" }
                if ["fee", "tax"].contains(kind) { return "cash" }
            }
            return "portfolio"
        }
        return "review"
    }

    /// `portfolioIdentityBase`: the canonical identity tuple of one staged row.
    static func portfolioIdentityBase(
        _ row: StagedPendingRow, resolution: RowResolution, accountIdentity: String
    ) -> (base: String, sourceId: String) {  // lint:allow raw-id the staged source_transaction_id, as portfolioIdentityBase reads it
        let sourceId = ImportIdentity.normalizeIdentityText(row.sourceReference ?? "")
        let route = ImportIdentity.normalizeIdentityText(resolution.route ?? "")
        var currency = ImportIdentity.normalizeIdentityText(row.currency ?? "")
        if currency.isEmpty { currency = "EUR" }
        let account = ImportIdentity.normalizeIdentityText(row.sourceAccountIdentity ?? "")
        let prefix: [JSValue] = [
            .string("vision-import"), .number(Double(ImportIdentity.version)), .string("portfolio"),
            .string(route.isEmpty ? "PORTFOLIO" : route),
            .string(account.isEmpty ? ImportIdentity.normalizeIdentityText(accountIdentity) : account),
            .string(currency),
        ]
        if !sourceId.isEmpty {
            return (
                ImportIdentity.canonicalTuple(prefix + [.string("source-id"), .string(sourceId)]),
                sourceId)
        }
        return (
            ImportIdentity.canonicalTuple(prefix + [
                .string("fields"), .string(row.txDate ?? ""),
                .string(ImportIdentity.normalizeIdentityText(resolution.type ?? "")),
                .string(ImportIdentity.normalizeIdentityText(row.symbolRaw ?? "")),
                .string(ImportIdentity.normalizeIdentityText(row.nameRaw ?? "")),
                .string(ImportIdentity.normalizeIdentityDecimal(row.units ?? "")),
                .string(ImportIdentity.normalizeIdentityDecimal(row.pricePerUnit ?? "")),
                .string(ImportIdentity.normalizeIdentityDecimal(row.amount ?? "")),
                .string(ImportIdentity.normalizeIdentityDecimal(row.fees ?? "")),
                .string(ImportIdentity.normalizeIdentityDecimal(row.taxes ?? "")),
                .string(ImportIdentity.normalizeIdentityText(row.note ?? "")),
            ]),
            "")
    }

    // MARK: - The pipeline: match

    /// `matchBatch`: resolve each validated row to an investment by unambiguous symbol,
    /// provider alias, then exact name.
    static func matchBatch(
        _ session: BackendSession, batchId: Int  // lint:allow raw-id the staged batch the phase matches
    ) throws -> (matchSourceCounts: [String: Int], unresolved: Int, total: Int) {
        _ = try session.row(
            "UPDATE portfolio_import_batches SET status = 'matching' WHERE id = ? RETURNING id",
            [.integer(Int64(batchId))])
        _ = try session.rows(
            """
            UPDATE portfolio_import_staging_rows SET status = 'matched'
             WHERE batch_id = ? AND status = 'validated'
               AND route IN ('cash', 'account_internal')
            """,
            [.integer(Int64(batchId))])
        let rows = try session.rows(
            """
            SELECT id, symbol_raw, name_raw FROM portfolio_import_staging_rows
             WHERE batch_id = ? AND status = 'validated'
               AND (route IS NULL OR route NOT IN ('cash', 'account_internal'))
             ORDER BY row_index
            """,
            [.integer(Int64(batchId))])
        struct MatchRow {
            var id: Int64  // lint:allow raw-id the staged rows the phase resolves
            var symbol: String?
            var name: String?
        }
        let pending: [MatchRow] = try rows.map {
            MatchRow(id: try $0.int64("id"), symbol: try $0.optionalText("symbol_raw"),
                     name: try $0.optionalText("name_raw"))
        }
        let total = pending.count

        var symbols = Set<String>()
        for row in pending {
            let symbol = JavaScriptWhitespace.trim(row.symbol ?? "").lowercased()
            if !symbol.isEmpty { symbols.insert(symbol) }
        }
        var symbolMatches: [String: (id: Int, count: Int)] = [:]
        if !symbols.isEmpty {
            let keyRows = try session.rows(
                """
                SELECT LOWER(symbol) AS match_key, CAST(MIN(id) AS INTEGER) AS id,
                       CAST(COUNT(*) AS INTEGER) AS n
                  FROM investments
                 WHERE LOWER(symbol) IN (SELECT value FROM json_each(?)) AND is_active = 1
                 GROUP BY LOWER(symbol)
                """,
                [.text(JSValue.array(symbols.sorted().map { JSValue.string($0) }).jsonText)])
            for key in keyRows {
                symbolMatches[try key.text("match_key")] =
                    (Int(try key.int64("id")), Int(try key.int64("n")))
            }
        }

        var aliasSymbols = Set<String>()
        for row in pending {
            let symbol = JavaScriptWhitespace.trim(row.symbol ?? "").lowercased()
            if !symbol.isEmpty, symbolMatches[symbol] == nil { aliasSymbols.insert(symbol) }
        }
        var aliasMatches: [String: (id: Int, count: Int)] = [:]
        if !aliasSymbols.isEmpty {
            let investments = try session.rows(
                """
                SELECT id, symbol, name, asset_class, price_provider, price_provider_id
                  FROM investments
                 WHERE is_active = 1
                   AND ((price_provider = 'yahoo' AND asset_class = 'crypto')
                        OR price_provider = 'kinesis')
                """
            )
            var candidateIds: [String: Set<Int>] = [:]
            for investment in investments {
                let alias = providerAssetAlias(
                    symbol: try investment.optionalText("symbol"),
                    name: try investment.optionalText("name"),
                    assetClass: try investment.optionalText("asset_class"),
                    provider: try investment.optionalText("price_provider"),
                    providerId: try investment.optionalText("price_provider_id"))
                guard let alias, aliasSymbols.contains(alias) else { continue }
                candidateIds[alias, default: []].insert(Int(try investment.int64("id")))
            }
            for (alias, ids) in candidateIds {
                aliasMatches[alias] = (ids.min() ?? 0, ids.count)
            }
        }

        var names = Set<String>()
        for row in pending {
            let symbol = JavaScriptWhitespace.trim(row.symbol ?? "")
            let lower = symbol.lowercased()
            if !symbol.isEmpty,
                symbolMatches[lower] != nil || aliasMatches[lower] != nil
            { continue }
            let name = JavaScriptWhitespace.trim(row.name ?? "").lowercased()
            if !name.isEmpty { names.insert(name) }
        }
        var nameMatches: [String: (id: Int, count: Int)] = [:]
        if !names.isEmpty {
            let keyRows = try session.rows(
                """
                SELECT LOWER(TRIM(name)) AS match_key, CAST(MIN(id) AS INTEGER) AS id,
                       CAST(COUNT(*) AS INTEGER) AS n
                  FROM investments
                 WHERE LOWER(TRIM(name)) IN (SELECT value FROM json_each(?)) AND is_active = 1
                 GROUP BY LOWER(TRIM(name))
                """,
                [.text(JSValue.array(names.sorted().map { JSValue.string($0) }).jsonText)])
            for key in keyRows {
                nameMatches[try key.text("match_key")] =
                    (Int(try key.int64("id")), Int(try key.int64("n")))
            }
        }

        var cache: [String: (investmentId: Int?, matchSource: String?)] = [:]  // lint:allow raw-id the investments the matcher resolves
        var counts: [String: Int] = ["symbol": 0, "name_exact": 0, "unresolved": 0]
        var updates: [JSValue] = []
        for row in pending {
            let key = "\(row.symbol ?? "")\u{0}\(row.name ?? "")"
            var resolved = cache[key]
            if resolved == nil {
                var match: (investmentId: Int?, matchSource: String?) = (nil, nil)  // lint:allow raw-id the investment one staged row resolves to
                let symbol = JavaScriptWhitespace.trim(row.symbol ?? "")
                if !symbol.isEmpty {
                    let entry = symbolMatches[symbol.lowercased()]
                        ?? aliasMatches[symbol.lowercased()]
                    if let entry, entry.count == 1 {
                        match = (entry.id, "symbol")
                    }
                }
                if match.investmentId == nil, match.matchSource == nil {
                    let name = JavaScriptWhitespace.trim(row.name ?? "")
                    if !name.isEmpty {
                        let entry = nameMatches[name.lowercased()]
                        if let entry, entry.count == 1 {
                            match = (entry.id, "name_exact")
                        }
                    }
                }
                resolved = match
                cache[key] = match
            }
            let match = resolved ?? (nil, nil)
            updates.append(.object(JSObject([
                ("id", .int(Int(row.id))),
                ("investment_id", match.investmentId.map { JSValue.int($0) } ?? .null),
                ("match_source", match.matchSource.map { JSValue.string($0) } ?? .null),
            ])))
            counts[match.matchSource ?? "unresolved", default: 0] += 1
        }
        if !updates.isEmpty {
            _ = try session.rows(
                """
                WITH v AS (
                    SELECT CAST(value ->> 'id' AS INTEGER) AS id,
                           CAST(value ->> 'investment_id' AS INTEGER) AS investment_id,
                           value ->> 'match_source' AS match_source
                      FROM json_each(?)
                )
                UPDATE portfolio_import_staging_rows
                   SET status = 'matched',
                       resolved_investment_id = v.investment_id,
                       match_source = v.match_source
                  FROM v
                 WHERE portfolio_import_staging_rows.id = v.id
                """,
                [.text(JSValue.array(updates).jsonText)])
        }
        return (counts, counts["unresolved"] ?? 0, total)
    }

    /// `KINESIS_ASSETS` of `config/kinesisConfig.ts`, by asset name.
    static let kinesisAssets: [String: String] = [
        "kaufen_gold": "KAU_USD", "xau_usd": "XAU_USD",
        "kaufen_silver": "KAG_USD", "xag_usd": "XAG_USD",
        "xpt_usd": "XPT_USD", "xpd_usd": "XPD_USD",
    ]

    /// `providerAssetAlias`: the explicit alias a holding's price provider names.
    static func providerAssetAlias(
        symbol: String?, name: String?, assetClass: String?,  // lint:allow raw-id the holding the alias resolves
        provider: String?, providerId: String?  // lint:allow raw-id the provider symbol the alias derives from
    ) -> String? {
        let providerSymbol = JavaScriptWhitespace.trim(providerId ?? "")
        if provider == "yahoo", assetClass == "crypto" { // lint:allow string-literal-compare the price provider the alias derives from
            let quote = providerSymbol.isEmpty
                ? JavaScriptWhitespace.trim(symbol ?? "") : providerSymbol
            let upper = quote.uppercased()
            let pair = upper.split(separator: "-", omittingEmptySubsequences: false)
            if pair.count == 2 {
                let base = String(pair[0])
                let fiat = String(pair[1])
                let fiatQuoteCurrencies: Set<String> = [
                    "AED", "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
                    "HKD", "HRK", "HUF", "INR", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP",
                    "PLN", "RON", "SAR", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
                ]
                let baseScalars = Array(base.unicodeScalars)
                if baseScalars.count >= 2, baseScalars.count <= 10,
                    baseScalars.allSatisfy({
                        (48...57).contains($0.value) || (65...90).contains($0.value)
                    }),
                    Array(fiat.unicodeScalars).count == 3,
                    Array(fiat.unicodeScalars).allSatisfy({ (65...90).contains($0.value) }),
                    fiatQuoteCurrencies.contains(fiat)
                {
                    return base.lowercased()
                }
            }
        }
        if provider == "kinesis" { // lint:allow string-literal-compare the price provider the alias derives from
            let assetName = JavaScriptWhitespace.trim((name ?? symbol ?? "").lowercased())
            let quote = providerSymbol.isEmpty
                ? (kinesisAssets.first { BankImportText.same($0.key, assetName) }?.value ?? "")
                : providerSymbol
            let upper = quote.uppercased()
            let pair = upper.split(separator: "_", omittingEmptySubsequences: false)
            if pair.count == 2 {
                let base = String(pair[0])
                let quoteCurrency = String(pair[1])
                if ["KAU", "KAG", "XAU", "XAG", "XPT", "XPD"].contains(base),
                    ["USD", "EUR"].contains(quoteCurrency)
                {
                    return base.lowercased()
                }
            }
        }
        return nil
    }

    // MARK: - The pipeline orchestration

    /// `prepareImport`: stage → validate → match, then the awaiting_review decision.
    struct PreparedImport: Sendable {
        var rowsTotal: Int
        var rowsSkipped: Int
        var requiresReview: Bool
        var matchSourceCounts: [String: Int]
        var validateErrors: Int
    }

    /// The one-shot pipeline's answer, in the route's shape.
    struct PipelineResult: Sendable {
        var batchId: Int  // lint:allow raw-id the batch the pipeline created
        var total: Int
        var skipped: Int
        var requiresReview: Bool
        var matchSourceCounts: [String: Int]
        var imported: Int?
        var duplicates: Int?
        var errors: Int?
    }

    /// `runPortfolioImportPipeline`: create, prepare, then auto-commit or review.
    static func runPipeline(
        _ session: BackendSession, file: UploadedFile, built: BuiltConfig,  // lint:allow raw-id the batch the pipeline creates
        isBrokerage: Bool, accountId: Int?,  // lint:allow raw-id the sleeve account the batch stamps
        onProgress: ((PipelineProgress) -> Void)? = nil
    ) throws -> PipelineResult {
        let batchId = try createBatch(
            session, adapterName: built.adapterName, filename: file.originalName,
            size: file.size, configJSON: built.configJSON,
            defaultAssetClass: built.defaultAssetClass, defaultType: built.defaultType,
            isBrokerage: isBrokerage, accountId: accountId)
        let prepared = try prepareImport(
            session, batchId: batchId, file: file, built: built, onProgress: onProgress)
        if prepared.requiresReview {
            return PipelineResult(
                batchId: batchId, total: prepared.rowsTotal, skipped: prepared.rowsSkipped,
                requiresReview: true, matchSourceCounts: prepared.matchSourceCounts,
                imported: nil, duplicates: nil, errors: nil)
        }
        let committed = try PortfolioImportCommitArea.commitPortfolioImport(session, batchId, nil)
        let totalErrors = prepared.validateErrors + committed.errors
        return PipelineResult(
            batchId: batchId, total: prepared.rowsTotal, skipped: prepared.rowsSkipped,
            requiresReview: false, matchSourceCounts: prepared.matchSourceCounts,
            imported: committed.imported, duplicates: committed.duplicates,
            errors: totalErrors)
    }

    /// `prepareImport`: the three phases and the review decision.
    static func prepareImport(
        _ session: BackendSession, batchId: Int, file: UploadedFile, built: BuiltConfig,  // lint:allow raw-id the staged batch the phases write
        onProgress: ((PipelineProgress) -> Void)?
    ) throws -> PreparedImport {
        let staged = try stageBatch(session, batchId: batchId, file: file, built: built)
        if staged.rowsTotal == 0 {
            if built.parser.format == .nexoProSpotHistory, staged.rowsSkipped == 0 {
                _ = try session.row(
                    "UPDATE portfolio_import_batches SET status = 'awaiting_review' WHERE id = ?",
                    [.integer(Int64(batchId))])
                return PreparedImport(
                    rowsTotal: 0, rowsSkipped: 0, requiresReview: true,
                    matchSourceCounts: [:], validateErrors: 0)
            }
            throw BackendHTTPError.validation(
                staged.rowsSkipped > 0
                    ? "No importable rows: all \(staged.rowsSkipped) data rows failed to parse."
                        + " Check the column mapping and date format."
                    : "No importable rows found in the file.")
        }
        let validated = try validateBatch(
            session, batchId: batchId, typeMapping: built.typeMapping)
        let matched = try matchBatch(session, batchId: batchId)
        let brokerage = try session.row(
            "SELECT is_brokerage FROM portfolio_import_batches WHERE id = ?",
            [.integer(Int64(batchId))])
        let isBrokerage = (try brokerage?.optionalInt64("is_brokerage") ?? 0) != 0
        let requiresReview =
            isBrokerage || validated.errors > 0
            || (matched.matchSourceCounts["name_exact"] ?? 0) > 0 || matched.unresolved > 0
        if requiresReview {
            _ = try session.row(
                "UPDATE portfolio_import_batches SET status = 'awaiting_review' WHERE id = ?",
                [.integer(Int64(batchId))])
        }
        return PreparedImport(
            rowsTotal: staged.rowsTotal, rowsSkipped: staged.rowsSkipped,
            requiresReview: requiresReview, matchSourceCounts: matched.matchSourceCounts,
            validateErrors: validated.errors)
    }

    // MARK: - Routes

    /// The brokerage guards both routes share, before any batch is created.
    static func guards(
        _ session: BackendSession, _ fields: JSObject, _ built: BuiltConfig
    ) throws -> (isBrokerage: Bool, accountId: Int?) {  // lint:allow raw-id the sleeve account the guards assert
        let brokerage = try brokerageParams(fields)
        try assertFormatBrokerage(built.parser.format, brokerage)
        if let accountId = brokerage.accountId {
            try PortfolioImportCommitArea.assertPortfolioImportAccount(session, accountId)
        }
        for accountId in [built.transferDestinationAccount, built.transferOriginAccount] {
            guard let accountId else { continue }
            if accountId == brokerage.accountId {
                throw BackendHTTPError.validation(
                    "Transfer source and destination accounts must differ")
            }
            try PortfolioImportCommitArea.assertPortfolioImportAccount(session, accountId)
        }
        return brokerage
    }

    /// `match_source_counts` as the envelope writes it.
    static func matchSourceCountsJSON(_ counts: [String: Int]) -> JSValue {
        .object(JSObject(counts.map { ($0.key, JSValue.int($0.value)) }))
    }

    /// The two upload routes.
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(PortfolioImportCsvCustomRequest.self) { request in
            try await database.run { session in
                let form = try ImportUploadsArea.form(request)
                let file = try requireFile(try uploadedFile(form.file))
                let built = try buildConfig(form.fields)
                let brokerage = try guards(session, form.fields, built)
                try assertUploadSupported(file.bytes, built.parser.format)
                let result = try runPipeline(
                    session, file: file, built: built,
                    isBrokerage: brokerage.isBrokerage, accountId: brokerage.accountId)
                if result.requiresReview {
                    return HandlerResult(status: 202, data: JSValue.object(JSObject([
                        ("batch_id", .int(result.batchId)),
                        ("requires_review", .bool(true)),
                        ("match_source_counts", matchSourceCountsJSON(result.matchSourceCounts)),
                        ("skipped", .int(result.skipped)),
                    ])).envelopeValue)
                }
                return HandlerResult(status: 201, data: JSValue.object(JSObject([
                    ("batch_id", .int(result.batchId)),
                    ("total", .int(result.total)),
                    ("skipped", .int(result.skipped)),
                    ("imported", .int(result.imported ?? 0)),
                    ("duplicates", .int(result.duplicates ?? 0)),
                    ("errors", .int(result.errors ?? 0)),
                ])).envelopeValue)
            }
        }
        backend.serve(PortfolioImportCsvStreamRequest.self) { request in
            try await database.run { session in
                let form = try ImportUploadsArea.form(request)
                let file = try requireFile(try uploadedFile(form.file))
                let built = try buildConfig(form.fields)
                let brokerage = try guards(session, form.fields, built)
                try assertUploadSupported(file.bytes, built.parser.format)
                var frames: [(String, JSValue)] = []
                var percent = 0
                let result = try runPipeline(
                    session, file: file, built: built,
                    isBrokerage: brokerage.isBrokerage, accountId: brokerage.accountId,
                    onProgress: { progress in
                        let next = ImportUploadsArea.progressToPercent(progress)
                        percent = next.percent
                        frames.append(("progress", next.payload))
                    })
                if result.requiresReview {
                    var reviewFields = JSObject()
                    reviewFields["batch_id"] = .number(Double(result.batchId))
                    reviewFields["match_source_counts"] = matchSourceCountsJSON(result.matchSourceCounts)
                    reviewFields["skipped"] = .number(Double(result.skipped))
                    reviewFields["percent"] = .number(70)
                    frames.append(("review_required", .object(reviewFields)))
                } else {
                    var completeFields = JSObject()
                    completeFields["batch_id"] = .number(Double(result.batchId))
                    completeFields["total_processed"] = .number(Double(result.total))
                    completeFields["skipped"] = .number(Double(result.skipped))
                    completeFields["imported"] = .number(Double(result.imported ?? 0))
                    completeFields["duplicates"] = .number(Double(result.duplicates ?? 0))
                    completeFields["errors"] = .number(Double(result.errors ?? 0))
                    completeFields["status"] = .string(
                        (result.errors ?? 0) > 0 ? "completed_with_errors" : "completed")
                    completeFields["percent"] = .number(100)
                    frames.append(("complete", .object(completeFields)))
                }
                return HandlerResult.fileAnswer(
                    Data(ImportUploadsArea.sseText(frames).utf8),
                    headers: ["Content-Type": "text/event-stream"])
            }
        }
    }
}

/// `POST /api/portfolio/import/csv/custom`: the one-shot upload route.
public struct PortfolioImportCsvCustomRequest: APIOperation {
    public typealias Response = JSONValue
    public static let operationId = "portfolioImportCsvCustom"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/portfolio/import/csv/custom"
    public var path: String { Self.pathTemplate }
    public var queryItems: [URLQueryItem] { [] }
    public func encodedBody() throws -> Data? { nil }
    public var contentType: String { "application/json" }
}

/// `POST /api/portfolio/import/csv/stream`: the SSE upload route.
public struct PortfolioImportCsvStreamRequest: APIOperation {
    public typealias Response = JSONValue
    public static let operationId = "portfolioImportCsvStream"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/portfolio/import/csv/stream"
    public var path: String { Self.pathTemplate }
    public var queryItems: [URLQueryItem] { [] }
    public func encodedBody() throws -> Data? { nil }
    public var contentType: String { "application/json" }
}
