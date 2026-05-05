"""Expand portfolio_txn_type enum with corporate action types

Revision ID: 0006_portfolio_event_types
Revises: 0005_bill_reminder_days
Create Date: 2026-04-24

Adds split, merger, spinoff, return_of_capital to the portfolio_txn_type
enum so portfolio transactions can model the full lifecycle of a holding.
"""

from alembic import op
import sqlalchemy as sa

revision = '0006_portfolio_event_types'
down_revision = '0005_bill_reminder_days'
branch_labels = None
depends_on = None

NEW_TYPES = ['split', 'merger', 'spinoff', 'return_of_capital']


def upgrade():
    # Postgres requires ALTER TYPE … ADD VALUE for enum additions.
    # Each ADD VALUE is committed immediately (cannot run inside a transaction).
    for value in NEW_TYPES:
        op.execute(
            sa.text(f"ALTER TYPE portfolio_txn_type ADD VALUE IF NOT EXISTS '{value}'")
        )


def downgrade():
    # Postgres does not support removing enum values directly.
    # The safest rollback recreates the enum without the new values,
    # migrating any rows that use them to NULL first.
    op.execute(sa.text("""
        UPDATE portfolio_transactions
        SET type = 'sell'
        WHERE type::text = ANY(ARRAY['split','merger','spinoff','return_of_capital'])
    """))

    op.execute(sa.text("ALTER TABLE portfolio_transactions ALTER COLUMN type TYPE TEXT"))
    op.execute(sa.text("DROP TYPE IF EXISTS portfolio_txn_type"))
    op.execute(sa.text("""
        CREATE TYPE portfolio_txn_type AS ENUM (
            'buy','sell','dividend','fee','tax','interest',
            'rent_income','appreciation','gift'
        )
    """))
    op.execute(sa.text("""
        ALTER TABLE portfolio_transactions
            ALTER COLUMN type TYPE portfolio_txn_type
            USING type::portfolio_txn_type
    """))
