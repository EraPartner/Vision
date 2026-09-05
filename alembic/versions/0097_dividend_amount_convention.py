"""Record whether a dividend amount is gross or net.

Revision ID: 0097_dividend_amount_convention
Revises: 0096_normalize_saved_chart_filters
Create Date: 2026-09-04

Existing transactions cannot be classified safely, so they remain ``unknown``.
New and edited dividend rows can explicitly identify the amount convention.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0097_dividend_amount_convention"
down_revision: Union[str, Sequence[str], None] = "0096_normalize_saved_chart_filters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_transactions
          ADD COLUMN dividend_amount_convention VARCHAR(7)
            NOT NULL DEFAULT 'unknown',
          ADD CONSTRAINT chk_portfolio_transactions_dividend_amount_convention
            CHECK (dividend_amount_convention IN ('gross', 'net', 'unknown'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_transactions
          DROP CONSTRAINT chk_portfolio_transactions_dividend_amount_convention,
          DROP COLUMN dividend_amount_convention;
        """
    )
