"""Add mv_recipient_monthly and agg_recipient_totals

Revision ID: 0035_add_recipient_aggregations
Revises: 0034_drop_legacy_transactions_ix_duplicates
Create Date: 2026-05-12

Restores the two recipient-scoped aggregation artifacts referenced by the
application code (aggregationRefresh.js, recipientRepository.js) that were
introduced in the legacy 0026_finance_aggregations migration but never folded
into the consolidated baseline (0001). Without them, post-import refresh
emits `relation "mv_recipient_monthly" does not exist` and the
"recipients with activity" repository query silently returns nothing.

The companion `agg_split_outstanding` artifact already exists from 0019, so
this migration is scoped to the two missing pieces.

Artifacts:
  1. mv_recipient_monthly — monthly recipient × currency totals, rolled up
     to primary_recipient_id when present. Last-24-month window for cheap
     refreshes. Has a unique index so REFRESH ... CONCURRENTLY works.

  2. agg_recipient_totals — running totals per (recipient, currency),
     maintained by row-level triggers on transactions. UPSERT semantics so
     the backfill is idempotent.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0035_add_recipient_aggregations'
down_revision: Union[str, Sequence[str], None] = '0034_drop_legacy_transactions_ix_duplicates'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # mv_recipient_monthly — recipient × month × currency
    # ------------------------------------------------------------------
    op.execute("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_recipient_monthly AS
        SELECT
            date_trunc('month', t.date)::date     AS month_start,
            EXTRACT(YEAR FROM t.date)::int         AS year,
            EXTRACT(MONTH FROM t.date)::int        AS month,
            COALESCE(r.primary_recipient_id, t.recipient_id) AS recipient_id,
            t.currency                             AS currency,
            COUNT(*)                               AS transaction_count,
            SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS total_income,
            SUM(CASE WHEN t.amount <  0 THEN t.amount ELSE 0 END) AS total_spending,
            SUM(t.amount)                          AS net_amount
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        WHERE t.is_active = true
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '24 months'
        GROUP BY
            month_start, year, month,
            COALESCE(r.primary_recipient_id, t.recipient_id),
            t.currency
        WITH NO DATA;
    """)

    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS mv_recipient_monthly_idx
            ON mv_recipient_monthly (month_start, recipient_id, currency);
    """)

    # First population — non-concurrent because the view was created WITH NO DATA.
    op.execute("REFRESH MATERIALIZED VIEW mv_recipient_monthly;")

    # ------------------------------------------------------------------
    # agg_recipient_totals — running totals per (recipient, currency)
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS agg_recipient_totals (
            recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
            currency CHAR(3) NOT NULL,
            total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
            transaction_count INTEGER NOT NULL DEFAULT 0,
            last_transaction_date DATE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (recipient_id, currency)
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_agg_recipient_totals_currency
            ON agg_recipient_totals (currency);
    """)

    op.execute("""
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
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION fn_agg_recipient_totals_sync() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            ELSIF TG_OP = 'DELETE' THEN
                IF OLD.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                RETURN OLD;
            ELSIF TG_OP = 'UPDATE' THEN
                IF OLD.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                IF NEW.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            END IF;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_agg_recipient_totals_sync ON transactions;
        CREATE TRIGGER trg_agg_recipient_totals_sync
            AFTER INSERT OR UPDATE OR DELETE ON transactions
            FOR EACH ROW EXECUTE FUNCTION fn_agg_recipient_totals_sync();
    """)

    # Backfill from existing transactions. Idempotent via ON CONFLICT.
    op.execute("""
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
          AND t.recipient_id IS NOT NULL
          AND t.currency IS NOT NULL
        GROUP BY t.recipient_id, t.currency
        ON CONFLICT (recipient_id, currency) DO UPDATE
        SET total_amount = EXCLUDED.total_amount,
            transaction_count = EXCLUDED.transaction_count,
            last_transaction_date = EXCLUDED.last_transaction_date,
            updated_at = NOW();
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_agg_recipient_totals_sync ON transactions;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_recipient_totals_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_recipient_totals_apply(INTEGER, CHAR, NUMERIC, INTEGER, DATE) CASCADE;")
    op.execute("DROP TABLE IF EXISTS agg_recipient_totals CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_recipient_monthly CASCADE;")
