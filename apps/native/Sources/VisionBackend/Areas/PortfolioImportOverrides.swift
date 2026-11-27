import Foundation
import VisionNativeCore

/// The review-resolves routes of `routes/portfolioImportRoutes.ts`: the single-row and bulk
/// investment overrides (`resolveInvestmentRows`, `createInvestmentForRow`, `overrideInvestment`,
/// `overrideInvestments` in `services/portfolioImportBatchService.ts` and
/// `repositories/portfolioImportBatchRepository.ts`). Their writes share one transaction, so a
/// failed set changes nothing; the coded repository errors become the route's 400/404 through
/// `rethrowCodedError`.
enum PortfolioImportOverridesArea {
    /// `MAX_BULK_RESOLUTION_ROWS`.
    static let maxBulkRows = 5000
    /// `VALID_ASSET_CLASSES` of `lib/assetClasses.ts`.
    static let assetClasses: Set<String> = [
        "stock", "etf", "crypto", "metals", "real_estate", "savings", "bond",
    ]
    /// `KINESIS_METAL_SYMBOLS`.
    static let kinesisMetalSymbols: Set<String> = ["KAU", "KAG"]
    /// `REVIEWABLE_PORTFOLIO_ROW` of `portfolioImportBatchRepository.ts`.
    static let reviewableRow = """
        (status = 'matched' OR (status = 'error' AND error_message = 'unresolved instrument — pick or create a holding')) AND route IS NOT 'cash'
        """
    /// The unresolved-instrument message `REVIEWABLE_PORTFOLIO_ROW` reads.
    static let unresolvedInstrument = "unresolved instrument — pick or create a holding"

    // MARK: - Body

    /// The parsed `bulkInvestmentOverrideSchema`.
    struct BulkBody {
        var rowIds: [Int]
        var createNew: Bool
        var investmentId: Int?  // lint:allow raw-id the int4 investment id the route body coerces
    }

    /// `validateId` of `lib/validation.ts`: a number, or a digits-only string, within its bound.
    static func validId(_ value: JSValue, max: Double) -> Int? {
        switch value {
        case .number(let number):
            guard number.isFinite, number == number.rounded(), number >= 1, number <= max else { return nil }
            return Int(number)
        case .string(let text):
            guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
            guard let number = Double(text), number >= 1, number <= max else { return nil }
            return Int(number)
        default:
            return nil
        }
    }

    /// `req.body ?? {}` of the two routes: an absent or null body reads as the empty object.
    static func body(_ parsed: JSValue?) throws -> JSValue {
        if case .object(let object)? = parsed { return .object(object) }
        if parsed == nil || parsed == .null { return .object(JSObject()) }
        return parsed ?? .null
    }

    /// `bulkInvestmentOverrideSchema` through `parseInput(bareMessages(...))`: the field checks in
    /// shape order, then the exactly-one-of refine, then the investment_id transform. Every issue
    /// joins into one message with `"; "`.
    static func bulkBody(_ parsed: JSValue?) throws -> BulkBody {
        let body = try self.body(parsed)
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        var issues: [String] = []
        var rowIds: [Int]? = nil
        if case .array(let raw)? = object["row_ids"] {
            if raw.isEmpty {
                issues.append("row_ids must be a non-empty array")
            } else if raw.count > maxBulkRows {
                issues.append("row_ids must contain at most \(maxBulkRows) entries")
            } else {
                var parsed: [Int] = []
                for (index, value) in raw.enumerated() {
                    if let id = validId(value, max: ImportBatchesArea.maxSafeId) {
                        parsed.append(id)
                    } else {
                        issues.append("row_ids[\(index)] must be a positive integer")
                        break
                    }
                }
                if issues.isEmpty {
                    if Set(parsed).count != parsed.count {
                        issues.append("row_ids must not contain duplicates")
                    } else {
                        rowIds = parsed
                    }
                }
            }
        } else {
            issues.append("row_ids must be a non-empty array")
        }
        var createNewTrue = false
        if let createNew = object["create_new"] {
            if case .bool(true) = createNew {
                createNewTrue = true
            } else {
                issues.append("create_new must be true when provided")
            }
        }
        let rawInvestmentId = object["investment_id"]
        let hasInvestmentId = rawInvestmentId != nil && rawInvestmentId != .null
        if !issues.isEmpty {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        if createNewTrue == hasInvestmentId {
            throw BackendHTTPError.validation(
                "Provide exactly one of investment_id or create_new: true")
        }
        if !hasInvestmentId {
            return BulkBody(rowIds: rowIds ?? [], createNew: true, investmentId: nil)
        }
        guard let id = validId(rawInvestmentId ?? .null, max: 2_147_483_647) else {
            throw BackendHTTPError.validation("investment_id must be a positive integer")
        }
        return BulkBody(rowIds: rowIds ?? [], createNew: false, investmentId: id)
    }

    /// `createInvestmentBodySchema.safeParse(body).success`: a plain object whose `create_new` is
    /// the literal `true` (loose: other keys pass).
    static func wantsCreateNew(_ body: JSValue) -> Bool {
        guard case .object(let object) = body, case .bool(true)? = object["create_new"] else {
            return false
        }
        return true
    }

    /// `investmentOverrideBodySchema` through `parseInput(bareMessages(...))`: `investment_id` is
    /// null/absent to clear, otherwise a real int4 id.
    static func investmentIdBody(_ body: JSValue) throws -> Int? {
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        guard let value = object["investment_id"], value != .null else { return nil }
        guard let id = validId(value, max: 2_147_483_647) else {
            throw BackendHTTPError.validation("investment_id must be a positive integer or null")
        }
        return id
    }

    // MARK: - Resolution

    /// `lockInvestmentResolutionRows` plus the checks of
    /// `validateInvestmentResolutionRows`: the batch status, then the complete reviewable row
    /// set, then (for a create) the no-existing-override rule.
    static func validateResolutionRows(
        _ session: BackendSession, batch: Int, rowIds: [Int], rejectExistingOverride: Bool
    ) throws -> Bool {
        guard let locked = try session.row(
            "SELECT status FROM portfolio_import_batches WHERE id = ?",
            [.integer(Int64(batch))])
        else { return false }
        let status = try locked.text("status")
        if status != "awaiting_review" && status != "complete_with_errors" {
            throw BackendHTTPError.validation(
                "Batch \(batch) is not in a reviewable state (status: \(status))")
        }
        let placeholders = rowIds.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT id, status, route, error_message, user_override_investment_id
              FROM portfolio_import_staging_rows
             WHERE batch_id = ? AND id IN (\(placeholders))
             ORDER BY id
            """,
            [.integer(Int64(batch))] + rowIds.map { .integer(Int64($0)) })
        let reviewable: (SQLRow) throws -> Bool = { row in
            if try row.optionalText("route") == "cash" {  // lint:allow string-literal-compare the staging-row route values
                return false
            }
            let rowStatus = try row.text("status")
            if rowStatus == "matched" {  // lint:allow string-literal-compare the staging-row status values
                return true
            }
            if rowStatus != "error" {  // lint:allow string-literal-compare the staging-row status values
                return false
            }
            return try row.optionalText("error_message") == unresolvedInstrument
        }
        let everyRowReviewable = try rows.allSatisfy(reviewable)
        if rows.count != rowIds.count || !everyRowReviewable {
            throw BackendHTTPError.notFound(
                "One or more rows were not found in this batch or are no longer reviewable")
        }
        if rejectExistingOverride {
            for row in rows {
                if try row.optionalInt64("user_override_investment_id") != nil {
                    throw BackendHTTPError.validation(
                        "One or more rows already have a user-selected investment")
                }
            }
        }
        return true
    }

    /// `storedConfigObject` narrowed to the `format` key the create path reads.
    static func storedConfigFormat(_ raw: String?) -> String? {
        guard let raw, let value = JSValue.parse(raw), case .object(let object) = value,
            case .string(let format)? = object["format"]
        else { return nil }
        return format
    }

    /// `mapInvestmentRow` of an inserted row: the emitted investment without the joined
    /// `show_in_ticker` (an `INSERT ... RETURNING` row carries no ticker preference).
    static func createdInvestmentJSON(_ row: SQLRow) throws -> [String: JSONValue] {
        [
            "id": .int(try row.integerId("id")),
            "name": .string(try row.text("name")),
            "symbol": try row.optionalText("symbol").map(JSONValue.string) ?? .null,
            "asset_class": .string(try row.text("asset_class")),
            "currency": .string(try row.text("currency")),
            "current_price": try row.optionalDoubleText("current_price")
                .map { InvestmentsArea.jsNumber($0) } ?? .null,
            "interest_rate": try row.optionalDoubleText("interest_rate")
                .map { InvestmentsArea.jsNumber($0) } ?? .null,
            "maturity_date": try row.optionalText("maturity_date").map(JSONValue.string) ?? .null,
            "location": try row.optionalText("location").map(JSONValue.string) ?? .null,
            "municipality": try row.optionalText("municipality").map(JSONValue.string) ?? .null,
            "cadastral_income": try row.optionalDoubleText("cadastral_income")
                .map { InvestmentsArea.jsNumber($0) } ?? .null,
            "municipality_tax_rate": try row.optionalDoubleText("municipality_tax_rate")
                .map { InvestmentsArea.jsNumber($0) } ?? .null,
            "notes": try row.optionalText("notes").map(JSONValue.string) ?? .null,
            "is_active": .bool(try row.bool("is_active")),
            "price_provider": .string(try row.text("price_provider")),
            "price_provider_id": try row.optionalText("price_provider_id").map(JSONValue.string)
                ?? .null,
            "price_provider_url": try row.optionalText("price_provider_url").map(JSONValue.string)
                ?? .null,
            "price_provider_latest_url": try row.optionalText("price_provider_latest_url")
                .map(JSONValue.string) ?? .null,
            "price_provider_latest_path": try row.optionalText("price_provider_latest_path")
                .map(JSONValue.string) ?? .null,
            "price_provider_history_url": try row.optionalText("price_provider_history_url")
                .map(JSONValue.string) ?? .null,
            "price_provider_history_path": try row.optionalText("price_provider_history_path")
                .map(JSONValue.string) ?? .null,
            "price_provider_history_ts_path": try row.optionalText("price_provider_history_ts_path")
                .map(JSONValue.string) ?? .null,
            "price_provider_history_price_path": try row.optionalText(
                "price_provider_history_price_path").map(JSONValue.string) ?? .null,
            "price_updated_at": try row.instantOrNil("price_updated_at").map { .string($0.text) }
                ?? .null,
            "created_at": .string(try row.instant("created_at").text),
            "updated_at": .string(try row.instant("updated_at").text),
        ]
    }

    /// `createInvestmentFromRow` plus `investmentRepository.create`: the staging row's fields
    /// become a new holding, with the repository's own guards (name, asset class, symbol
    /// uniqueness) re-checked in its order.
    static func createInvestmentFromRow(
        _ session: BackendSession, batch: Int, row: Int
    ) throws -> SQLRow {
        guard let source = try session.row(
            """
            SELECT isr.symbol_raw, isr.name_raw, isr.currency, b.default_asset_class, b.custom_config
              FROM portfolio_import_staging_rows isr
              INNER JOIN portfolio_import_batches b ON b.id = isr.batch_id
             WHERE isr.batch_id = ? AND isr.id = ?
            """,
            [.integer(Int64(batch)), .integer(Int64(row))])
        else {
            throw BackendHTTPError.notFound("Row \(row) not found in batch \(batch)")
        }
        guard let defaultAssetClass = try source.optionalText("default_asset_class"),
            !defaultAssetClass.isEmpty
        else {
            throw BackendHTTPError.validation(
                "batch has no default asset class for new holdings")
        }
        let nameRaw = try source.optionalText("name_raw") ?? ""
        let symbolRaw = try source.optionalText("symbol_raw") ?? ""
        let name = JavaScriptWhitespace.trim(
            !nameRaw.isEmpty ? nameRaw : (!symbolRaw.isEmpty ? symbolRaw : ""))
        guard !name.isEmpty else {
            throw BackendHTTPError.validation(
                "row has no symbol or name to create a holding from")
        }
        let symbol = JavaScriptCase.uppercased(JavaScriptWhitespace.trim(symbolRaw))
        let rawCurrency = JavaScriptCase.uppercased(
            JavaScriptWhitespace.trim(try source.optionalText("currency") ?? ""))
        let format = storedConfigFormat(try source.optionalText("custom_config"))
        let assetClass =
            format == "kinesis_transaction_history"  // lint:allow string-literal-compare the stored custom_config format values
                && kinesisMetalSymbols.contains(symbol)
            ? "metals" : defaultAssetClass
        let holdingCurrency =
            format == "kinesis_transaction_history"  // lint:allow string-literal-compare the stored custom_config format values
            ? "USD"
            : (AccountsArea.isCurrencyCode(rawCurrency) ? rawCurrency : "EUR")
        guard assetClasses.contains(assetClass) else {
            throw BackendHTTPError.validation("Unsupported asset_class: \(assetClass)")
        }
        if !symbol.isEmpty {
            let duplicate = try session.row(
                "SELECT id FROM investments WHERE LOWER(symbol) = LOWER(?) LIMIT 1",
                [.text(symbol)])
            if duplicate != nil {
                throw BackendHTTPError.validation("symbol must be unique")
            }
        }
        guard let inserted = try session.row(
            """
            INSERT INTO investments
              (name, symbol, asset_class, currency, current_price, interest_rate, maturity_date,
               location, municipality, cadastral_income, municipality_tax_rate, notes,
               price_provider, price_provider_id, price_provider_url, price_provider_latest_url,
               price_provider_latest_path, price_provider_history_url, price_provider_history_path,
               price_provider_history_ts_path, price_provider_history_price_path)
            VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'manual',
                    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
            RETURNING id, name, symbol, asset_class, currency, current_price, interest_rate,
                      maturity_date, location, municipality, cadastral_income,
                      municipality_tax_rate, notes, is_active, price_provider, price_provider_id,
                      price_provider_url, price_provider_latest_url, price_provider_latest_path,
                      price_provider_history_url, price_provider_history_path,
                      price_provider_history_ts_path, price_provider_history_price_path,
                      price_updated_at, created_at, updated_at
            """,
            [
                .text(name),
                symbol.isEmpty ? .null : .text(symbol),
                .text(assetClass),
                .text(holdingCurrency),
            ])
        else {
            throw RequiredValueError(
                message: "createInvestmentFromRow returns the holding it created")
        }
        return inserted
    }

    /// `requiredValue`: a server fault when an invariant the corpus cannot reach breaks.
    struct RequiredValueError: Error, Sendable {
        var message: String
    }

    /// `overrideInvestments`: the eligibility count and the guarded update share one
    /// transaction; a reset error row also repairs the batch's `rows_error` counter.
    static func overrideInvestments(
        _ session: BackendSession, batch: Int, rowIds: [Int],
        investmentId: Int  // lint:allow raw-id the int4 investment id the route body coerces
    ) throws -> Int {
        let placeholders = rowIds.map { _ in "?" }.joined(separator: ", ")
        let arguments: [SQLValue] = [.integer(Int64(batch))] + rowIds.map { .integer(Int64($0)) }
        let eligibility = try session.row(
            """
            SELECT COUNT(*) AS eligible_count,
                   COUNT(*) FILTER (WHERE status = 'error') AS error_count
              FROM portfolio_import_staging_rows
             WHERE batch_id = ? AND id IN (\(placeholders)) AND \(reviewableRow)
            """,
            arguments)
        let eligibleCount = try eligibility.map { Int(try $0.int64("eligible_count")) } ?? 0
        let errorCount = try eligibility.map { Int(try $0.int64("error_count")) } ?? 0
        var updatedCount = 0
        if rowIds.count == eligibleCount {
            updatedCount = try session.rows(
                """
                UPDATE portfolio_import_staging_rows
                   SET user_override_investment_id = ?,
                       status = CASE WHEN status = 'error' THEN 'matched' ELSE status END,
                       error_message = CASE WHEN status = 'error' THEN NULL ELSE error_message END
                 WHERE batch_id = ? AND id IN (\(placeholders)) AND \(reviewableRow)
                RETURNING id
                """,
                [.integer(Int64(investmentId))] + arguments).count
            if errorCount > 0 {
                try session.rows(
                    """
                    UPDATE portfolio_import_batches
                       SET rows_error = max(COALESCE(rows_error, 0) - ?, 0)
                     WHERE id = ?
                    """,
                    [.integer(Int64(errorCount)), .integer(Int64(batch))])
            }
        }
        return updatedCount
    }

    /// `overrideInvestment`: the single-row re-point, with the error→matched reset when a
    /// holding is chosen.
    static func overrideInvestment(
        _ session: BackendSession, batch: Int, row: Int,
        investmentId: Int?  // lint:allow raw-id the int4 investment id the route body coerces
    ) throws {
        guard let old = try session.row(
            """
            SELECT status AS old_status
              FROM portfolio_import_staging_rows
             WHERE batch_id = ? AND id = ? AND \(reviewableRow)
            """,
            [.integer(Int64(batch)), .integer(Int64(row))])
        else { return }
        let reset = try old.text("old_status") == "error"  // lint:allow string-literal-compare the staging-row status values
            && investmentId != nil
        try session.rows(
            reset
                ? """
                UPDATE portfolio_import_staging_rows
                   SET user_override_investment_id = ?, status = 'matched', error_message = NULL
                 WHERE batch_id = ? AND id = ?
                """
                : """
                UPDATE portfolio_import_staging_rows
                   SET user_override_investment_id = ?
                 WHERE batch_id = ? AND id = ?
                """,
            [
                investmentId.map { SQLValue.integer(Int64($0)) } ?? .null,
                .integer(Int64(batch)),
                .integer(Int64(row)),
            ])
        if reset {
            try session.rows(
                """
                UPDATE portfolio_import_batches
                   SET rows_error = max(COALESCE(rows_error, 0) - 1, 0)
                 WHERE id = ?
                """,
                [.integer(Int64(batch))])
        }
    }

    // MARK: - Handlers

    /// `POST /batches/:id/rows/investment-override` (`resolveInvestmentRows`).
    static func resolveRows(
        _ session: BackendSession, batch: Int, _ body: BulkBody
    ) throws -> HandlerResult {
        try session.transaction {
            guard try validateResolutionRows(
                session, batch: batch, rowIds: body.rowIds, rejectExistingOverride: body.createNew)
            else {
                throw BackendHTTPError.notFound("Batch \(batch) not found")
            }
            var created: SQLRow?
            var effectiveId: Int  // lint:allow raw-id the int4 investment id the resolution chose
            if body.createNew {
                let holding = try createInvestmentFromRow(
                    session, batch: batch, row: body.rowIds[0])
                created = holding
                effectiveId = try Int(holding.integerId("id"))
            } else {
                guard let investment = try session.row(
                    """
                    SELECT id FROM investments WHERE id = ?
                    """,
                    [.integer(Int64(body.investmentId ?? 0))])
                else {
                    throw BackendHTTPError.notFound(
                        "Investment \(body.investmentId.map(String.init) ?? "undefined") not found")
                }
                effectiveId = try Int(investment.integerId("id"))
            }
            let updated = try overrideInvestments(
                session, batch: batch, rowIds: body.rowIds, investmentId: effectiveId)
            if updated != body.rowIds.count {
                throw BackendHTTPError.notFound(
                    "One or more rows were not found in this batch or are no longer reviewable")
            }
            var json: [String: JSONValue] = [
                "investment_id": .int(effectiveId),
                "created": .bool(body.createNew),
                "resolved": .int(updated),
            ]
            if body.createNew, let created {
                json["investment"] = .object(try createdInvestmentJSON(created))
            }
            return HandlerResult(data: .object(json))
        }
    }

    /// `POST /batches/:id/rows/:rowId/investment-override`: `createInvestmentForRow` when the
    /// body carries `create_new: true`, otherwise the single-row `overrideInvestment`.
    static func overrideRow(
        _ session: BackendSession, batch: Int, row: Int, _ body: JSValue
    ) throws -> HandlerResult {
        if wantsCreateNew(body) {
            return try session.transaction {
                guard try validateResolutionRows(
                    session, batch: batch, rowIds: [row], rejectExistingOverride: true)
                else {
                    throw BackendHTTPError.notFound("Row \(row) not found in batch \(batch)")
                }
                let investment = try createInvestmentFromRow(session, batch: batch, row: row)
                try overrideInvestment(
                    session, batch: batch, row: row, investmentId: try Int(investment.integerId("id")))
                return HandlerResult(data: .object([
                    "row_id": .int(row),
                    "investment_id": .int(try Int(investment.integerId("id"))),
                    "created": .bool(true),
                    "investment": .object(try createdInvestmentJSON(investment)),
                ]))
            }
        }
        let investmentId = try investmentIdBody(body)
        try session.transaction {
            let found = try session.row(
                """
                SELECT id
                  FROM portfolio_import_staging_rows
                 WHERE batch_id = ? AND id = ? AND \(reviewableRow)
                """,
                [.integer(Int64(batch)), .integer(Int64(row))])
            guard found != nil else {
                throw BackendHTTPError.notFound(
                    "Row \(row) not found in batch \(batch) or not eligible for an investment override")
            }
            try overrideInvestment(session, batch: batch, row: row, investmentId: investmentId)
        }
        return HandlerResult(data: .object([
            "row_id": .int(row),
            "user_override_investment_id": investmentId.map { JSONValue.int($0) } ?? .null,
        ]))
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.PortfolioImportRowsInvestmentOverride.self) { request in
            // express.json() rejects a malformed body before the route runs; the
            // route's batch-id check precedes the body's own validation.
            let parsed = try RequestBody.parseJavaScript(request.body)
            let batchId = try PortfolioImportBatchesArea.batchId(request)
            let body = try PortfolioImportOverridesArea.bulkBody(parsed)
            return try await database.run { session in
                try PortfolioImportOverridesArea.resolveRows(session, batch: batchId, body)
            }
        }
        backend.serve(OpenAPIOperations.PortfolioImportRowInvestmentOverride.self) { request in
            let parsed = try RequestBody.parseJavaScript(request.body)
            let ids = try ImportReviewArea.batchRowIds(request)
            let body = try PortfolioImportOverridesArea.body(parsed)
            return try await database.run { session in
                try PortfolioImportOverridesArea.overrideRow(
                    session, batch: ids.batch, row: ids.row, body)
            }
        }
    }
}
