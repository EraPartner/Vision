"""Watchlist what-if backtest: snapshot the price when an item is added (ADR-097).

Revision ID: 0058_watchlist_added_price
Revises: 0057_portfolio_import_batch_account_id
Create Date: 2026-06-18

The watchlist already records WHEN an item was added (created_at), but not the price at that
moment — so "had I bought it when I added it, I'd be up X%" couldn't be computed. This adds a
nullable added_price snapshotted at add time from the live quote (ADR-097, watchlist analytics).

Nullable because pre-existing watchlist rows have no historical snapshot and items added without a
resolvable quote simply skip the backtest. No backfill — the figure becomes available for rows
added from here on.

Blast radius: one nullable column. No data change. Downgrade drops it.

NOTE: migrations are not auto-run by the agent — authored here; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0058_watchlist_added_price"
down_revision: Union[str, Sequence[str], None] = (
    "0057_portfolio_import_batch_account_id"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE watchlist
            ADD COLUMN IF NOT EXISTS added_price NUMERIC(18,6);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE watchlist DROP COLUMN IF EXISTS added_price;
        """
    )
