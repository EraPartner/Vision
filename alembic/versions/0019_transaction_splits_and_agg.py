"""Add transaction_splits, split_payments, and agg_split_outstanding tables

Revision ID: 0019_transaction_splits_and_agg
Revises: 0018_portfolio_performance_snapshots
Create Date: 2026-05-02

"""
from typing import Sequence, Union

from alembic import op

revision: str = '0019_transaction_splits_and_agg'
down_revision: Union[str, Sequence[str], None] = '0018_portfolio_performance_snapshots'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS transaction_splits (
            id SERIAL PRIMARY KEY,
            transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
            amount NUMERIC(15,2) NOT NULL,
            note TEXT,
            is_settled BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_splits_transaction ON transaction_splits(transaction_id);
        CREATE INDEX IF NOT EXISTS idx_splits_recipient ON transaction_splits(recipient_id);
        CREATE INDEX IF NOT EXISTS idx_splits_unsettled ON transaction_splits(is_settled) WHERE is_settled = false;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS split_payments (
            id SERIAL PRIMARY KEY,
            split_id INTEGER NOT NULL REFERENCES transaction_splits(id) ON DELETE CASCADE,
            amount NUMERIC(15,2) NOT NULL,
            paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_split_payments_split ON split_payments(split_id);
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS update_transaction_splits_updated_at ON transaction_splits;
        CREATE TRIGGER update_transaction_splits_updated_at
            BEFORE UPDATE ON transaction_splits
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    """)

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


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_split_payment_outstanding_sync ON split_payments;")
    op.execute("DROP TRIGGER IF EXISTS trg_split_outstanding_sync ON transaction_splits;")
    op.execute("DROP TRIGGER IF EXISTS update_transaction_splits_updated_at ON transaction_splits;")
    op.execute("DROP FUNCTION IF EXISTS fn_trg_split_payment_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_trg_split_sync() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS fn_agg_split_outstanding_sync(INTEGER) CASCADE;")
    op.execute("DROP TABLE IF EXISTS agg_split_outstanding CASCADE;")
    op.execute("DROP TABLE IF EXISTS split_payments CASCADE;")
    op.execute("DROP TABLE IF EXISTS transaction_splits CASCADE;")
