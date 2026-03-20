"""Add loan fields and repayment schedule for planned transactions

Revision ID: 0011_planned_loans
Revises: 0010_inv_muni_tax
Create Date: 2026-03-13

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0011_planned_loans'
down_revision: Union[str, Sequence[str], None] = '0010_inv_muni_tax'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE planned_transactions
            ADD COLUMN IF NOT EXISTS is_loan BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS loan_type TEXT,
            ADD COLUMN IF NOT EXISTS loan_principal NUMERIC(15,2),
            ADD COLUMN IF NOT EXISTS loan_annual_interest_rate NUMERIC(8,4),
            ADD COLUMN IF NOT EXISTS loan_term_months INTEGER,
            ADD COLUMN IF NOT EXISTS loan_start_date DATE,
            ADD COLUMN IF NOT EXISTS loan_payment_day INTEGER,
            ADD COLUMN IF NOT EXISTS loan_regular_payment_amount NUMERIC(15,2),
            ADD COLUMN IF NOT EXISTS loan_first_payment_date DATE;

        CREATE INDEX IF NOT EXISTS idx_pt_is_loan ON planned_transactions(is_loan);
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS planned_transaction_loan_schedule (
            id SERIAL PRIMARY KEY,
            planned_transaction_id INTEGER NOT NULL REFERENCES planned_transactions(id) ON DELETE CASCADE,
            installment_number INTEGER NOT NULL,
            due_date DATE NOT NULL,
            payment_amount NUMERIC(15,2) NOT NULL,
            principal_amount NUMERIC(15,2) NOT NULL,
            interest_amount NUMERIC(15,2) NOT NULL,
            remaining_principal NUMERIC(15,2) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ,
            CONSTRAINT uq_ptls_planned_installment UNIQUE (planned_transaction_id, installment_number)
        );

        CREATE INDEX IF NOT EXISTS idx_ptls_planned_transaction_id
            ON planned_transaction_loan_schedule(planned_transaction_id);
        CREATE INDEX IF NOT EXISTS idx_ptls_due_date
            ON planned_transaction_loan_schedule(due_date);

        DROP TRIGGER IF EXISTS update_ptls_updated_at ON planned_transaction_loan_schedule;
        CREATE TRIGGER update_ptls_updated_at
            BEFORE UPDATE ON planned_transaction_loan_schedule
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    op.execute("""
        DROP TRIGGER IF EXISTS update_ptls_updated_at ON planned_transaction_loan_schedule;
        DROP TABLE IF EXISTS planned_transaction_loan_schedule CASCADE;
        DROP INDEX IF EXISTS idx_pt_is_loan;

        ALTER TABLE planned_transactions
            DROP COLUMN IF EXISTS loan_first_payment_date,
            DROP COLUMN IF EXISTS loan_regular_payment_amount,
            DROP COLUMN IF EXISTS loan_payment_day,
            DROP COLUMN IF EXISTS loan_start_date,
            DROP COLUMN IF EXISTS loan_term_months,
            DROP COLUMN IF EXISTS loan_annual_interest_rate,
            DROP COLUMN IF EXISTS loan_principal,
            DROP COLUMN IF EXISTS loan_type,
            DROP COLUMN IF EXISTS is_loan;
    """)
