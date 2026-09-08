"""Retire the unused ADR-090 trade cash-leg transaction schema.

Revision ID: 0102_retire_adr090_transaction_schema
Revises: 0101_insight_dismissals_and_count
Create Date: 2026-09-08

ADR-108 removed synthetic trade cash legs in favour of real imported brokerage
cash rows. Read-only checks on 2026-09-08 found zero `transfer_source='trade'`
rows and zero non-null `portfolio_transaction_id` values in both the local
Vision database and the synthetic Demo database. The upgrade repeats both
guards and fails closed before dropping the retired column and index or
narrowing the transfer-source constraint.

Downgrade restores the nullable link column, its partial index, and the prior
constraint value. It cannot recreate trade cash-leg data because the guarded
upgrade accepts no such data to begin with.

Blast radius: transactions table metadata only; no rows are rewritten.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0102_retire_adr090_transaction_schema"
down_revision: Union[str, Sequence[str], None] = "0101_insight_dismissals_and_count"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        LOCK TABLE transactions IN ACCESS EXCLUSIVE MODE;

        DO $$
        DECLARE legacy_rows bigint;
        BEGIN
            SELECT count(*) INTO legacy_rows
            FROM transactions
            WHERE transfer_source = 'trade'
               OR portfolio_transaction_id IS NOT NULL;
            IF legacy_rows <> 0 THEN
                RAISE EXCEPTION
                    'ADR-090 retirement refused: % legacy transaction rows remain',
                    legacy_rows;
            END IF;
        END $$;

        DROP INDEX IF EXISTS idx_transactions_portfolio_txn;
        -- destructive-ok: ADR-108 removed every runtime reader/writer, and the
        -- fail-closed guard above requires zero linked or trade-source rows.
        ALTER TABLE transactions DROP COLUMN portfolio_transaction_id;

        ALTER TABLE transactions
            DROP CONSTRAINT IF EXISTS chk_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT chk_transactions_transfer_source
            CHECK (
                transfer_source IS NULL
                OR transfer_source IN ('auto', 'manual', 'opening', 'adjustment')
            );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions
            DROP CONSTRAINT IF EXISTS chk_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT chk_transactions_transfer_source
            CHECK (
                transfer_source IS NULL
                OR transfer_source IN ('auto', 'manual', 'trade', 'opening', 'adjustment')
            );

        ALTER TABLE transactions
            ADD COLUMN portfolio_transaction_id INTEGER;
        CREATE INDEX idx_transactions_portfolio_txn
            ON transactions (portfolio_transaction_id)
            WHERE portfolio_transaction_id IS NOT NULL;
        """
    )
