"""Drop bank reconciliation tables

Revision ID: 0014_drop_bank_reconciliation
Revises: 0013_cashflow_forecast_mc
Create Date: 2026-04-26

Removes the bank_statements and reconciliation_entries tables introduced in
0007_bank_reconciliation. The feature has been removed from the application.
"""

from alembic import op
import sqlalchemy as sa

revision = '0014_drop_bank_reconciliation'
down_revision = '0013_cashflow_forecast_mc'
branch_labels = None
depends_on = None


def upgrade():
    for table in ('bank_statements', 'reconciliation_entries'):
        op.execute(sa.text(
            f"DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table}"
        ))

    op.execute(sa.text("DROP TABLE IF EXISTS reconciliation_entries"))
    op.execute(sa.text("DROP TABLE IF EXISTS bank_statements"))
    op.execute(sa.text("DROP TYPE IF EXISTS reconciliation_match_status"))


def downgrade():
    op.execute(sa.text("""
        CREATE TYPE reconciliation_match_status
            AS ENUM ('unmatched', 'auto', 'confirmed', 'manual', 'ignored')
    """))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS bank_statements (
            id              SERIAL PRIMARY KEY,
            bank_account    TEXT NOT NULL,
            currency        VARCHAR(3) NOT NULL DEFAULT 'EUR',
            period_start    DATE NOT NULL,
            period_end      DATE NOT NULL,
            opening_balance NUMERIC(15,2),
            closing_balance NUMERIC(15,2),
            notes           TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ
        )
    """))

    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS reconciliation_entries (
            id                  SERIAL PRIMARY KEY,
            bank_statement_id   INTEGER NOT NULL
                                    REFERENCES bank_statements(id) ON DELETE CASCADE,
            entry_date          DATE NOT NULL,
            description         TEXT,
            amount              NUMERIC(15,2) NOT NULL,
            currency            VARCHAR(3) NOT NULL DEFAULT 'EUR',
            transaction_id      INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
            match_status        reconciliation_match_status NOT NULL DEFAULT 'unmatched',
            match_score         NUMERIC(5,2),
            created_at          TIMESTAMPTZ DEFAULT NOW(),
            updated_at          TIMESTAMPTZ
        )
    """))

    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_bs_bank_account "
        "ON bank_statements (bank_account)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_bs_period "
        "ON bank_statements (period_start, period_end)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_re_statement "
        "ON reconciliation_entries (bank_statement_id)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_re_status "
        "ON reconciliation_entries (match_status)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_re_transaction "
        "ON reconciliation_entries (transaction_id) WHERE transaction_id IS NOT NULL"
    ))

    for table in ('bank_statements', 'reconciliation_entries'):
        op.execute(sa.text(f"""
            CREATE TRIGGER update_{table}_updated_at
                BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        """))
