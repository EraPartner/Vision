import Foundation
import VisionNativeCore

/// The P18 commit routes: `commitPortfolioImportBatch` (`POST /batches/:id/commit`)
/// and `commitReviewedPortfolioImports` (`POST /reconciliation/commit`) — the
/// portfolio import pipeline's commit half (`portfolioImportPipeline/commit.ts`),
/// the reviewed-scope commit (`portfolioImportCommitService.ts`) and the
/// reconciliation apply half (`applyPortfolioImportReconciliation`).
enum PortfolioImportCommitArea {
    /// `parseBatchIdParam` reuses the shared id guard the batches area holds.
    typealias batchId = PortfolioImportBatchesArea.batchId

    /// `PORTFOLIO_ACCOUNT_TYPES` of `portfolioImportAccountService.ts`.
    static let portfolioAccountTypes: Set<String> = ["brokerage", "crypto_exchange", "wallet"]

    /// `assertPortfolioImportAccount`: the account must exist, be active and support
    /// portfolio imports. A missing id is legal (an unassigned batch).
    static func assertPortfolioImportAccount(_ session: BackendSession, _ accountId: Int?) throws {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let accountId else { return }
        guard let account = try session.row(
            """
            SELECT a.is_active AS is_active, a.type AS type
              FROM accounts a
             WHERE a.id = ?
            """,
            [.integer(Int64(accountId)])
        else {
            throw BackendHTTPError.notFound("Account not found")
        }
        let active = (try account.int64("is_active")) != 0
        let type = try account.text("type")
        guard active, portfolioAccountTypes.contains(type) else {
            throw BackendHTTPError.validation("account_id must reference an active portfolio account")
        }
    }

    /// `commitBodySchema` through `parseInput(bareMessages(...))`: `account_id` is
    /// `validateId`'s accept set with the int4 bound; null keeps its meaning (no
    /// switch), a present but malformed value is one joined issue.
    static func commitBody(_ parsed: JSValue?) throws -> Int? {
        var body: JSValue
        if case .object(let object)? = parsed {
            body = .object(object)
        } else if parsed == nil || parsed == .null {
            body = .object(JSObject())
        } else {
            body = parsed ?? .null
        }
        guard case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.zodTypeName)")
        }
        var issues: [String] = []
        var accountId: Int? = nil  // lint:allow raw-id the int4 account id the route body coerces
        if let value = object["account_id"], value != .null {
            let parsedId = PortfolioImportOverridesArea.validId(value, max: 2_147_483_647)
            if let parsedId {
                accountId = parsedId
            } else {
                issues.append("account_id must be a positive integer")
            }
        }
        if !issues.isEmpty {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        return accountId
    }

    /// `lockBatchForUpdate`: the lock row's fields. The caller's transaction holds the
    /// write lock; the read is the row's reviewed state.
    struct LockedBatch {
        var id: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var status: String
        var isBrokerage: Bool
        var adapterName: String?
        var customConfig: StoredBatchConfig
        var accountID: Int?  // lint:allow raw-id the id the repository query binds

        var maintained: Bool { PortfolioImportCommitArea.isMaintained(self) }
    }

    /// `isMaintainedPortfolioImport`: the adapter or the config's format is a
    /// maintained adapter.
    static func isMaintained(_ batch: LockedBatch) -> Bool {
        let format = batch.customConfig.parsedObject["format"]?.stringValue
        return [batch.adapterName, format].contains { value in
            guard let value else { return false }
            return PortfolioImportCommitArea.maintainedAdapters.contains(
                value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        }
    }

    static let maintainedAdapters: Set<String> = [
        "ibkr", "kinesis", "nexo", "saxo", "ibkr_transaction_history", "ibkr_funding_history",
        "kinesis_transaction_history", "nexo_transaction_history", "nexo_pro_spot_history",
        "saxo_transaction_history", "portfolio_performance_reference",
    ]

    /// `lockBatchForUpdate`: the batch's lock row.
    static func lockBatch(_ session: BackendSession, _ batchId: Int) throws -> LockedBatch? {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let row = try session.row(
            """
            SELECT b.id, b.status, b.is_brokerage, b.adapter_name, b.custom_config, b.account_id
              FROM portfolio_import_batches b
             WHERE b.id = ?
            """,
            [.integer(Int64(batchId)])
        else { return nil }
        return LockedBatch(
            id: Int(try row.int64("id")),
            status: try row.text("status"),
            isBrokerage: (try row.int64("is_brokerage")) != 0,
            adapterName: try row.optionalText("adapter_name"),
            customConfig: (try row.optionalText("custom_config"))
                .map(PortfolioImportReconciliationArea.storedConfig)
                ?? .text(""),
            accountID: try row.optionalInt64("account_id").flatMap { Int(exactly: $0) })
    }

    /// `assertReviewable`: a missing batch is 404; a terminal batch is a 400 with its status.
    static func assertReviewable(_ batch: LockedBatch?, _ batchId: Int) throws -> LockedBatch {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let batch else {
            throw BackendHTTPError.notFound("Import batch \(batchId) not found")
        }
        guard ["awaiting_review", "matching", "complete_with_errors"].contains(batch.status) else {
            throw BackendHTTPError.validation(
                "Batch \(batchId) is not in a reviewable state (status: \(batch.status))")
        }
        return batch
    }

    /// `setBatchAccount`: one unit — the cash repair, then the batch's account. The
    /// repaired rows and the batch move together or not at all.
    static func setBatchAccount(_ session: BackendSession, _ batchId: Int, _ accountId: Int?) throws {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var repaired = 0
        if let accountId {
            repaired = try session.rows(
                """
                UPDATE portfolio_import_staging_rows
                   SET status = 'matched', error_message = NULL
                 WHERE batch_id = ? AND route = 'cash' AND status = 'error'
                   AND error_message = 'brokerage cash row requires a batch account'
                RETURNING id
                """,
                [.integer(Int64(batchId))]).count
        }
        _ = try session.rows(
            """
            UPDATE portfolio_import_batches
               SET account_id = ?,
                   rows_error = max(COALESCE(rows_error, 0) - ?, 0)
             WHERE id = ?
            RETURNING id
            """,
            [accountId.map { SQLValue.integer(Int64($0)) } ?? .null,
             .integer(Int64(repaired)),
             .integer(Int64(batchId))])
    }

    /// `getImportReadinessProblems`: the rows that are not settled or complete.
    static func readinessProblems(
        _ session: BackendSession, _ batchId: Int, _ accountId: Int?  // lint:allow raw-id the id the repository query binds
    ) throws -> [Int] {  // lint:allow raw-id business table ordinals of the TypeScript repository read
        let rows = try session.rows(
            """
            SELECT s.row_index AS row_index
              FROM portfolio_import_staging_rows s
             WHERE s.batch_id = ?
               AND (
                   s.status NOT IN ('matched', 'committed', 'duplicate')
                   OR (s.status = 'matched' AND (
                       s.tx_date IS NULL
                       OR (s.route = 'cash' AND (? IS NULL OR s.amount IS NULL))
                       OR (s.route IS NOT 'cash' AND s.route IS NOT 'account_internal' AND (
                           (s.type IS NULL AND s.route IS NOT 'asset_transfer'
                                              AND s.route IS NOT 'asset_adjustment')
                           OR COALESCE(s.user_override_investment_id, s.resolved_investment_id) IS NULL
                       ))
                   ))
               )
             ORDER BY s.row_index
            """,
            [.integer(Int64(batchId)), accountId.map { SQLValue.integer(Int64($0)) } ?? .null])
        return try rows.map { Int(try $0.int64("row_index")) }
    }
}
