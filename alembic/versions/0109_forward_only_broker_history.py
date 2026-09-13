"""Add forward-only per-broker portfolio snapshots.

Revision ID: 0109_forward_only_broker_history
Revises: 0108_provider_neutral_provenance
Create Date: 2026-09-13

The older ``portfolio_snapshot_accounts`` relation belongs to the retired
historical account replay.  It can contain recomputed history, so it is not
reused: exposing it would violate the forward-only/no-backfill contract.

This new table starts empty.  The runtime writes only the current application
date.  Account identity and display text are copied into each row rather than
foreign-keyed, which preserves an already-recorded day after later account
retagging, renaming, archival, or deletion.

Blast radius: one additive table and one index.  No existing data is read or
rewritten.  Downgrade drops only the new derived snapshot relation.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0109_forward_only_broker_history"
down_revision: Union[str, Sequence[str], None] = "0108_provider_neutral_provenance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE portfolio_broker_snapshots (
            snapshot_date DATE NOT NULL,
            currency VARCHAR(3) NOT NULL
                CHECK (currency ~ '^[A-Z]{3}$'),
            account_key TEXT NOT NULL
                CHECK (account_key = 'unassigned' OR account_key ~ '^account:[1-9][0-9]*$'),
            account_id INTEGER,
            account_name TEXT NOT NULL,
            value NUMERIC(18, 2) NOT NULL,
            invested NUMERIC(18, 2) NOT NULL,
            gain_loss NUMERIC(18, 2) NOT NULL,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (snapshot_date, currency, account_key),
            CHECK (
                (account_key = 'unassigned' AND account_id IS NULL)
                OR account_key = 'account:' || account_id::text
            )
        );

        CREATE INDEX idx_portfolio_broker_snapshots_currency_date
            ON portfolio_broker_snapshots (currency, snapshot_date);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS idx_portfolio_broker_snapshots_currency_date;
        DROP TABLE IF EXISTS portfolio_broker_snapshots;
        """
    )
