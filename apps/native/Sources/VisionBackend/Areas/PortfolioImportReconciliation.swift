import Foundation
import VisionNativeCore

/// `POST /api/portfolio/import/reconciliation/preview` of `routes/portfolioImportRoutes.ts`:
/// `previewPortfolioImportReconciliation` — the database halves around the pure planner
/// (`PortfolioImportReconciliation.buildPlan`, #432): the scope reads of
/// `portfolioImportReconciliationRepository.ts`, the eligible-yield patch of the staged
/// adjustment rows, the projected custody history with its oversell guard, and the
/// `projected_history_conflict` blocker the guard appends.
enum PortfolioImportReconciliationArea {
    /// `reconciliationScopeSchema` (`z.strictObject` through `bareMessages`): every issue joins
    /// into one message with `"; "`, the field checks in shape order first, then the
    /// unrecognized keys in the body's JavaScript key order.
    static func scopeBody(_ request: InProcessRequest) throws -> (
        batchIds: [Int], adoptPolicy: String?, batchPolicies: [BatchPolicyInput],
        rowChoices: [RowChoiceInput]
    ) {
        let parsed = try RequestBody.parseJavaScript(request.body)
        guard let body = parsed else {
            throw BackendHTTPError.validation("Invalid input: expected object, received undefined")
        }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        var issues: [String] = []
        var batchIds: [Int] = []
        if case .array(let items)? = object["batch_ids"] {
            if items.isEmpty {
                issues.append("Too small: expected array to have >=1 items")
            } else if items.count > 100 {
                issues.append("Too big: expected array to have <=100 items")
            } else {
                for item in items {
                    if case .number(let number) = item {
                        if number.rounded() != number {
                            issues.append("Invalid input: expected int, received number")
                        } else if number <= 0 {
                            issues.append("Too small: expected number to be >0")
                        } else if number > ImportBatchesArea.maxSafeId {
                            issues.append("Too big: expected number to be <=9007199254740991")
                        } else {
                            batchIds.append(Int(number))
                        }
                    } else {
                        issues.append(
                            "Invalid input: expected number, received \(item.zodTypeName)")
                    }
                }
            }
        } else if let value = object["batch_ids"] {
            issues.append("Invalid input: expected array, received \(value.zodTypeName)")
        } else {
            issues.append("Invalid input: expected array, received undefined")
        }
        var adoptPolicy: String?
        if let value = object["adopt_policy"] {
            if case .string(let text) = value,
                text == "preserve_existing" || text == "prefer_source"  // lint:allow string-literal-compare the adopt_policy enum values
            {
                adoptPolicy = text
            } else {
                issues.append(
                    "Invalid option: expected one of \"preserve_existing\"|\"prefer_source\"")
            }
        }
        var batchPolicies: [BatchPolicyInput] = []
        if let value = object["batch_policies"] {
            if case .array(let items) = value {
                if items.count > 100 {
                    issues.append("Too big: expected array to have <=100 items")
                } else {
                    for item in items {
                        if let policy = policyItem(item, issues: &issues) {
                            batchPolicies.append(policy)
                        }
                    }
                }
            } else {
                issues.append("Invalid input: expected array, received \(value.zodTypeName)")
            }
        }
        var rowChoices: [RowChoiceInput] = []
        if let value = object["row_choices"] {
            if case .array(let items) = value {
                if items.count > 10000 {
                    issues.append("Too big: expected array to have <=10000 items")
                } else {
                    for item in items {
                        if let choice = choiceItem(item, issues: &issues) {
                            rowChoices.append(choice)
                        }
                    }
                }
            } else {
                issues.append("Invalid input: expected array, received \(value.zodTypeName)")
            }
        }
        for key in object.keys
        where !["batch_ids", "adopt_policy", "batch_policies", "row_choices"].contains(key) {
            issues.append("Unrecognized key: \"\(key)\"")
        }
        if !issues.isEmpty {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        return (batchIds, adoptPolicy, batchPolicies, rowChoices)
    }

    /// One `batch_policies` item: a strict object of `batch_id` and `adopt_policy`.
    static func policyItem(_ value: JSValue, issues: inout [String]) -> BatchPolicyInput? {
        guard case .object(let object) = value else {
            issues.append("Invalid input: expected object, received \(value.zodTypeName)")
            return nil
        }
        var batchId: PortfolioImportBatchNumericID?
        if case .number(let number)? = object["batch_id"] {
            if number.rounded() != number {
                issues.append("Invalid input: expected int, received number")
            } else if number <= 0 {
                issues.append("Too small: expected number to be >0")
            } else if number > ImportBatchesArea.maxSafeId {
                issues.append("Too big: expected number to be <=9007199254740991")
            } else {
                batchId = PortfolioImportBatchNumericID(Int(number))
            }
        } else {
            issues.append(
                "Invalid input: expected number, received \(object["batch_id"].map { $0.zodTypeName } ?? "undefined")")
        }
        var adoptPolicy: String?
        if case .string(let text)? = object["adopt_policy"],
            text == "preserve_existing" || text == "prefer_source"  // lint:allow string-literal-compare the adopt_policy enum values
        {
            adoptPolicy = text
        } else {
            issues.append(
                "Invalid option: expected one of \"preserve_existing\"|\"prefer_source\"")
        }
        for key in object.keys where !["batch_id", "adopt_policy"].contains(key) {
            issues.append("Unrecognized key: \"\(key)\"")
        }
        if let batchId, let adoptPolicy {
            return BatchPolicyInput(batchID: batchId, adoptPolicy: adoptPolicy)
        }
        return nil
    }

    /// One `row_choices` item: a strict object of `batch_id`, `row_id` and `choice`.
    static func choiceItem(_ value: JSValue, issues: inout [String]) -> RowChoiceInput? {
        guard case .object(let object) = value else {
            issues.append("Invalid input: expected object, received \(value.zodTypeName)")
            return nil
        }
        var batchId: PortfolioImportBatchNumericID?
        if case .number(let number)? = object["batch_id"] {
            if number.rounded() != number {
                issues.append("Invalid input: expected int, received number")
            } else if number <= 0 {
                issues.append("Too small: expected number to be >0")
            } else if number > ImportBatchesArea.maxSafeId {
                issues.append("Too big: expected number to be <=9007199254740991")
            } else {
                batchId = PortfolioImportBatchNumericID(Int(number))
            }
        } else {
            issues.append(
                "Invalid input: expected number, received \(object["batch_id"].map { $0.zodTypeName } ?? "undefined")")
        }
        var rowId: PortfolioImportRowID?
        if case .number(let number)? = object["row_id"] {
            if number.rounded() != number {
                issues.append("Invalid input: expected int, received number")
            } else if number <= 0 {
                issues.append("Too small: expected number to be >0")
            } else if number > ImportBatchesArea.maxSafeId {
                issues.append("Too big: expected number to be <=9007199254740991")
            } else {
                rowId = PortfolioImportRowID(Int(number))
            }
        } else {
            issues.append(
                "Invalid input: expected number, received \(object["row_id"].map { $0.zodTypeName } ?? "undefined")")
        }
        var choice: String?
        if case .string(let text)? = object["choice"],
            text == "keep_both" || text == "same_transaction"  // lint:allow string-literal-compare the row_choices enum values
        {
            choice = text
        } else {
            issues.append(
                "Invalid option: expected one of \"keep_both\"|\"same_transaction\"")
        }
        for key in object.keys where !["batch_id", "row_id", "choice"].contains(key) {
            issues.append("Unrecognized key: \"\(key)\"")
        }
        if let batchId, let rowId, let choice {
            return RowChoiceInput(batchID: batchId, rowID: rowId, choice: choice)
        }
        return nil
    }

    // MARK: - Reads

    /// A row the row contract would refuse: the 500 the TypeScript read answers through
    /// `checkedRow`.
    struct SourceRowError: Error, Sendable {
        var column: String
    }

    /// `requiredValue`: a server fault when an invariant the corpus cannot reach breaks.
    struct RequiredValueError: Error, Sendable {
        var message: String
    }

    /// `readReconciliationBatchScope`: the selected batches, id-ordered.
    static func readBatchScope(
        _ session: BackendSession, _ ids: [Int]
    ) throws -> [ReconciliationBatchScopeRow] {
        let placeholders = ids.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT id, account_id, custom_config FROM portfolio_import_batches
             WHERE id IN (\(placeholders)) ORDER BY id
            """,
            ids.map { .integer(Int64($0)) })
        return try rows.map { row in
            ReconciliationBatchScopeRow(
                id: PortfolioImportBatchNumericID(Int(try row.int64("id"))),
                accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
                    .map(AccountID.init(rawValue:)),
                customConfig: (try row.optionalText("custom_config")).map(storedConfig))
        }
    }

    /// `storedBatchConfigSchema`: the stored jsonb text parses to the object the plan reads.
    static func storedConfig(_ text: String) -> StoredBatchConfig {
        guard let value = JSValue.parse(text), case .object(let object) = value else {
            return .text(text)
        }
        return .object(object)
    }

    /// One json/jsonb column as an object, or nil.
    static func jsonObject(_ row: SQLRow, _ column: String) throws -> JSObject? {
        guard let text = try row.optionalText(column), let value = JSValue.parse(text),
            case .object(let object) = value
        else { return nil }
        return object
    }

    /// `readReconciliationSources`: every staged row of the scope with its batch and its
    /// effective investment, ordered by batch, row index, then id. The duplicate `tx_date` of
    /// the Kysely read is explicit here (Swift takes the first column of a duplicated name,
    /// bun the last), so the projected day is the only one selected.
    static func readSources(
        _ session: BackendSession, _ ids: [Int]
    ) throws -> [ReconciliationSourceRow] {
        let placeholders = ids.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT s.id, s.batch_id, s.row_index, s.status, s.route, s.type, s.type_raw,
                   s.symbol_raw, s.name_raw, s.units, s.price_per_unit, s.amount, s.fees, s.taxes,
                   s.currency, s.fx_rate_to_eur, s.note, s.raw_data, s.source_transaction_id,
                   s.source_account_identity, s.source_record_hash, s.dedup_fingerprint,
                   s.dedup_fingerprint_version, s.dedup_occurrence, s.asset_transfer_details,
                   s.asset_adjustment_details, s.resolved_investment_id, s.user_override_investment_id,
                   to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date,
                   COALESCE(s.user_override_investment_id, s.resolved_investment_id) AS investment_id,
                   i.asset_class, i.currency AS investment_currency,
                   b.account_id, b.custom_config
              FROM portfolio_import_staging_rows s
              INNER JOIN portfolio_import_batches b ON b.id = s.batch_id
              LEFT JOIN investments i
                 ON i.id = COALESCE(s.user_override_investment_id, s.resolved_investment_id)
             WHERE s.batch_id IN (\(placeholders))
             ORDER BY s.batch_id, s.row_index, s.id
            """,
            ids.map { .integer(Int64($0)) })
        return try rows.map { row in
            guard
                let currency = (try row.optionalText("currency"))
                    .flatMap(CurrencyCode.init(rawValue:))
            else { throw SourceRowError(column: "currency") }
            if let text = try row.optionalText("investment_currency"),
                CurrencyCode(rawValue: text) == nil
            {
                throw SourceRowError(column: "investment_currency")
            }
            return ReconciliationSourceRow(
                id: PortfolioImportRowID(Int(try row.int64("id"))),
                batchID: PortfolioImportBatchNumericID(Int(try row.int64("batch_id"))),
                rowIndex: Int(try row.int64("row_index")),
                status: StagingStatus(rawValue: try row.text("status")),
                route: (try row.optionalText("route")).map(StagingRoute.init(rawValue:)),
                kind: (try row.optionalText("type")).map(PortfolioEventKind.init(rawValue:)),
                kindRaw: try row.optionalText("type_raw"),
                day: try row.optionalText("tx_date"),
                amount: try row.optionalText("amount"),
                units: try row.optionalText("units"),
                pricePerUnit: try row.optionalText("price_per_unit"),
                fees: try row.optionalText("fees"),
                taxes: try row.optionalText("taxes"),
                currency: currency,
                fxRateToEUR: try row.optionalText("fx_rate_to_eur"),
                note: try row.optionalText("note"),
                rawData: try row.optionalText("raw_data"),
                symbolRaw: try row.optionalText("symbol_raw"),
                sourceReference: try row.optionalText("source_transaction_id"),
                sourceAccountIdentity: try row.optionalText("source_account_identity"),
                sourceRecordHash: try row.optionalText("source_record_hash"),
                dedupFingerprint: try row.optionalText("dedup_fingerprint"),
                dedupFingerprintVersion: try row.optionalInt64("dedup_fingerprint_version")
                    .flatMap { Int(exactly: $0) },
                assetTransferDetails: try jsonObject(row, "asset_transfer_details"),
                assetAdjustmentDetails: try jsonObject(row, "asset_adjustment_details"),
                investmentID: try row.optionalInt64("investment_id").flatMap { Int(exactly: $0) }
                    .map(InvestmentID.init(rawValue:)),
                resolvedInvestmentID: try row.optionalInt64("resolved_investment_id")
                    .flatMap { Int(exactly: $0) }.map(InvestmentID.init(rawValue:)),
                userOverrideInvestmentID: try row.optionalInt64("user_override_investment_id")
                    .flatMap { Int(exactly: $0) }.map(InvestmentID.init(rawValue:)),
                assetClass: try row.optionalText("asset_class"),
                investmentCurrency: (try row.optionalText("investment_currency"))
                    .flatMap(CurrencyCode.init(rawValue:)),
                accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
                    .map(AccountID.init(rawValue:)),
                customConfig: (try row.optionalText("custom_config")).map(storedConfig))
        }
    }

    /// `readReconciliationHistory`: the snapshot rows, then the custody events, in the
    /// repository's concat order.
    static func readHistory(
        _ session: BackendSession, _ investmentIds: [Int]
    ) throws -> [HistoryImage] {
        if investmentIds.isEmpty { return [] }
        let placeholders = investmentIds.map { _ in "?" }.joined(separator: ", ")
        let arguments = investmentIds.map { SQLValue.integer(Int64($0)) }
        let snapshotRows = try session.rows(
            """
            SELECT \(try SchemaFunctions.snapshotSQL(alias: "pt")) AS snapshot
              FROM portfolio_transactions pt
             WHERE pt.investment_id IN (\(placeholders))
             ORDER BY pt.investment_id, pt.date, pt.id
            """,
            arguments)
        var history: [HistoryImage] = []
        for row in snapshotRows {
            guard let text = try row.optionalText("snapshot"), let value = JSValue.parse(text),
                case .object(let snapshot) = value
            else { throw SourceRowError(column: "snapshot") }
            history.append(try historyImage(snapshot))
        }
        let transfers = try session.rows(
            """
            SELECT t.id, t.investment_id, t.source_account_id, t.destination_account_id,
                   to_char(t.date, 'YYYY-MM-DD') AS date, t.units, t.fee_units, t.import_batch_id,
                   t.staging_row_id, t.source_record_hash, t.dedup_fingerprint,
                   t.dedup_fingerprint_version
              FROM portfolio_asset_transfers t
             WHERE t.investment_id IN (\(placeholders))
             ORDER BY t.investment_id, t.date, t.id
            """,
            arguments)
        for row in transfers {
            history.append(HistoryImage(
                id: LedgerTransactionID(Int(try row.int64("id"))),
                investmentID: InvestmentID(Int(try row.int64("investment_id"))),
                kind: PortfolioEventKind.assetTransfer,
                day: try row.text("date"),
                amount: "0",
                units: nil,
                pricePerUnit: nil,
                fees: "0",
                taxes: "0",
                currency: nil,
                fxRateToEUR: nil,
                accountID: try row.optionalInt64("source_account_id").flatMap { Int(exactly: $0) }
                    .map(AccountID.init(rawValue:)),
                note: nil,
                dividendAmountConvention: nil,
                isRecurring: nil,
                recurrenceInterval: nil,
                recurrenceEndDay: nil,
                importBatchID: (try row.optionalText("import_batch_id"))
                    .map(PortfolioImportBatchID.init(rawValue:)),
                sourceRecordHash: try row.optionalText("source_record_hash"),
                dedupFingerprint: try row.optionalText("dedup_fingerprint"),
                dedupFingerprintVersion: try row.optionalInt64("dedup_fingerprint_version")
                    .flatMap { Int(exactly: $0) },
                sourceAccountID: try row.optionalInt64("source_account_id")
                    .flatMap { Int(exactly: $0) }.map(AccountID.init(rawValue:)),
                destinationAccountID: try row.optionalInt64("destination_account_id")
                    .flatMap { Int(exactly: $0) }.map(AccountID.init(rawValue:)),
                feeUnits: try row.optionalText("fee_units"),
                adjustmentKind: nil,
                basisPolicy: nil))
        }
        let adjustments = try session.rows(
            """
            SELECT a.id, a.investment_id, a.account_id, to_char(a.date, 'YYYY-MM-DD') AS date,
                   a.units, a.adjustment_kind, a.basis_policy, a.import_batch_id, a.staging_row_id,
                   a.source_record_hash, a.dedup_fingerprint, a.dedup_fingerprint_version
              FROM portfolio_asset_adjustments a
             WHERE a.investment_id IN (\(placeholders))
             ORDER BY a.investment_id, a.date, a.id
            """,
            arguments)
        for row in adjustments {
            history.append(HistoryImage(
                id: LedgerTransactionID(Int(try row.int64("id"))),
                investmentID: InvestmentID(Int(try row.int64("investment_id"))),
                kind: PortfolioEventKind.assetAdjustment,
                day: try row.text("date"),
                amount: "0",
                units: nil,
                pricePerUnit: nil,
                fees: "0",
                taxes: "0",
                currency: nil,
                fxRateToEUR: nil,
                accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
                    .map(AccountID.init(rawValue:)),
                note: nil,
                dividendAmountConvention: nil,
                isRecurring: nil,
                recurrenceInterval: nil,
                recurrenceEndDay: nil,
                importBatchID: (try row.optionalText("import_batch_id"))
                    .map(PortfolioImportBatchID.init(rawValue:)),
                sourceRecordHash: try row.optionalText("source_record_hash"),
                dedupFingerprint: try row.optionalText("dedup_fingerprint"),
                dedupFingerprintVersion: try row.optionalInt64("dedup_fingerprint_version")
                    .flatMap { Int(exactly: $0) },
                sourceAccountID: nil,
                destinationAccountID: nil,
                feeUnits: nil,
                adjustmentKind: try row.optionalText("adjustment_kind"),
                basisPolicy: try row.optionalText("basis_policy")))
        }
        return history
    }

    /// `portfolioTransactionSnapshotSchema` as `HistoryImage` reads it.
    static func historyImage(_ snapshot: JSObject) throws -> HistoryImage {
        func text(_ key: String) -> String? {
            guard case .string(let value)? = snapshot[key] else { return nil }
            return value
        }
        func number(_ key: String) -> Int? {
            guard case .number(let value)? = snapshot[key] else { return nil }
            return Int(value)
        }
        var isRecurring: Bool?
        if case .bool(let flag)? = snapshot["is_recurring"] { isRecurring = flag }
        guard let id = number("id"), let investmentID = number("investment_id"),
            let kind = text("type"), let day = text("date"), let amount = text("amount")
        else { throw SourceRowError(column: "snapshot") }
        return HistoryImage(
            id: LedgerTransactionID(id),
            investmentID: InvestmentID(investmentID),
            kind: PortfolioEventKind(rawValue: kind),
            day: day,
            amount: amount,
            units: text("units"),
            pricePerUnit: text("price_per_unit"),
            fees: text("fees") ?? "0",
            taxes: text("taxes") ?? "0",
            currency: text("currency").flatMap(CurrencyCode.init(rawValue:)),
            fxRateToEUR: text("fx_rate_to_eur"),
            accountID: number("account_id").map(AccountID.init(rawValue:)),
            note: text("note"),
            dividendAmountConvention: text("dividend_amount_convention"),
            isRecurring: isRecurring,
            recurrenceInterval: text("recurrence_interval"),
            recurrenceEndDay: text("recurrence_end_date"),
            importBatchID: text("import_batch_id").map(PortfolioImportBatchID.init(rawValue:)),
            sourceRecordHash: text("source_record_hash"),
            dedupFingerprint: text("dedup_fingerprint"),
            dedupFingerprintVersion: number("dedup_fingerprint_version"),
            sourceAccountID: nil,
            destinationAccountID: nil,
            feeUnits: nil,
            adjustmentKind: nil,
            basisPolicy: nil)
    }

    /// `readHistorySourceIds`: every `format\0source id` an imported history transaction was
    /// recorded from, keyed by the transaction, appended in the SQL's order.
    static func readHistorySourceKeys(
        _ session: BackendSession, _ transactionIds: [Int]
    ) throws -> [LedgerTransactionID: [String]] {
        var keys: [LedgerTransactionID: [String]] = [:]
        guard !transactionIds.isEmpty else { return keys }
        let placeholders = transactionIds.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT DISTINCT pt.id, s.source_transaction_id, b.custom_config ->> 'format' AS format
              FROM portfolio_transactions pt
              JOIN portfolio_import_staging_rows s
                ON s.dedup_fingerprint = pt.dedup_fingerprint
               AND s.dedup_fingerprint_version = pt.dedup_fingerprint_version
               AND s.status IN ('committed', 'duplicate')
              JOIN portfolio_import_batches b ON b.id = s.batch_id
             WHERE pt.id IN (\(placeholders))
               AND pt.dedup_fingerprint IS NOT NULL
               AND NULLIF(trim(s.source_transaction_id), '') IS NOT NULL
               AND NULLIF(b.custom_config ->> 'format', '') IS NOT NULL
             ORDER BY pt.id, format, s.source_transaction_id
            """,
            transactionIds.map { .integer(Int64($0)) })
        for row in rows {
            let id = LedgerTransactionID(Int(try row.int64("id")))
            guard let format = try row.optionalText("format"),
                let reference = try row.optionalText("source_transaction_id")
            else { continue }
            let normalized = ImportInterop.normalizeIdentityText(reference)
            if normalized.isEmpty { continue }
            keys[id, default: []].append("\(format)\u{0}\(normalized)")
        }
        return keys
    }

    /// `readReconciledProImportAccounts`: the accounts a complete Nexo Pro spot import holds.
    static func readReconciledProAccounts(
        _ session: BackendSession, _ accountIds: [Int]
    ) throws -> [AccountID] {
        guard !accountIds.isEmpty else { return [] }
        let placeholders = accountIds.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT DISTINCT b.account_id FROM portfolio_import_batches b
             WHERE b.account_id IN (\(placeholders)) AND b.status = 'complete'
               AND (b.adapter_name = 'nexo_pro_spot_history'
                    OR b.custom_config ->> 'format' = 'nexo_pro_spot_history')
               AND EXISTS (SELECT 1 FROM portfolio_import_staging_rows s WHERE s.batch_id = b.id
                 AND s.route = 'portfolio' AND s.type IN ('buy','sell')
                 AND s.status IN ('committed','duplicate'))
             ORDER BY b.account_id
            """,
            accountIds.map { .integer(Int64($0)) })
        return try rows.compactMap { row in
            try row.optionalInt64("account_id").flatMap { Int(exactly: $0) }
                .map(AccountID.init(rawValue:))
        }
    }

    /// `readCrossFormatLedgerSources`: settled rows of the other cross-format batches whose
    /// ledger event still exists.
    static func readCrossFormatLedgerSources(
        _ session: BackendSession, _ accountIds: [Int], _ excludedBatchIds: [Int]
    ) throws -> [CrossFormatLedgerSourceRow] {
        guard !accountIds.isEmpty else { return [] }
        let accounts = accountIds.map { _ in "?" }.joined(separator: ", ")
        let excluded = excludedBatchIds.map { _ in "?" }.joined(separator: ", ")
        var arguments = accountIds.map { SQLValue.integer(Int64($0)) }
        arguments += excludedBatchIds.map { SQLValue.integer(Int64($0)) }
        let rows = try session.rows(
            """
            SELECT s.id, s.batch_id, s.status, s.route, s.type AS type, s.type_raw,
                   to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date, s.units, s.amount, s.currency,
                   s.raw_data, s.source_transaction_id, s.source_account_identity,
                   s.dedup_fingerprint, s.dedup_fingerprint_version,
                   COALESCE(s.user_override_investment_id, s.resolved_investment_id) AS investment_id,
                   b.account_id, b.custom_config,
                   CASE WHEN pt.id IS NOT NULL THEN 'portfolio' ELSE 'cash' END AS ledger,
                   COALESCE(pt.id, t.id) AS transaction_id,
                   to_char(t.date, 'YYYY-MM-DD') AS ledger_date,
                   t.amount AS ledger_amount, t.currency AS ledger_currency
              FROM portfolio_import_staging_rows s
              JOIN portfolio_import_batches b ON b.id = s.batch_id
              LEFT JOIN portfolio_transactions pt ON pt.id = (
                SELECT p.id FROM portfolio_transactions p
                 WHERE s.route IS NOT 'cash'
                   AND p.dedup_fingerprint = s.dedup_fingerprint
                   AND p.dedup_fingerprint_version = s.dedup_fingerprint_version
                 ORDER BY p.id LIMIT 1)
              LEFT JOIN transactions t ON t.id = (
                SELECT c.id FROM transactions c
                 WHERE s.route = 'cash' AND c.account_id = b.account_id AND c.is_active
                   AND c.dedup_fingerprint = s.dedup_fingerprint
                   AND c.dedup_fingerprint_version = s.dedup_fingerprint_version
                 ORDER BY c.id LIMIT 1)
             WHERE b.account_id IN (\(accounts))
               AND b.id NOT IN (\(excluded))
               AND b.custom_config ->> 'format'
                   IN ('saxo_transaction_history', 'ibkr_transaction_history', 'ibkr_funding_history')
               AND s.status IN ('committed', 'duplicate')
               AND s.dedup_fingerprint IS NOT NULL
               AND (pt.id IS NOT NULL OR t.id IS NOT NULL)
             ORDER BY s.batch_id, s.row_index, s.id
            """,
            arguments)
        return try rows.map { row in
            guard
                let currency = (try row.optionalText("currency"))
                    .flatMap(CurrencyCode.init(rawValue:))
            else { throw SourceRowError(column: "currency") }
            return CrossFormatLedgerSourceRow(
                id: PortfolioImportRowID(Int(try row.int64("id"))),
                batchID: PortfolioImportBatchNumericID(Int(try row.int64("batch_id"))),
                status: StagingStatus(rawValue: try row.text("status")),
                route: (try row.optionalText("route")).map(StagingRoute.init(rawValue:)),
                kind: (try row.optionalText("type")).map(PortfolioEventKind.init(rawValue:)),
                kindRaw: try row.optionalText("type_raw"),
                day: try row.optionalText("tx_date"),
                units: try row.optionalText("units"),
                amount: try row.optionalText("amount"),
                currency: currency,
                rawData: try row.optionalText("raw_data"),
                sourceReference: try row.optionalText("source_transaction_id"),
                sourceAccountIdentity: try row.optionalText("source_account_identity"),
                dedupFingerprint: try row.optionalText("dedup_fingerprint"),
                dedupFingerprintVersion: try row.optionalInt64("dedup_fingerprint_version")
                    .flatMap { Int(exactly: $0) },
                investmentID: try row.optionalInt64("investment_id").flatMap { Int(exactly: $0) }
                    .map(InvestmentID.init(rawValue:)),
                accountID: (try row.optionalInt64("account_id").flatMap { Int(exactly: $0) })
                    .map(AccountID.init(rawValue:)) ?? AccountID(0),
                customConfig: (try row.optionalText("custom_config")).map(storedConfig),
                ledger: SourceLedger(rawValue: try row.text("ledger")) ?? .cash,
                transactionID: LedgerTransactionID(Int(try row.int64("transaction_id"))),
                ledgerDay: try row.optionalText("ledger_date"),
                ledgerAmount: try row.optionalText("ledger_amount"),
                ledgerCurrency: (try row.optionalText("ledger_currency"))
                    .flatMap(CurrencyCode.init(rawValue:)))
        }
    }

    /// `version:fingerprint`, the identity a ledger transaction carries.
    static func identity(_ fingerprint: String?, _ version: Int?) -> String? {
        guard let fingerprint, !fingerprint.isEmpty else { return nil }
        return "\(version.map(String.init) ?? "null"):\(fingerprint)"
    }

    /// `readCrossFormatSettledIdentities`.
    static func readSettledIdentities(
        _ session: BackendSession, _ accountIds: [Int], _ excludedBatchIds: [Int]
    ) throws -> Set<String> {
        guard !accountIds.isEmpty else { return [] }
        let accounts = accountIds.map { _ in "?" }.joined(separator: ", ")
        let excluded = excludedBatchIds.map { _ in "?" }.joined(separator: ", ")
        var arguments = accountIds.map { SQLValue.integer(Int64($0)) }
        arguments += excludedBatchIds.map { SQLValue.integer(Int64($0)) }
        let rows = try session.rows(
            """
            SELECT DISTINCT s.dedup_fingerprint, s.dedup_fingerprint_version
              FROM portfolio_import_staging_rows s
              JOIN portfolio_import_batches b ON b.id = s.batch_id
             WHERE b.account_id IN (\(accounts))
               AND b.id NOT IN (\(excluded))
               AND b.custom_config ->> 'format'
                   IN ('saxo_transaction_history', 'ibkr_transaction_history', 'ibkr_funding_history')
               AND s.status = 'duplicate'
               AND s.dedup_fingerprint IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM portfolio_transactions p
                  WHERE p.dedup_fingerprint = s.dedup_fingerprint
                    AND p.dedup_fingerprint_version = s.dedup_fingerprint_version)
               AND NOT EXISTS (SELECT 1 FROM transactions c
                  WHERE c.is_active AND c.account_id = b.account_id
                    AND c.dedup_fingerprint = s.dedup_fingerprint
                    AND c.dedup_fingerprint_version = s.dedup_fingerprint_version)
            """,
            arguments)
        var identities: Set<String> = []
        for row in rows {
            if let value = identity(
                try row.optionalText("dedup_fingerprint"),
                try row.optionalInt64("dedup_fingerprint_version").flatMap({ Int(exactly: $0) }))
            {
                identities.insert(value)
            }
        }
        return identities
    }

    /// `readCashLedgerFingerprints`.
    static func readCashLedgerFingerprints(
        _ session: BackendSession, _ fingerprints: [String]
    ) throws -> Set<String> {
        guard !fingerprints.isEmpty else { return [] }
        let unique = Array(Set(fingerprints))
        let placeholders = unique.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT DISTINCT dedup_fingerprint, dedup_fingerprint_version FROM transactions
             WHERE dedup_fingerprint IN (\(placeholders))
            """,
            unique.map { .text($0) })
        var identities: Set<String> = []
        for row in rows {
            if let value = identity(
                try row.optionalText("dedup_fingerprint"),
                try row.optionalInt64("dedup_fingerprint_version").flatMap({ Int(exactly: $0) }))
            {
                identities.insert(value)
            }
        }
        return identities
    }

    /// `readActiveIbkrCashReceipts` narrowed to the corrected aliases: the funding
    /// fingerprints a later IBKR correction replaced (`undefined` where the receipt's
    /// snapshot carries no version, as the template literal renders it).
    static func readCorrectedAliases(_ session: BackendSession) throws -> Set<String> {
        let rows = try session.rows(
            """
            SELECT a.before_data
              FROM portfolio_import_reconciliation_journal a
             WHERE a.action = 'adopt' AND a.after_data ->> 'ledgerKind' = 'cash'
               AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal r
                                WHERE r.previous_entry_id = a.id)
             ORDER BY a.id
            """)
        var aliases: Set<String> = []
        for row in rows {
            guard let text = try row.optionalText("before_data"),
                let value = JSValue.parse(text), case .object(let before) = value,
                case .object(let snapshot)? = before["snapshot"],
                case .string(let fingerprint)? = snapshot["dedup_fingerprint"]
            else { continue }
            let version: String
            if case .number(let number)? = snapshot["dedup_fingerprint_version"],
                number.rounded() == number
            {
                version = String(Int(number))
            } else {
                version = "undefined"
            }
            aliases.insert("\(version):\(fingerprint)")
        }
        return aliases
    }

    /// `readManualCashCandidates`: active cash transactions no import owns.
    static func readManualCashCandidates(
        _ session: BackendSession, _ accountIds: [Int], _ from: String, _ to: String
    ) throws -> [ManualCashCandidateRow] {
        guard !accountIds.isEmpty else { return [] }
        let placeholders = accountIds.map { _ in "?" }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT id, account_id, to_char(date, 'YYYY-MM-DD') AS date, amount, currency
              FROM transactions
             WHERE account_id IN (\(placeholders)) AND is_active
               AND dedup_fingerprint IS NULL AND source_record_hash IS NULL
               AND date BETWEEN ? AND ?
             ORDER BY date, id
            """,
            accountIds.map { .integer(Int64($0)) } + [.text(from), .text(to)])
        return try rows.map { row in
            guard
                let currency = (try row.optionalText("currency"))
                    .flatMap(CurrencyCode.init(rawValue:))
            else { throw SourceRowError(column: "currency") }
            return ManualCashCandidateRow(
                id: LedgerTransactionID(Int(try row.int64("id"))),
                accountID: AccountID(Int(try row.int64("account_id"))),
                day: try row.text("date"),
                amount: try row.text("amount"),
                currency: currency)
        }
    }

    /// `getEligibleYieldSourceHashes` (`portfolioAssetAdjustmentRepository.ts`).
    static func eligibleYieldSourceHashes(
        _ session: BackendSession, investmentId: Int, accountId: Int?  // lint:allow raw-id the ids the repository query binds
    ) throws -> [String] {
        guard let accountId else { return [] }
        let rows = try session.rows(
            """
            SELECT s.source_record_hash
              FROM portfolio_import_staging_rows s
              INNER JOIN portfolio_import_batches b ON b.id = s.batch_id
             WHERE COALESCE(s.user_override_investment_id, s.resolved_investment_id) = ?
               AND b.account_id = ?
               AND s.type = 'gift'
               AND s.asset_adjustment_details ->> 'kind' = 'yield_acquisition'
               AND s.asset_adjustment_details ->> 'basisPolicy' = 'zero'
               AND s.status IN ('matched', 'committed', 'duplicate')
               AND s.source_record_hash IS NOT NULL
             GROUP BY s.source_record_hash
             ORDER BY s.source_record_hash
            """,
            [.integer(Int64(investmentId)), .integer(Int64(accountId))])
        return try rows.map { try $0.text("source_record_hash") }
    }

    /// `shift`: `date + days` over UTC midnights, as the ISO text's day.
    static func shiftDay(_ day: String, _ days: Int) throws -> String {
        guard let instant = Instant("\(day)T00:00:00.000Z") else {
            throw SourceRowError(column: "tx_date")
        }
        let shifted = Instant(date: instant.date.addingTimeInterval(Double(days) * 86400))
        return String(shifted.text.prefix(10))
    }
    // MARK: - Preview

    /// `previewPortfolioImportReconciliation`: the whole `loadPlan` plus the
    /// projected-history guard, inside the read transaction the service wraps it in.
    static func preview(
        _ session: BackendSession, _ scope: (
            batchIds: [Int], adoptPolicy: String?, batchPolicies: [BatchPolicyInput],
            rowChoices: [RowChoiceInput]
        )
    ) throws -> HandlerResult {
        var ids = Array(Set(scope.batchIds))
        ids.sort()
        let batches = try readBatchScope(session, ids)
        guard batches.count == ids.count else {
            throw BackendHTTPError.validation(
                "Reconciliation scope contains a missing import batch")
        }
        var rows = try readSources(session, ids)
        for index in rows.indices
        where rows[index].assetAdjustmentDetails?["kind"]?.stringValue == "yield_reversal"  // lint:allow string-literal-compare the staged adjustment detail kinds
        {
            guard var details = rows[index].assetAdjustmentDetails else {
                throw RequiredValueError(
                    message: "the filter above selected rows with adjustment details")
            }
            let accountId: Int?  // lint:allow raw-id the id the repository query binds
            if let value = details["accountId"], value != .null {
                let number = value.javaScriptNumber
                accountId = number.isFinite && number == number.rounded() ? Int(number) : nil
            } else {
                accountId = rows[index].accountID?.rawValue
            }
            let hashes = try eligibleYieldSourceHashes(
                session, investmentId: rows[index].investmentID?.rawValue ?? 0, accountId: accountId)
            details["eligibleSourceRecordHashes"] = .array(hashes.map(JSONValue.string))
            rows[index].assetAdjustmentDetails = details
        }
        var investmentIds: [Int] = []
        for row in rows {
            if let investmentId = row.investmentID?.rawValue,
                investmentId != 0, !investmentIds.contains(investmentId)
            {
                investmentIds.append(investmentId)
            }
        }
        let history = try readHistory(session, investmentIds)
        let historySourceKeys = try readHistorySourceKeys(
            session,
            history
                .filter { image in
                    image.dedupFingerprint != nil
                        && image.kind != PortfolioEventKind.assetTransfer
                        && image.kind != PortfolioEventKind.assetAdjustment
                }
                .map { $0.id.rawValue })
        var accountIds: [AccountID] = []
        for batch in batches {
            if let accountId = batch.accountID,
                !accountIds.contains(where: { $0 == accountId })
            {
                accountIds.append(accountId)
            }
        }
        let priorProAccounts = try readReconciledProAccounts(
            session, accountIds.map { $0.rawValue })
        let cashRows = rows.filter { $0.route == StagingRoute.cash && $0.day != nil }
        let cashDays = cashRows.compactMap { $0.day }.sorted()
        var manualCash: [ManualCashCandidateRow] = []
        if let first = cashDays.first, let last = cashDays.last {
            manualCash = try readManualCashCandidates(
                session, accountIds.map { $0.rawValue },
                try shiftDay(first, -7), try shiftDay(last, 7))
        }
        let crossFormat = CrossFormatContext(
            ledgerSources: try readCrossFormatLedgerSources(
                session, accountIds.map { $0.rawValue }, ids),
            cashFingerprints: try readCashLedgerFingerprints(
                session, cashRows.compactMap { $0.dedupFingerprint }),
            correctedAliases: try readCorrectedAliases(session),
            manualCash: manualCash,
            settledIdentities: try readSettledIdentities(
                session, accountIds.map { $0.rawValue }, ids))
        let result = try PortfolioImportReconciliation.buildPlan(ReconciliationPlanInput(
            rows: rows, history: history, batches: batches, adoptPolicy: scope.adoptPolicy,
            batchPolicies: scope.batchPolicies, priorProAccounts: priorProAccounts,
            crossFormat: crossFormat, historySourceKeys: historySourceKeys,
            rowChoices: scope.rowChoices))
        var plan = result.plan
        if plan.ready {
            let projected = try projectedHistory(result, rows: rows, history: history)
            do {
                try assertProjectedHistory(history, projected)
            } catch let error as BackendHTTPError where error.status == 409 {
                let row =
                    rows.first {
                        $0.route == StagingRoute.assetTransfer
                            || $0.route == StagingRoute.assetAdjustment
                    } ?? rows.first
                plan.blockers.append(PlanIssue(
                    batchID: row.map { $0.batchID }
                        ?? PortfolioImportBatchNumericID(ids.first ?? 0),
                    rowID: row?.id ?? PortfolioImportRowID(0),
                    rowOrdinal: (row?.rowIndex ?? 0) + 1,
                    reason: ReconciliationBlockReason.projectedHistoryConflict,
                    candidateTransactionIDs: []))
                plan.ready = false
            }
        }
        return HandlerResult(data: plan.jsonValue)
    }

    /// A row of the projected history: the fields `assertProjectedHistory` and the partition
    /// engines read (`NullablePartitionedTxn`).
    struct ProjectedEvent {
        var id: Double
        var investmentID: Int  // lint:allow raw-id the projected event's ids the partition engine reads
        var kind: String
        var day: String?
        var amount: String?
        var units: String?
        var fees: String?
        var taxes: String?
        var accountID: Int?  // lint:allow raw-id the projected event's ids the partition engine reads
        var sourceAccountID: Int?  // lint:allow raw-id the projected event's ids the partition engine reads
        var destinationAccountID: Int?  // lint:allow raw-id the projected event's ids the partition engine reads
        var feeUnits: String?
    }

    /// `projectedReconciliationHistory`: the history with the adoptions applied, then the
    /// proposed events in the commit's writer order (the two event tables share a sequence).
    static func projectedHistory(
        _ result: ReconciliationPlanResult, rows: [ReconciliationSourceRow], history: [HistoryImage]
    ) throws -> [ProjectedEvent] {
        var replacements: [LedgerTransactionID: HistoryImage] = [:]
        for adoption in result.adoptions {
            replacements[adoption.before.id] = adoption.after
        }
        var projected = history.map { image -> ProjectedEvent in
            let replaced = replacements[image.id] ?? image
            return ProjectedEvent(
                id: Double(replaced.id.rawValue), investmentID: replaced.investmentID.rawValue,
                kind: replaced.kind.rawValue, day: replaced.day, amount: replaced.amount,
                units: replaced.units, fees: replaced.fees, taxes: replaced.taxes,
                accountID: replaced.accountID?.rawValue,
                sourceAccountID: replaced.sourceAccountID?.rawValue,
                destinationAccountID: replaced.destinationAccountID?.rawValue,
                feeUnits: replaced.feeUnits)
        }
        var proposedActions: [(action: PlanAction, row: ReconciliationSourceRow)] = []
        for action in result.plan.actions
        where [.insert, .transfer, .adjustment].contains(action.action) {
            guard let row = rows.first(where: { $0.id.rawValue == action.rowID.rawValue }) else {
                throw RequiredValueError(
                    message: "insert, transfer and adjustment actions come from these matched rows")
            }
            proposedActions.append((action, row))
        }
        try proposedActions.sort { left, right in
            let leftDate = try matchedSourceDate(left.row)
            let rightDate = try matchedSourceDate(right.row)
            let byDate = leftDate.utf16Compare(rightDate)
            if byDate != 0 { return byDate < 0 }
            let byBatch = left.row.batchID.rawValue - right.row.batchID.rawValue
            if byBatch != 0 { return byBatch < 0 }
            return left.row.rowIndex < right.row.rowIndex
        }
        let base = Double(Int.max) - Double(proposedActions.count)
        for (index, proposed) in proposedActions.enumerated() {
            let id = base + Double(index)
            switch proposed.action.action {
            case .transfer:
                let preview = try PortfolioCustodyPreviews.assetTransfer(proposed.row)
                guard case .event(let event) = preview else {
                    throw BackendHTTPError.conflict(
                        "Reviewed custody source changed during commit preparation")
                }
                projected.append(ProjectedEvent(
                    id: id, investmentID: event.investmentID.rawValue,
                    kind: PortfolioEventKind.assetTransfer.rawValue, day: event.day,
                    amount: "0", units: event.units, fees: "0", taxes: "0",
                    accountID: proposed.row.accountID?.rawValue,
                    sourceAccountID: event.sourceAccountID.rawValue,
                    destinationAccountID: event.destinationAccountID.rawValue,
                    feeUnits: event.feeUnits))
            case .adjustment:
                let preview = try PortfolioCustodyPreviews.assetAdjustment(proposed.row)
                guard case .event(let event) = preview else {
                    throw BackendHTTPError.conflict(
                        "Reviewed custody source changed during commit preparation")
                }
                projected.append(ProjectedEvent(
                    id: id, investmentID: event.investmentID.rawValue,
                    kind: PortfolioEventKind.assetAdjustment.rawValue, day: event.day,
                    amount: "0", units: event.units, fees: "0", taxes: "0",
                    accountID: event.accountID.rawValue, sourceAccountID: nil,
                    destinationAccountID: nil, feeUnits: nil))
            default:
                guard case .transaction(let values, _)? = proposed.action.source,
                    let investmentID = proposed.action.investmentID.flatMap({ $0 })
                else {
                    throw RequiredValueError(message: "the plan carries the insert's source")
                }
                projected.append(ProjectedEvent(
                    id: id, investmentID: investmentID.rawValue,
                    kind: values.type ?? "", day: values.date, amount: values.amount,
                    units: values.units, fees: values.fees, taxes: values.taxes,
                    accountID: proposed.row.accountID?.rawValue, sourceAccountID: nil,
                    destinationAccountID: nil, feeUnits: nil))
            }
        }
        return projected
    }

    /// `matchedSourceDate`: a matched row carries its source date.
    static func matchedSourceDate(_ row: ReconciliationSourceRow) throws -> String {
        guard let day = row.day else {
            throw RequiredValueError(message: "a matched row carries its source date")
        }
        return day
    }

    /// One projected event as the shared partition engine reads it.
    static func txn(_ event: ProjectedEvent) -> PortfolioCore.Txn {
        PortfolioCore.Txn(
            id: event.id, type: event.kind, date: event.day ?? "",
            units: event.units.map { PortfolioCore.Numeric.text($0) } ?? .null,
            amount: event.amount.map { PortfolioCore.Numeric.text($0) } ?? .null,
            fees: event.fees.map { PortfolioCore.Numeric.text($0) } ?? .null,
            taxes: event.taxes.map { PortfolioCore.Numeric.text($0) } ?? .null,
            accountId: event.accountID.map(Double.init),
            sourceAccountId: event.sourceAccountID.map(Double.init),
            destinationAccountId: event.destinationAccountID.map(Double.init),
            feeUnits: event.feeUnits.map { PortfolioCore.Numeric.text($0) } ?? .null)
    }

    /// `validatePortfolioAssetTransferHistory` as `assertProjectedHistory` calls it.
    static func validateAssetTransferHistory(_ events: [ProjectedEvent]) throws {
        let txns = events.map(txn)
        guard txns.contains(where: { PortfolioCustody.custodyEventTypes.contains($0.type) }) else {
            return
        }
        guard PortfolioCore.areLotsFullyAssigned(txns) else {
            throw BackendHTTPError.conflict(
                "Asset custody events require the original acquisitions to be reconciled"
                + " to their source accounts")
        }
        do {
            for method in PortfolioCore.costBasisMethods {
                _ = try PortfolioCustody.projectAssetTransferPartitions(txns, method: method)
            }
            if try !PortfolioCore.partitionOversellDeficits(txns).isEmpty {
                throw PortfolioCore.Failure(message: "Custody history contains an oversell")
            }
        } catch let error as BackendHTTPError {
            throw error
        } catch {
            throw BackendHTTPError.conflict(
                "Asset transfer custody history is invalid: \(String(describing: error))")
        }
    }

    /// `assertProjectedHistory`: an adoption may not create or worsen an oversold partition.
    static func assertProjectedHistory(
        _ before: [HistoryImage], _ after: [ProjectedEvent]
    ) throws {
        var investmentIds: [Int] = []
        for event in before {
            if !investmentIds.contains(event.investmentID.rawValue) {
                investmentIds.append(event.investmentID.rawValue)
            }
        }
        for event in after where !investmentIds.contains(event.investmentID) {
            investmentIds.append(event.investmentID)
        }
        for investmentId in investmentIds {
            let beforeRows = before.filter { $0.investmentID.rawValue == investmentId }
                .map { image in
                    ProjectedEvent(
                        id: Double(image.id.rawValue), investmentID: investmentId,
                        kind: image.kind.rawValue, day: image.day, amount: image.amount,
                        units: image.units, fees: image.fees, taxes: image.taxes,
                        accountID: image.accountID?.rawValue,
                        sourceAccountID: image.sourceAccountID?.rawValue,
                        destinationAccountID: image.destinationAccountID?.rawValue,
                        feeUnits: image.feeUnits)
                }
            let afterRows = after.filter { $0.investmentID == investmentId }
            try validateAssetTransferHistory(afterRows)
            let prior = try PortfolioCore.partitionOversellDeficits(beforeRows.map(txn))
            let next = try PortfolioCore.partitionOversellDeficits(afterRows.map(txn))
            for (accountId, deficit) in next {
                if deficit - (prior[accountId] ?? 0) > 1e-8 {
                    throw BackendHTTPError.conflict(
                        "Reconciliation would create or worsen an oversold portfolio partition")
                }
            }
        }
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.PreviewPortfolioImportReconciliation.self) { request in
            let scope = try PortfolioImportReconciliationArea.scopeBody(request)
            return try await database.run { session in
                try session.transaction {
                    try PortfolioImportReconciliationArea.preview(session, scope)
                }
            }
        }
    }
}
