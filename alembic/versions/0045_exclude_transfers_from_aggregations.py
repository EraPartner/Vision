"""Exclude internal transfers from cash-flow aggregations (ADR-083).

Revision ID: 0045_exclude_transfers_from_aggregations
Revises: 0044_add_transfer_pairing
Create Date: 2026-06-18

Transfers between a user's own accounts (migration 0044) must not count as
income or spending. This migration excludes them from the trigger-maintained
recipient totals, and drops the three income/spending materialized views so the
app recreates them with transfer-excluding definitions on next startup
(materializedViewService.createMaterializedViews runs after migrations).

  - fn_agg_recipient_totals_sync: a row now counts only when
    `is_active AND NOT is_transfer`. Marking a row as a transfer fires an UPDATE
    that removes it (OLD counted, NEW does not); un-marking adds it back. The
    table self-corrects as the warmup backfill marks existing transfers — no
    re-seed needed here (no transfers are marked yet at migration time).
  - mv_monthly_summary / mv_category_totals / mv_cashflow_daily are dropped and
    recreated at startup with `AND t.is_transfer = false`.

mv_bank_balances is intentionally NOT touched — account balances must reflect
the real money movement of a transfer.

Blast radius: trigger-function redefinition (no data rewrite) + drop/recreate of
three derived MVs. Downgrade restores the prior function, re-seeds
agg_recipient_totals from the base table (so totals that were skewed while
transfers were being excluded are recomputed rather than left drifting), and
likewise drops the MVs so the older code recreates the prior definitions.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0045_exclude_transfers_from_aggregations"
down_revision: Union[str, Sequence[str], None] = "0044_add_transfer_pairing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
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
    """)

    # Drop the income/spending MVs so createMaterializedViews recreates them with
    # the transfer-excluding definitions. mv_bank_balances keeps transfers.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_category_totals CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_cashflow_daily CASCADE;")


def downgrade() -> None:
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

    # Re-seed agg_recipient_totals from scratch so the running totals match the
    # restored (transfer-counting) function. While 0045+ was live, every row that
    # got marked as a transfer was *subtracted* from the aggregate (OLD counted,
    # NEW did not). Merely restoring the old function above would leave that
    # negative drift in place, and the first UPDATE of a former-transfer row under
    # the restored function would subtract an OLD amount that was never counted —
    # compounding the corruption. agg_recipient_totals is trigger-maintained only
    # (no reseed path in the app), so a full recompute from the base table here is
    # the only way to restore a consistent aggregate. This mirrors the backfill in
    # 0035's upgrade and counts all active rows regardless of is_transfer, exactly
    # as the restored function now does.
    op.execute("TRUNCATE agg_recipient_totals;")
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
        GROUP BY t.recipient_id, t.currency;
    """)

    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_category_totals CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_cashflow_daily CASCADE;")
