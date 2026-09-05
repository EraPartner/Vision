"""Apply one trigger-owned updated_at policy to mutable tables.

Revision ID: 0092_updated_at_policy
Revises: 0091_import_staging_resolved_fks
Create Date: 2026-09-04

Every ordinary mutable table that exposes ``updated_at`` now uses the shared
``update_updated_at_column()`` trigger. The trigger-maintained
``agg_split_outstanding`` table remains the explicit exception: its refresh
function owns the timestamp together with the aggregate values. Three mutable
tables that had no update timestamp gain one so operational and import
diagnostics can distinguish creation from later mutation.

Existing application writes that explicitly set ``updated_at`` remain valid;
the BEFORE UPDATE trigger becomes the final authority. Existing staging rows
are backfilled from ``created_at`` so the migration does not mislabel them as
newly modified. The preference table has no creation timestamp, so its existing
rows use migration time.

Blast radius: seven small or low-churn tables. Downgrade drops the seven
triggers and removes only the three columns introduced here. Values written to
those new columns are intentionally lost on downgrade.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0092_updated_at_policy"
down_revision: Union[str, Sequence[str], None] = "0091_import_staging_resolved_fks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_EXISTING_UPDATED_AT_TABLES = (
    "exchange_rates",
    "user_settings",
    "ai_conversations",
    "provider_health",
)

_NEW_UPDATED_AT_TABLES = (
    "investment_ticker_prefs",
    "import_staging_rows",
    "portfolio_import_staging_rows",
)

_UPDATED_AT_BACKFILL_SOURCES = {
    "investment_ticker_prefs": "NOW()",
    "import_staging_rows": "created_at",
    "portfolio_import_staging_rows": "created_at",
}


def upgrade() -> None:
    for table in _NEW_UPDATED_AT_TABLES:
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"
        )
        op.execute(
            f"UPDATE {table} "
            f"SET updated_at = COALESCE(updated_at, {_UPDATED_AT_BACKFILL_SOURCES[table]}) "
            "WHERE updated_at IS NULL"
        )
        op.execute(
            f"ALTER TABLE {table} "
            "ALTER COLUMN updated_at SET DEFAULT NOW(), "
            "ALTER COLUMN updated_at SET NOT NULL"
        )

    for table in (*_EXISTING_UPDATED_AT_TABLES, *_NEW_UPDATED_AT_TABLES):
        op.execute(f"DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table}")
        op.execute(
            f"""
            CREATE TRIGGER update_{table}_updated_at
                BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
            """
        )


def downgrade() -> None:
    for table in reversed((*_EXISTING_UPDATED_AT_TABLES, *_NEW_UPDATED_AT_TABLES)):
        op.execute(f"DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table}")

    for table in reversed(_NEW_UPDATED_AT_TABLES):
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS updated_at")
