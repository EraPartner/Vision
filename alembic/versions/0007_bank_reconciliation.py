"""Add bank reconciliation tables

Revision ID: 0007_bank_reconciliation
Revises: 0006_portfolio_event_types
Create Date: 2026-04-24

Creates two tables:
  bank_statements   — a period-based statement header (account + date range + balances)
  reconciliation_entries — individual line items from the statement, each optionally
                           linked to an existing transaction once matched

match_status enum values:
  unmatched   — no transaction linked yet
  auto        — linked by the auto-match algorithm (pending user confirmation)
  confirmed   — user confirmed the match
  manual      — user manually linked a transaction
  ignored     — user marked as not needing a match (e.g. bank fees with no transaction)
"""

from alembic import op
import sqlalchemy as sa

revision = '0007_bank_reconciliation'
down_revision = '0006_portfolio_event_types'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("""
        DO $$ BEGIN
            CREATE TYPE reconciliation_match_status
                AS ENUM ('unmatched', 'auto', 'confirmed', 'manual', 'ignored');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
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

    # Indexes
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

    # updated_at triggers
    for table in ('bank_statements', 'reconciliation_entries'):
        op.execute(sa.text(f"DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table}"))
        op.execute(sa.text(f"""
            CREATE TRIGGER update_{table}_updated_at
                BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        """))


def downgrade():
    for table in ('bank_statements', 'reconciliation_entries'):
        op.execute(sa.text(
            f"DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table}"
        ))

    op.execute(sa.text("DROP TABLE IF EXISTS reconciliation_entries"))
    op.execute(sa.text("DROP TABLE IF EXISTS bank_statements"))
    op.execute(sa.text("DROP TYPE IF EXISTS reconciliation_match_status"))
