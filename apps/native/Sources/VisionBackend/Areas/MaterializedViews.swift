import Foundation
import Synchronization

/// `services/materializedViewService.ts`'s `scheduleRefresh` for the writes the Swift backend
/// serves: a trailing debounce (5 s, flushed within 10 s of the first call of a burst) that
/// refills `mv_monthly_summary` and `mv_category_totals` in one write transaction, so readers
/// see the old or the new contents and never an empty table.
///
/// Bun keeps its own debounce for its own writes. Refreshes here run on the database actor one
/// after another, which stands in for Bun's in-flight coalescing. A failed refill rolls back
/// and keeps the previous contents, as Bun's only logs it.
final class MaterializedViewRefresher: Sendable {
    struct Timing: Sendable {
        var debounce: Duration
        var maxWait: Duration

        /// `REFRESH_DEBOUNCE_MS` and `REFRESH_MAX_WAIT_MS`.
        static let standard = Timing(debounce: .milliseconds(5000), maxWait: .milliseconds(10000))
    }

    private struct State {
        var timer: Task<Void, Never>?
        var deadline: ContinuousClock.Instant?
    }

    private let database: BackendDatabase
    private let timing: Timing
    private let state = Mutex(State())

    init(database: BackendDatabase, timing: Timing = .standard) {
        self.database = database
        self.timing = timing
    }

    /// `scheduleRefresh`: restart the debounce, never past the burst's deadline.
    func schedule() {
        let now = ContinuousClock.now
        state.withLock { state in
            state.timer?.cancel()
            let deadline = state.deadline ?? now + timing.maxWait
            state.deadline = deadline
            let delay = min(timing.debounce, max(.zero, deadline - now))
            state.timer = Task { [weak self] in
                try? await Task.sleep(for: delay)
                guard let self else { return }
                // A newer call cancels this timer under the same lock, so a timer that is still
                // live here is the burst's last.
                let fire = self.state.withLock { (state: inout State) -> Bool in
                    if Task.isCancelled { return false }
                    state.timer = nil
                    state.deadline = nil
                    return true
                }
                if fire { try? await self.refresh() }
            }
        }
    }

    /// `refreshMaterializedViews`: both tables in one transaction.
    func refresh() async throws {
        try await database.run { session in
            try session.transaction {
                for fill in Self.fills {
                    _ = try session.rows("DELETE FROM \(fill.table)")
                    _ = try session.rows(fill.sql)
                }
            }
        }
    }

    /// The `INSERT ... SELECT` of each table, as `materializedViewService.ts` writes them.
    static let fills: [(table: String, sql: String)] = [
        (
            "mv_monthly_summary",
            """
            INSERT INTO mv_monthly_summary (
              month_start, month, year, currency, transaction_count,
              total_income, total_spending, net_amount,
              category_id, category_id_key, category_name
            )
            SELECT
              date_trunc('month', t.date) AS month_start,
              date_part('month', t.date) AS month,
              date_part('year', t.date) AS year,
              t.currency,
              count(*) AS transaction_count,
              dec_sum(CASE WHEN dec_sign(t.amount) >= 0 THEN t.amount ELSE 0 END) AS total_income,
              dec_sum(CASE WHEN dec_sign(t.amount) < 0 THEN t.amount ELSE 0 END) AS total_spending,
              dec_sum(t.amount) AS net_amount,
              c.id AS category_id,
              COALESCE(c.id, -1) AS category_id_key,
              COALESCE(c.path_name, 'UNCATEGORISED') AS category_name
            FROM transactions t
            LEFT JOIN recipients r ON t.recipient_id = r.id
            LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
            LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
            WHERE t.is_active = 1 AND t.is_transfer = 0
              AND t.date >= add_months(date_trunc('month', today()), -12)
            GROUP BY date_trunc('month', t.date), date_part('month', t.date), date_part('year', t.date),
                     t.currency, c.id, COALESCE(c.path_name, 'UNCATEGORISED')
            ORDER BY month_start
            """
        ),
        (
            "mv_category_totals",
            """
            INSERT INTO mv_category_totals (category_id, name, count, total, currency)
            SELECT
              COALESCE(c.id, -1) AS category_id,
              COALESCE(c.path_name, 'UNCATEGORISED') AS name,
              count(*) AS count,
              dec_sum(t.amount) AS total,
              t.currency
            FROM transactions t
            LEFT JOIN recipients r ON t.recipient_id = r.id
            LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
            LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
            WHERE t.is_active = 1 AND t.is_transfer = 0
            GROUP BY
              COALESCE(c.id, -1),
              COALESCE(c.path_name, 'UNCATEGORISED'),
              t.currency
            ORDER BY count(*) DESC
            """
        ),
    ]
}
