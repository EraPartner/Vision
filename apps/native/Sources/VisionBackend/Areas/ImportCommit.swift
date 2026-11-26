import Foundation
import VisionNativeCore

/// `POST /api/import/batches/:id/commit` (`commitImport` of `services/importPipeline`):
/// the reviewed commit phase — the `committing` claim, the unresolved-recipient errors,
/// the chunked dedup ledger (`commitFingerprintRows`' bulk probe plus the per-row
/// fallback `findImportFingerprint`/`countLegacyImportDuplicates`/`insertImportedRow`),
/// the account resolve-or-create of ADR-088, the batch counters and the post-commit
/// `complete`, with `autoLinkTransactions` clearing matching planned payments.
enum ImportCommitArea {
    /// `COMMIT_CHUNK` of `commit.ts`.
    static let chunkRows = 1000
    /// `UNRESOLVED_RECIPIENT_MESSAGE` of `commit.ts`.
    static let unresolvedRecipientMessage = "unresolved recipient — no recipient was matched or assigned in review"
    /// The pipeline statuses the route lets through (`importRoutes.ts`).
    static let reviewableStatuses = ["awaiting_review", "matched"]
    /// `getAdapter`'s registry, reduced to the capability the commit reads: only the
    /// adapters whose `multiCurrencyCash` is `true`.
    static let multiCurrencyCashAdapters = ["revolut"]

    /// One `matched` staging row with the values the commit path derives from it.
    struct StagedRow: Sendable {
        let id: Int64
        let txDate: String?
        let bankAccount: String?
        let memo: String?
        let amount: String?
        let currency: String?
        let balance: String?
        let bankSequence: String?
        let comment: String?
        let sourceRecordHash: String?
        let dedupFingerprint: String?
        let fingerprintVersion: Int?
        let dedupOccurrence: Int?
        let recipient: RecipientID?
        let matchedPattern: Int?
        let overrideCategory: CategoryID?
        let recipientDefaultCategory: CategoryID?
        /// `resolveChunkAccounts`' stamped resolve-or-create result.
        var account: AccountID?
        /// `deriveRow`: the recipient override wins, the resolved follow.
        let effectiveRecipient: RecipientID?
        /// `deriveRow`'s normalized memo: JS `trim`.
        let memoNormalized: String
        /// `currencyKeyOf` (`trimmedCurrencyCode`): trimmed, empty meaning EUR.
        let currencyKey: String
        /// `deriveRow`'s category: the row override wins, the recipient default follows.
        let category: CategoryID?
        /// `deriveRow`: an overridden recipient severs the pattern link.
        let pattern: Int?
        /// `String(row.tx_date).slice(0, 10)` — `null` keeps its JS text.
        let dateText: String

        init(_ row: SQLRow) throws {
            id = try row.int64("id")
            txDate = try row.optionalText("tx_date")
            bankAccount = try row.optionalText("bank_account")
            memo = try row.optionalText("memo")
            amount = try row.optionalText("amount")
            currency = try row.optionalText("currency")
            balance = try row.optionalText("balance")
            bankSequence = try row.optionalText("bank_sequence")
            comment = try row.optionalText("comment")
            sourceRecordHash = try row.optionalText("source_record_hash")
            dedupFingerprint = try row.optionalText("dedup_fingerprint")
            fingerprintVersion = try row.optionalInt64("dedup_fingerprint_version").map { Int($0) }
            dedupOccurrence = try row.optionalInt64("dedup_occurrence").map { Int($0) }
            let resolved = try row.optionalInt64("resolved_recipient_id").map { RecipientID(rawValue: Int($0)) }
            let override = try row.optionalInt64("user_override_recipient_id").map { RecipientID(rawValue: Int($0)) }
            recipient = resolved
            matchedPattern = try row.optionalInt64("matched_pattern_id").map { Int($0) }
            overrideCategory = try row.optionalInt64("override_category_id").map { CategoryID(rawValue: Int($0)) }
            recipientDefaultCategory = try row.optionalInt64("recipient_default_category_id").map {
                CategoryID(rawValue: Int($0))
            }
            effectiveRecipient = override ?? resolved
            memoNormalized = JavaScriptWhitespace.trim(memo ?? "")
            let trimmedCurrency = JavaScriptWhitespace.trim(currency ?? "")
            currencyKey = trimmedCurrency.isEmpty ? "EUR" : trimmedCurrency
            category = overrideCategory ?? recipientDefaultCategory
            pattern = override != nil ? nil : matchedPattern
            dateText = txDate.map { String($0.prefix(10)) } ?? "null"
        }
    }

    /// A committed row the auto-link phase offers to `executePlanned`.
    struct InsertedRow: Sendable {
        let transaction: TransactionID
        let recipient: RecipientID?
        // lint:allow raw-id the TypeScript InsertedRow carries the amount's decimal text
        let amountText: String
        let dateText: String
        let currency: String
    }

    /// One chunk's outcome, the shape both the bulk and the per-row path answer.
    struct ChunkResult {
        var imported = 0
        var duplicates = 0
        var errors = 0
        var inserted: [InsertedRow] = []
    }

    /// The bulk payload row of `commitFingerprintRows`, its keys in `data`'s order.
    static func bulkRow(_ row: StagedRow, batch: Int) -> JSValue {
        .object(JSObject([
            ("staging_id", .string(String(row.id))),
            ("date", .string(row.dateText)),
            ("account_id", row.account.map { JSValue.int($0.rawValue) } ?? .null),
            ("recipient_id", row.effectiveRecipient.map { JSValue.int($0.rawValue) } ?? .null),
            ("category_id", row.category.map { JSValue.int($0.rawValue) } ?? .null),
            ("amount", row.amount.map { JSValue.string($0) } ?? .null),
            ("memo", .string(row.memo ?? "")),
            ("normalized_memo", .string(row.memoNormalized)),
            ("currency", .string(row.currencyKey)),
            ("balance", row.balance.map { JSValue.string($0) } ?? .null),
            ("bank_sequence", row.bankSequence.map { JSValue.string($0) } ?? .null),
            ("comment", row.comment.map { JSValue.string($0) } ?? .null),
            ("import_batch_id", .int(batch)),
            ("matched_pattern_id", row.pattern.map { JSValue.int($0) } ?? .null),
            ("source_record_hash", row.sourceRecordHash.map { JSValue.string($0) } ?? .null),
            ("dedup_fingerprint", row.dedupFingerprint.map { JSValue.string($0) } ?? .null),
            ("dedup_fingerprint_version", row.fingerprintVersion.map { JSValue.int($0) } ?? .null),
            ("dedup_occurrence", row.dedupOccurrence.map { JSValue.int($0) } ?? .null),
        ]))
    }

    // MARK: - The route

    /// The route: the batch must exist and be reviewable, then `commitImport` runs.
    static func commit(_ session: BackendSession, batch: Int) throws -> HandlerResult {
        guard let row = try session.row("SELECT status FROM import_batches WHERE id = ?", [.integer(Int64(batch))]),
            let status = try row.optionalText("status")
        else { throw BackendHTTPError.notFound("Import batch \(batch) not found") }
        if !reviewableStatuses.contains(status) {
            throw BackendHTTPError.validation(
                "Batch \(batch) is not in a reviewable state (status: \(status))")
        }

        let result = try commitBatch(session, batch: batch)
        // `commitImport`'s completion stamp; the reconcile, the cache clears and the
        // materialized-view refresh that follow have no answer the corpus observes.
        _ = try session.row(
            """
            UPDATE import_batches SET status = 'complete', completed_at = NOW()
             WHERE id = ? RETURNING id
            """,
            [.integer(Int64(batch))])
        return HandlerResult(
            data: .object([
                "batch_id": .int(batch),
                "total": .int(result.imported + result.duplicates + result.errors),
                "imported": .int(result.imported),
                "duplicates": .int(result.duplicates),
                "errors": .int(result.errors),
                "auto_linked_count": .int(result.autoLinked),
                "status": .string(result.errors > 0 ? "completed_with_errors" : "completed"),
                "error_message": .null,
                "links": .array([]),
            ]))
    }

    struct BatchResult {
        var imported = 0
        var duplicates = 0
        var errors = 0
        var autoLinked = 0
    }

    /// `commitBatch`: the claim, the unresolved rows, the chunks, the auto-link.
    static func commitBatch(_ session: BackendSession, batch: Int) throws -> BatchResult {
        // The claim: the statuses `committing` replaces.
        guard let claimed = try session.row(
            """
            UPDATE import_batches SET status = 'committing'
             WHERE id = ? AND status IN ('awaiting_review', 'matching') RETURNING adapter_name
            """,
            [.integer(Int64(batch))])
        else {
            throw BackendHTTPError.conflict(
                "Import batch is already committing or no longer reviewable")
        }
        let adapterName = try claimed.optionalText("adapter_name") ?? ""

        let staged = try session.rows(
            """
            SELECT isr.id,
                   to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
                   isr.bank_account,
                   isr.memo,
                   isr.amount,
                   isr.currency,
                   isr.balance,
                   isr.bank_sequence,
                   isr.comment,
                   isr.source_record_hash,
                   isr.dedup_fingerprint,
                   isr.dedup_fingerprint_version,
                   isr.dedup_occurrence,
                   isr.resolved_recipient_id,
                   isr.user_override_recipient_id,
                   isr.matched_pattern_id,
                   isr.override_category_id,
                   r.default_category_id AS recipient_default_category_id
              FROM import_staging_rows isr
              LEFT JOIN recipients r
                ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
             WHERE isr.batch_id = ? AND isr.status = 'matched'
             ORDER BY isr.row_index ASC
            """,
            [.integer(Int64(batch))]).map(StagedRow.init)

        let unresolved = staged.filter { $0.effectiveRecipient == nil }
        let matched = staged.filter { $0.effectiveRecipient != nil }
        var result = BatchResult()
        result.errors = unresolved.count
        if !unresolved.isEmpty {
            _ = try session.rows(
                """
                UPDATE import_staging_rows SET status = 'error', error_message = ?
                 WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) RETURNING id
                """,
                [
                    .text(unresolvedRecipientMessage),
                    .text(JSValue.array(unresolved.map { .string(String($0.id)) }).jsonText),
                ])
            _ = try session.row(
                """
                UPDATE import_batches SET rows_error = COALESCE(rows_error, 0) + ? WHERE id = ? RETURNING id
                """,
                [.integer(Int64(unresolved.count)), .integer(Int64(batch))])
        }

        var insertedRows: [InsertedRow] = []
        for start in stride(from: 0, to: matched.count, by: chunkRows) {
            let chunk = Array(matched[start..<Swift.min(start + chunkRows, matched.count)])
            let chunkResult = try session.transaction { () throws -> ChunkResult in
                let resolved = try resolveChunkAccounts(session, chunk, adapterName: adapterName)
                return try commitChunk(session, resolved, batch: batch)
            }
            // The per-chunk checkpoint the persisted counters fold in after the commit.
            _ = try session.row(
                """
                UPDATE import_batches
                   SET rows_imported = COALESCE(rows_imported, 0) + ?,
                       rows_duplicate = COALESCE(rows_duplicate, 0) + ?,
                       rows_error = COALESCE(rows_error, 0) + ?
                 WHERE id = ? RETURNING id
                """,
                [
                    .integer(Int64(chunkResult.imported)), .integer(Int64(chunkResult.duplicates)),
                    .integer(Int64(chunkResult.errors)), .integer(Int64(batch)),
                ])
            result.imported += chunkResult.imported
            result.duplicates += chunkResult.duplicates
            result.errors += chunkResult.errors
            insertedRows.append(contentsOf: chunkResult.inserted)
        }

        // `autoLinkTransactions`: the inserted rows clear matching planned payments;
        // per-pair failures are skipped, never failing the import.
        if !insertedRows.isEmpty {
            result.autoLinked = try autoLink(session, insertedRows)
        }
        return result
    }

    // MARK: - Accounts

    /// `resolveChunkAccounts`: every distinct btrimmed label resolves-or-creates its
    /// account, and the whole set must still be active. Answers the rows with
    /// `resolved_account_id` stamped, as the TypeScript caller's mutation does.
    static func resolveChunkAccounts(
        _ session: BackendSession, _ chunk: [StagedRow], adapterName: String
    ) throws -> [StagedRow] {
        var rows = chunk
        let key = adapterName.lowercased().replacingOccurrences(
            of: "\\s+", with: "_", options: .regularExpression)
        let multiCurrencyCash = multiCurrencyCashAdapters.contains(key)
        var idByLabel: [String: AccountID?] = [:]
        for row in chunk {
            let trimmed = spaceTrim(row.bankAccount ?? "")
            if trimmed.isEmpty { continue }
            if idByLabel[trimmed] == nil {
                let minted = try session.row(
                    """
                    INSERT INTO accounts (name, display_name, multi_currency_cash)
                    VALUES (?, ?, ?)
                    ON CONFLICT (lower(btrim(name))) DO UPDATE
                      SET multi_currency_cash = accounts.multi_currency_cash OR EXCLUDED.multi_currency_cash
                    RETURNING id
                    """,
                    [.text(trimmed), .text(trimmed), .integer(multiCurrencyCash ? 1 : 0)])
                idByLabel[trimmed] = minted.flatMap { try? $0.integerId("id") }.map { AccountID(rawValue: $0) }
            }
        }
        let accounts = Array(Set(idByLabel.values.compactMap { $0?.rawValue })).sorted()
        guard !accounts.isEmpty else { return rows }
        let active = try session.rows(
            "SELECT id, is_active FROM accounts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
            [.text(JSValue.array(accounts.map { .int($0) }).jsonText)])
        if active.count != accounts.count
            || active.contains(where: { (try? $0.bool("is_active")) == false })
        {
            throw BackendHTTPError.conflict("Reopen the account before importing transactions")
        }
        for index in rows.indices {
            let trimmed = spaceTrim(rows[index].bankAccount ?? "")
            if !trimmed.isEmpty { rows[index].account = idByLabel[trimmed] ?? nil }
        }
        return rows
    }

    /// `resolveChunkAccounts`' cache key, `label.replace(/^ +| +$/g, "")`: SQL btrim,
    /// U+0020 only.
    static func spaceTrim(_ label: String) -> String {
        var text = label
        while text.hasPrefix(" ") { text.removeFirst() }
        while text.hasSuffix(" ") { text.removeLast() }
        return text
    }

    // MARK: - The chunk

    /// `commitChunkWithFingerprints`: the bulk dedup ledger when every row carries the
    /// versioned identity, else the per-row fallback with its own probes.
    static func commitChunk(_ session: BackendSession, _ chunk: [StagedRow], batch: Int) throws
        -> ChunkResult
    {
        if chunk.allSatisfy({ $0.dedupFingerprint != nil && $0.fingerprintVersion != nil }) {
            if let bulk = try commitBulk(session, chunk, batch: batch) { return bulk }
        }
        return try commitRowByRow(session, chunk, batch: batch)
    }

    /// `commitFingerprintRows`: the identity probe, the candidate filter, the bulk
    /// INSERT and the staging status flips, SQL copied from the compiled Kysely query.
    static func commitBulk(
        _ session: BackendSession, _ chunk: [StagedRow], batch: Int
    ) throws -> ChunkResult? {
        let payload = JSValue.array(chunk.map { bulkRow($0, batch: batch) }).jsonText
        let identities = try session.rows(
            """
            WITH input AS (
              SELECT j.value ->> 'staging_id' AS staging_id,
                     j.value ->> 'date' AS date,
                     j.value ->> 'account_id' AS account_id,
                     j.value ->> 'recipient_id' AS recipient_id,
                     j.value ->> 'amount' AS amount,
                     j.value ->> 'normalized_memo' AS normalized_memo,
                     j.value ->> 'currency' AS currency,
                     j.value ->> 'dedup_fingerprint' AS dedup_fingerprint,
                     j.value ->> 'dedup_fingerprint_version' AS dedup_fingerprint_version
                FROM json_each(?) AS j
            )
            SELECT i.staging_id, (modern.id IS NOT NULL) AS "duplicate::bool", count(legacy.id) AS legacy_count
            FROM input i
            LEFT JOIN transactions modern ON modern.dedup_fingerprint_version = i.dedup_fingerprint_version
              AND modern.dedup_fingerprint = i.dedup_fingerprint
            LEFT JOIN transactions legacy ON modern.id IS NULL AND legacy.dedup_fingerprint IS NULL
              AND legacy.is_active = 1 AND legacy.date = i.date AND dec_eq(legacy.amount, i.amount)
              AND legacy.recipient_id IS i.recipient_id
              AND COALESCE(btrim(legacy.memo, char(32, 9, 10, 13, 12, 11)), '') = i.normalized_memo
              AND legacy.account_id IS i.account_id AND legacy.currency = i.currency
            GROUP BY i.staging_id, modern.id
            """,
            [.text(payload)])

        var identityByStaging: [Int64: (duplicate: Bool, legacyCount: Int)] = [:]
        for identity in identities {
            guard let staging = Int64(try identity.text("staging_id")) else { continue }
            identityByStaging[staging] =
                (try identity.bool("duplicate::bool"), Int(try identity.int64("legacy_count")))
        }
        var seen: Set<String> = []
        var candidates: [StagedRow] = []
        for row in chunk {
            guard let identity = identityByStaging[row.id] else {
                throw UnhandledJSError("Import identity lookup omitted a staging row")
            }
            let key = "\(row.fingerprintVersion ?? 0):\(row.dedupFingerprint ?? "")"
            let legacyDuplicate = row.dedupOccurrence.map { $0 <= identity.legacyCount } ?? false
            if identity.duplicate || legacyDuplicate || seen.contains(key) { continue }
            seen.insert(key)
            candidates.append(row)
        }
        let candidateIds = Set(candidates.map { $0.id })

        var insertedByKey: [String: Int] = [:]
        if !candidates.isEmpty {
            let candidatePayload = JSValue.array(candidates.map { bulkRow($0, batch: batch) }).jsonText
            for inserted in try session.rows(
                """
                INSERT INTO transactions (date, account_id, recipient_id, category_id, amount, memo, currency, balance,
                  bank_sequence, comment, import_batch_id, matched_pattern_id, source_record_hash,
                  dedup_fingerprint, dedup_fingerprint_version, is_active)
                SELECT i.value ->> 'date', i.value ->> 'account_id', i.value ->> 'recipient_id',
                  i.value ->> 'category_id', vision_numeric(i.value ->> 'amount', 18, 4), i.value ->> 'memo',
                  i.value ->> 'currency', vision_numeric(i.value ->> 'balance', 18, 4),
                  vision_numeric(i.value ->> 'bank_sequence', 18, 0), i.value ->> 'comment',
                  i.value ->> 'import_batch_id', i.value ->> 'matched_pattern_id',
                  i.value ->> 'source_record_hash', i.value ->> 'dedup_fingerprint',
                  i.value ->> 'dedup_fingerprint_version', 1
                FROM json_each(?) AS i
                WHERE true
                ON CONFLICT DO NOTHING RETURNING id, dedup_fingerprint, dedup_fingerprint_version
                """,
                [.text(candidatePayload)])
            {
                let key = "\(try inserted.int64("dedup_fingerprint_version")):\(try inserted.text("dedup_fingerprint"))"
                insertedByKey[key] = try inserted.integerId("id")
            }
        }

        var result = ChunkResult()
        var statuses: [JSValue] = []
        for row in chunk {
            let key = "\(row.fingerprintVersion ?? 0):\(row.dedupFingerprint ?? "")"
            if let transaction = candidateIds.contains(row.id) ? insertedByKey[key] : nil {
                result.imported += 1
                result.inserted.append(
                    InsertedRow(
                        transaction: TransactionID(rawValue: transaction),
                        recipient: row.effectiveRecipient,
                        amountText: row.amount ?? "",
                        dateText: row.dateText,
                        currency: row.currencyKey))
                statuses.append(
                    .object(JSObject([("id", .string(String(row.id))), ("status", .string("committed"))])))
            } else {
                result.duplicates += 1
                statuses.append(
                    .object(JSObject([("id", .string(String(row.id))), ("status", .string("duplicate"))])))
            }
        }
        _ = try session.row(
            """
            UPDATE import_staging_rows
               SET status = v.status, updated_at = now()
              FROM (SELECT CAST(value ->> 'id' AS INTEGER) AS id, value ->> 'status' AS status
                      FROM json_each(?)) AS v
             WHERE import_staging_rows.id = v.id RETURNING id
            """,
            [.text(JSValue.array(statuses).jsonText)])
        return result
    }

    /// The per-row fallback: the modern fingerprint probe, the legacy field-count
    /// fallback, the single-row INSERT, and the staging marks each row answers with.
    static func commitRowByRow(
        _ session: BackendSession, _ chunk: [StagedRow], batch: Int
    ) throws -> ChunkResult {
        var result = ChunkResult()
        for row in chunk {
            let modern: SQLRow?
            if let version = row.fingerprintVersion, let fingerprint = row.dedupFingerprint {
                modern = try session.row(
                    """
                    SELECT id FROM transactions
                     WHERE dedup_fingerprint_version = ? AND dedup_fingerprint = ? LIMIT 1
                    """,
                    [.integer(Int64(version)), .text(fingerprint)])
            } else {
                modern = nil
            }
            let legacyCount: Int
            if modern == nil {
                let legacy = try session.row(
                    """
                    SELECT COUNT(*) AS n FROM transactions t
                     WHERE t.dedup_fingerprint IS NULL AND t.is_active = 1 AND t.date = ?
                       AND dec_eq(t.amount, ?) AND t.recipient_id IS ?
                       AND COALESCE(btrim(t.memo, ' ' || char(9, 10, 13, 12, 11)), '') = ?
                       AND t.account_id IS ? AND t.currency = ?
                    """,
                    [
                        .text(row.dateText), row.amount.map { SQLValue.text($0) } ?? .null,
                        row.effectiveRecipient.map { SQLValue.integer(Int64($0.rawValue)) } ?? .null,
                        .text(row.memoNormalized),
                        row.account.map { SQLValue.integer(Int64($0.rawValue)) } ?? .null,
                        .text(row.currencyKey),
                    ])
                legacyCount = Int(try legacy.map { try $0.int64("n") } ?? 0)
            } else {
                legacyCount = 0
            }
            let legacyDuplicate = row.dedupOccurrence.map { $0 <= legacyCount } ?? false
            if modern != nil || legacyDuplicate {
                result.duplicates += 1
                _ = try session.row(
                    "UPDATE import_staging_rows SET status = 'duplicate' WHERE id = ? RETURNING id",
                    [.integer(row.id)])
                continue
            }
            do {
                let inserted = try session.row(
                    """
                    INSERT INTO transactions
                      (date, account_id, recipient_id, category_id, amount, memo, currency, balance, comment,
                       import_batch_id, matched_pattern_id, source_record_hash,
                       dedup_fingerprint, dedup_fingerprint_version, bank_sequence, is_active)
                    VALUES (?, ?, ?, ?, vision_numeric(?, 18, 4), ?, ?, vision_numeric(?, 18, 4), ?, ?,
                            ?, ?, ?, ?, vision_numeric(?, 18, 0), 1)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                    """,
                    [
                        .text(row.dateText),
                        row.account.map { SQLValue.integer(Int64($0.rawValue)) } ?? .null,
                        row.effectiveRecipient.map { SQLValue.integer(Int64($0.rawValue)) } ?? .null,
                        row.category.map { SQLValue.integer(Int64($0.rawValue)) } ?? .null,
                        row.amount.map { SQLValue.text($0) } ?? .null,
                        row.memo.map { SQLValue.text($0) } ?? .null,
                        .text(row.currencyKey),
                        row.balance.map { SQLValue.text($0) } ?? .null,
                        row.comment.map { SQLValue.text($0) } ?? .null,
                        .integer(Int64(batch)),
                        row.pattern.map { SQLValue.integer(Int64($0)) } ?? .null,
                        row.sourceRecordHash.map { SQLValue.text($0) } ?? .null,
                        row.dedupFingerprint.map { SQLValue.text($0) } ?? .null,
                        row.fingerprintVersion.map { SQLValue.integer(Int64($0)) } ?? .null,
                    ])
                guard let inserted, let id = try inserted.optionalInt64("id") else {
                    result.duplicates += 1
                    _ = try session.row(
                        "UPDATE import_staging_rows SET status = 'duplicate' WHERE id = ? RETURNING id",
                        [.integer(row.id)])
                    continue
                }
                result.imported += 1
                result.inserted.append(
                    InsertedRow(
                        transaction: TransactionID(rawValue: Int(id)),
                        recipient: row.effectiveRecipient,
                        amountText: row.amount ?? "",
                        dateText: row.dateText,
                        currency: row.currencyKey))
                _ = try session.row(
                    "UPDATE import_staging_rows SET status = 'committed' WHERE id = ? RETURNING id",
                    [.integer(row.id)])
            } catch {
                result.errors += 1
                let partial = ((error as? BackendHTTPError)?.message ?? "insert failed").prefix(500)
                _ = try session.row(
                    """
                    UPDATE import_staging_rows SET status = 'error', error_message = ?
                     WHERE id = ? RETURNING id
                    """,
                    [.text(String(partial)), .integer(row.id)])
            }
        }
        return result
    }

    // MARK: - Auto-link

    /// `autoLinkTransactions` (`plannedMatchService.ts`): the ±5-day buckets over the
    /// recipient cluster, upper-cased currency, amount sign and day, the mutually
    /// unambiguous pairs, and `executePlanned` with the expected occurrence.
    static func autoLink(_ session: BackendSession, _ inserted: [InsertedRow]) throws -> Int {
        // `isAutoClearEnabled`: default ON, and a read that fails reads as ON.
        let autoClear: Bool
        if let stored = try? session.row("SELECT value FROM user_settings WHERE key = 'app_settings'"),
            let text = try? stored.optionalText("value"), let value = JSValue.parse(text),
            case .object(let settings) = value, let flag = settings["autoClearPlannedOnMatch"]
        {
            autoClear = flag != .bool(false)
        } else {
            autoClear = true
        }
        guard autoClear else { return 0 }
        let active = try PlannedArea.activeUnexecuted(session)
        guard !active.isEmpty else { return 0 }
        let txs = inserted.filter { $0.recipient != nil }
        guard !txs.isEmpty else { return 0 }

        var clusterByRecipient: [Int: Int] = [:]
        for tx in txs {
            guard let recipient = tx.recipient else { continue }
            if clusterByRecipient[recipient.rawValue] == nil {
                let root = try? session.row(
                    "SELECT COALESCE(primary_recipient_id, id) AS cluster_root FROM recipients WHERE id = ?",
                    [.integer(Int64(recipient.rawValue))])
                clusterByRecipient[recipient.rawValue] =
                    (try? root?.optionalInt64("cluster_root").map { Int($0) }) ?? recipient.rawValue
            }
        }

        var buckets: [String: [PlannedArea.MatchCandidate]] = [:]
        for planned in active {
            guard let day = PlannedArea.dayOrdinal(planned.plannedDate) else { continue }
            let key = "\(planned.recipientClusterId.map(String.init) ?? "null"):\((planned.currency ?? "").uppercased()):\(signOf(planned.amount)):\(day)"
            buckets[key, default: []].append(planned)
        }

        var matchesByTx: [Int: [PlannedArea.MatchCandidate]] = [:]
        var txIdsByPlanned: [Int: [Int]] = [:]
        for tx in txs {
            guard let recipient = tx.recipient else { continue }
            let cluster = clusterByRecipient[recipient.rawValue] ?? recipient.rawValue
            guard let day = PlannedArea.dayOrdinal(tx.dateText) else { continue }
            var matches: [PlannedArea.MatchCandidate] = []
            for offset in stride(from: -PlannedMatching.dateWindowDays, through: PlannedMatching.dateWindowDays, by: 1) {
                let key = "\(cluster):\(tx.currency.uppercased()):\(signOf(tx.amountText)):\(day + offset)"
                for planned in buckets[key] ?? [] {
                    if PlannedMatching.matchesTolerance(
                        PlannedMatchLike(
                            recipientClusterId: planned.recipientClusterId.map {
                                JSValue.number(Double($0.rawValue))
                            },
                            currency: planned.currency.map { JSValue.string($0) },
                            amount: .string(planned.amount),
                            plannedDate: .string(planned.plannedDate)),
                        TxMatchLike(
                            recipientClusterId: .number(Double(cluster)),
                            currency: .string(tx.currency),
                            amount: .string(tx.amountText),
                            transactionDate: .string(tx.dateText)))
                    {
                        matches.append(planned)
                    }
                }
            }
            matchesByTx[tx.transaction.rawValue] = matches
            for planned in matches { txIdsByPlanned[planned.id, default: []].append(tx.transaction.rawValue) }
        }

        var linked = 0
        for tx in txs {
            guard let matches = matchesByTx[tx.transaction.rawValue], matches.count == 1,
                (txIdsByPlanned[matches[0].id] ?? []).count == 1
            else { continue }
            let planned = matches[0]
            do {
                let replay = try PlannedArea.executeRow(
                    session, id: PlannedTransactionID(rawValue: planned.id),
                    body: PlannedArea.ExecuteBody(
                        executedTransactionId: tx.transaction,
                        executionDate: String(tx.dateText.prefix(10))),
                    expectedOccurrence: planned.plannedDate)
                if !replay.0 { linked += 1 }
            } catch {
                // `[auto-link] execute failed`: logged and skipped in the pipeline.
            }
        }
        return linked
    }

    /// `Math.sign(Number(value))` over a decimal string.
    static func signOf(_ amount: String) -> Int {
        let number = Double(amount) ?? 0
        return number.isFinite && number != 0 ? (number < 0 ? -1 : 1) : 0
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.CommitImportBatch.self) { request in
            let batch = try ImportBatchesArea.batchId(request)
            return try await database.run { session in
                try ImportCommitArea.commit(session, batch: batch)
            }
        }
    }
}
