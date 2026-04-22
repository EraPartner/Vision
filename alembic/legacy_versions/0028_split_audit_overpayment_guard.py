"""Split audit trail + DB-level overpayment guard — Phase 4 of the
non-portfolio refactor.

Revision ID: 0028_split_audit_overpayment_guard
Revises: 0027_planned_execution_idempotency
Create Date: 2026-04-16

Two changes, both additive:

1. split_audit — append-only trail of split lifecycle events
   (create/update/delete/pay/settle/unsettle). Route layer writes audit
   rows inside the same transaction as the mutation. Payload is JSONB so
   we can evolve event shapes without further migrations.

2. fn_split_payment_overpayment_guard trigger — second-line defense
   against overpayment. Route/service layer enforces the invariant via
   services/calculations/splits.js::validatePaymentAmount, but a DB
   trigger catches any future caller that bypasses the service layer.
   Fires on INSERT OR UPDATE of split_payments; raises SQLSTATE 23514
   (check_violation) when SUM(payments) > transaction_splits.amount +
   1-cent tolerance.

Rollback is safe: audit table and trigger are additive, nothing reads
from the audit table as a source of truth.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0028_split_audit_overpayment_guard'
down_revision: Union[str, Sequence[str], None] = '0027_planned_execution_idempotency'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. split_audit — append-only event log
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS split_audit (
            id BIGSERIAL PRIMARY KEY,
            split_id INTEGER REFERENCES transaction_splits(id) ON DELETE SET NULL,
            action VARCHAR(32) NOT NULL,
            actor VARCHAR(64),
            payload JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_split_audit_split_created
            ON split_audit (split_id, created_at DESC);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_split_audit_action_created
            ON split_audit (action, created_at DESC);
    """)

    # ------------------------------------------------------------------
    # 2. Overpayment guard trigger on split_payments
    # ------------------------------------------------------------------
    # Tolerance of 1 cent matches CENT_TOLERANCE in
    # services/calculations/splits.js, chosen for NUMERIC(15,2) ↔ JS
    # float round-trip safety.
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_split_payment_overpayment_guard()
        RETURNS trigger AS $$
        DECLARE
            v_split_amount NUMERIC(15, 2);
            v_paid_total NUMERIC(15, 2);
        BEGIN
            SELECT amount INTO v_split_amount
            FROM transaction_splits
            WHERE id = NEW.split_id;

            IF v_split_amount IS NULL THEN
                RAISE EXCEPTION 'split_payment references missing split_id=%', NEW.split_id
                    USING ERRCODE = '23503';
            END IF;

            SELECT COALESCE(SUM(amount), 0) INTO v_paid_total
            FROM split_payments
            WHERE split_id = NEW.split_id
              AND (TG_OP = 'INSERT' OR id <> NEW.id);

            v_paid_total := v_paid_total + NEW.amount;

            IF v_paid_total > v_split_amount + 0.005 THEN
                RAISE EXCEPTION 'payment would exceed split outstanding balance: paid_total=% > split_amount=%',
                    v_paid_total, v_split_amount
                    USING ERRCODE = '23514';
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_split_payment_overpayment_guard ON split_payments;
        CREATE TRIGGER trg_split_payment_overpayment_guard
            BEFORE INSERT OR UPDATE OF amount, split_id ON split_payments
            FOR EACH ROW EXECUTE FUNCTION fn_split_payment_overpayment_guard();
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_split_payment_overpayment_guard ON split_payments;")
    op.execute("DROP FUNCTION IF EXISTS fn_split_payment_overpayment_guard();")
    op.execute("DROP INDEX IF EXISTS idx_split_audit_action_created;")
    op.execute("DROP INDEX IF EXISTS idx_split_audit_split_created;")
    op.execute("DROP TABLE IF EXISTS split_audit;")
