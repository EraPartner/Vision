"""Drop agg_recipient_totals — a trigger-maintained table that is pure write overhead.

Revision ID: 0080_drop_agg_recipient_totals
Revises: 0079_perf_indexes
Create Date: 2026-07-14

`agg_recipient_totals` (0035, transfer-aware since 0045) is maintained by an
AFTER INSERT/UPDATE/DELETE row trigger on `transactions` — every transaction
mutation pays an UPSERT into it. Its only application reader was the recipient
"has activity" existence probe in recipientRepository.buildWhereClause
(`EXISTS (SELECT 1 FROM agg_recipient_totals ... transaction_count > 0)`), which
has been rewritten to probe `transactions` directly (an active, non-transfer,
currency-bearing row exists — the exact condition the trigger counted). With the
sole reader gone the table is write-only, so this drops it and its trigger +
helper functions, removing the per-mutation write amplification.

Note: `mv_recipient_monthly` (the other 0035 artifact) was already dropped by
0038 and is untouched here.

Downgrade fully restores the table, its currency index, both helper functions
(sync function in its live 0045 transfer-excluding form — the definition that was
in effect immediately before this migration, NOT the pre-0045 0035 body), the
trigger, and an idempotent transfer-excluding backfill from current transactions.

Blast radius: drops one table + one trigger + two functions. No other object
depends on them (verified). Downgrade re-creates all of it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0080_drop_agg_recipient_totals"
down_revision: Union[str, Sequence[str], None] = "0079_perf_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_agg_recipient_totals_sync ON transactions;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_recipient_totals_sync() CASCADE;")
    op.execute(
        "DROP FUNCTION IF EXISTS "
        "fn_agg_recipient_totals_apply(INTEGER, CHAR, NUMERIC, INTEGER, DATE) CASCADE;"
    )
    op.execute("DROP TABLE IF EXISTS agg_recipient_totals CASCADE;")


def downgrade() -> None:
    # Table + currency index (mirrors 0035).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agg_recipient_totals (
            recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
            currency CHAR(3) NOT NULL,
            total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
            transaction_count INTEGER NOT NULL DEFAULT 0,
            last_transaction_date DATE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (recipient_id, currency)
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agg_recipient_totals_currency
            ON agg_recipient_totals (currency);
        """
    )

    # UPSERT helper (mirrors 0035).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION fn_agg_recipient_totals_apply(
            p_recipient_id INTEGER,
            p_currency CHAR(3),
            p_amount NUMERIC,
            p_count_delta INTEGER,
            p_tx_date DATE
        ) RETURNS void AS $$
        BEGIN
            IF p_recipient_id IS NULL OR p_currency IS NULL THEN
                RETURN;
            END IF;

            INSERT INTO agg_recipient_totals (
                recipient_id, currency, total_amount, transaction_count,
                last_transaction_date, updated_at
            ) VALUES (
                p_recipient_id, p_currency, p_amount, p_count_delta,
                p_tx_date, NOW()
            )
            ON CONFLICT (recipient_id, currency) DO UPDATE
            SET total_amount = agg_recipient_totals.total_amount + EXCLUDED.total_amount,
                transaction_count = agg_recipient_totals.transaction_count + EXCLUDED.transaction_count,
                last_transaction_date = GREATEST(
                    agg_recipient_totals.last_transaction_date,
                    EXCLUDED.last_transaction_date
                ),
                updated_at = NOW();
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    # Sync trigger function — restore the LIVE 0045 body (transfer-excluding),
    # which is the definition that was in effect immediately before this drop.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION fn_agg_recipient_totals_sync() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.is_active AND NOT NEW.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            ELSIF TG_OP = 'DELETE' THEN
                IF OLD.is_active AND NOT OLD.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                RETURN OLD;
            ELSIF TG_OP = 'UPDATE' THEN
                IF OLD.is_active AND NOT OLD.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                IF NEW.is_active AND NOT NEW.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            END IF;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_agg_recipient_totals_sync ON transactions;
        CREATE TRIGGER trg_agg_recipient_totals_sync
            AFTER INSERT OR UPDATE OR DELETE ON transactions
            FOR EACH ROW EXECUTE FUNCTION fn_agg_recipient_totals_sync();
        """
    )

    # Idempotent backfill, transfer-excluding to match the live trigger semantics.
    op.execute(
        """
        INSERT INTO agg_recipient_totals (
            recipient_id, currency, total_amount, transaction_count,
            last_transaction_date, updated_at
        )
        SELECT
            t.recipient_id,
            t.currency,
            SUM(t.amount),
            COUNT(*),
            MAX(t.date),
            NOW()
        FROM transactions t
        WHERE t.is_active = true
          AND t.is_transfer = false
          AND t.recipient_id IS NOT NULL
          AND t.currency IS NOT NULL
        GROUP BY t.recipient_id, t.currency
        ON CONFLICT (recipient_id, currency) DO UPDATE
        SET total_amount = EXCLUDED.total_amount,
            transaction_count = EXCLUDED.transaction_count,
            last_transaction_date = EXCLUDED.last_transaction_date,
            updated_at = NOW();
        """
    )
