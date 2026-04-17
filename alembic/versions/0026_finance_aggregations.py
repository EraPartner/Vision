"""Finance aggregation layer — Phase 1 of the non-portfolio refactor.

Revision ID: 0026_finance_aggregations
Revises: 0025_exchange_rate_cache
Create Date: 2026-04-16

Adds the trigger-maintained aggregation tables + extra materialized view that
Phase 2+ readers will consume. Purely additive: no existing table, MV, or
trigger is dropped or altered. Existing MVs in materializedViewService.js
remain the source of truth for monthly/category/cashflow/bank views; this
migration layers on top.

Artifacts:
  1. GIN trigram index on recipients.normalized_name (pg_trgm already enabled).
     Unlocks O(log n) fuzzy matching for import auto-link in Phase 6.

  2. mv_recipient_monthly — monthly totals per recipient per currency, rolled
     up to primary_recipient when present. Drives recipient-insights endpoint
     in Phase 2.

  3. agg_recipient_totals — running totals per (recipient, currency).
     Trigger-maintained on transactions insert/update/delete. Used to replace
     the full-table scan "uncategorized recipient" query in Phase 6.

  4. agg_split_outstanding — outstanding balance per split, maintained by
     triggers on transaction_splits and split_payments. Powers owed-summary
     endpoint in Phase 4 with O(1) per-recipient lookup.

Both agg_ tables use UPSERT (ON CONFLICT) semantics so backfill is idempotent
and re-running the migration safely rebuilds the data.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0026_finance_aggregations'
down_revision: Union[str, Sequence[str], None] = '0025_exchange_rate_cache'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. pg_trgm GIN index on recipients.normalized_name
    # ------------------------------------------------------------------
    # pg_trgm extension is already created in schemaInit.js. We only add the
    # index here; CREATE EXTENSION is kept idempotent for fresh DBs run via
    # alembic upgrade head before JS init touches pg_trgm.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_recipients_normalized_name_trgm
            ON recipients USING gin (normalized_name gin_trgm_ops);
    """)

    # ------------------------------------------------------------------
    # 2. mv_recipient_monthly — recipient × month × currency
    # ------------------------------------------------------------------
    # Rolls up sub-recipients under primary when primary_recipient_id is set.
    # Scoped to the last 24 months to keep the view cheap to refresh; older
    # aggregates read from agg_recipient_totals (all-time running totals).
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

    # Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS mv_recipient_monthly_idx
            ON mv_recipient_monthly (month_start, recipient_id, currency);
    """)

    # Populate once on migrate. Non-concurrent because first load.
    op.execute("REFRESH MATERIALIZED VIEW mv_recipient_monthly;")

    # ------------------------------------------------------------------
    # 3. agg_recipient_totals — running totals per (recipient, currency)
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

    # Trigger functions + triggers for agg_recipient_totals.
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

    # Backfill existing rows.
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

    # ------------------------------------------------------------------
    # 4. agg_split_outstanding — outstanding balance per split
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS agg_split_outstanding (
            split_id INTEGER PRIMARY KEY REFERENCES transaction_splits(id) ON DELETE CASCADE,
            recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
            original_amount NUMERIC(15, 2) NOT NULL,
            paid_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
            outstanding_amount NUMERIC(15, 2) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_agg_split_outstanding_recipient
            ON agg_split_outstanding (recipient_id);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_agg_split_outstanding_open
            ON agg_split_outstanding (recipient_id)
            WHERE outstanding_amount <> 0;
    """)

    # Maintenance function: recompute a single split row from source tables.
    # Called by triggers on transaction_splits and split_payments. Idempotent.
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_agg_split_outstanding_sync(p_split_id INTEGER)
        RETURNS void AS $$
        DECLARE
            v_recipient_id INTEGER;
            v_original NUMERIC(15, 2);
            v_paid NUMERIC(15, 2);
        BEGIN
            SELECT s.recipient_id, s.amount
            INTO v_recipient_id, v_original
            FROM transaction_splits s
            WHERE s.id = p_split_id;

            IF v_recipient_id IS NULL THEN
                DELETE FROM agg_split_outstanding WHERE split_id = p_split_id;
                RETURN;
            END IF;

            SELECT COALESCE(SUM(amount), 0) INTO v_paid
            FROM split_payments
            WHERE split_id = p_split_id;

            INSERT INTO agg_split_outstanding (
                split_id, recipient_id, original_amount, paid_amount,
                outstanding_amount, updated_at
            ) VALUES (
                p_split_id, v_recipient_id, v_original, v_paid,
                v_original - v_paid, NOW()
            )
            ON CONFLICT (split_id) DO UPDATE
            SET recipient_id = EXCLUDED.recipient_id,
                original_amount = EXCLUDED.original_amount,
                paid_amount = EXCLUDED.paid_amount,
                outstanding_amount = EXCLUDED.outstanding_amount,
                updated_at = NOW();
        END;
        $$ LANGUAGE plpgsql;
    """)

    # Trigger: transaction_splits changes re-sync that split.
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_trg_split_sync() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                DELETE FROM agg_split_outstanding WHERE split_id = OLD.id;
                RETURN OLD;
            END IF;
            PERFORM fn_agg_split_outstanding_sync(NEW.id);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_split_outstanding_sync ON transaction_splits;
        CREATE TRIGGER trg_split_outstanding_sync
            AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
            FOR EACH ROW EXECUTE FUNCTION fn_trg_split_sync();
    """)

    # Trigger: split_payments changes re-sync the parent split.
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_trg_split_payment_sync() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                PERFORM fn_agg_split_outstanding_sync(OLD.split_id);
                RETURN OLD;
            END IF;
            PERFORM fn_agg_split_outstanding_sync(NEW.split_id);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_split_payment_outstanding_sync ON split_payments;
        CREATE TRIGGER trg_split_payment_outstanding_sync
            AFTER INSERT OR UPDATE OR DELETE ON split_payments
            FOR EACH ROW EXECUTE FUNCTION fn_trg_split_payment_sync();
    """)

    # Backfill existing splits.
    op.execute("""
        INSERT INTO agg_split_outstanding (
            split_id, recipient_id, original_amount, paid_amount,
            outstanding_amount, updated_at
        )
        SELECT
            s.id,
            s.recipient_id,
            s.amount,
            COALESCE(p.paid, 0),
            s.amount - COALESCE(p.paid, 0),
            NOW()
        FROM transaction_splits s
        LEFT JOIN (
            SELECT split_id, SUM(amount) AS paid
            FROM split_payments
            GROUP BY split_id
        ) p ON p.split_id = s.id
        ON CONFLICT (split_id) DO UPDATE
        SET recipient_id = EXCLUDED.recipient_id,
            original_amount = EXCLUDED.original_amount,
            paid_amount = EXCLUDED.paid_amount,
            outstanding_amount = EXCLUDED.outstanding_amount,
            updated_at = NOW();
    """)


def downgrade() -> None:
    # Triggers first (they reference functions).
    op.execute("DROP TRIGGER IF EXISTS trg_split_payment_outstanding_sync ON split_payments;")
    op.execute("DROP TRIGGER IF EXISTS trg_split_outstanding_sync ON transaction_splits;")
    op.execute("DROP TRIGGER IF EXISTS trg_agg_recipient_totals_sync ON transactions;")

    # Functions.
    op.execute("DROP FUNCTION IF EXISTS fn_trg_split_payment_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_trg_split_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_split_outstanding_sync(INTEGER) CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_recipient_totals_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_recipient_totals_apply(INTEGER, CHAR, NUMERIC, INTEGER, DATE) CASCADE;")

    # Tables + MV + index.
    op.execute("DROP TABLE IF EXISTS agg_split_outstanding CASCADE;")
    op.execute("DROP TABLE IF EXISTS agg_recipient_totals CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_recipient_monthly CASCADE;")
    op.execute("DROP INDEX IF EXISTS idx_recipients_normalized_name_trgm;")
    # pg_trgm extension intentionally retained (schemaInit.js manages its lifecycle).
