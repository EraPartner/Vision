"""Normalise user_settings timestamp columns

Revision ID: 0032_user_settings_timestamptz
Revises: 0031_add_transaction_tags
Create Date: 2026-05-11

Aligns user_settings with the rest of the schema (transactions, attachments,
all raw bank tables, tags) which already use TIMESTAMPTZ.

Two real-world shapes exist:
  (a) Created fresh by 0030_add_user_settings_table: both created_at and
      updated_at are TIMESTAMP (naive). Need conversion to TIMESTAMPTZ.
  (b) Created by legacy runtime DDL in settingsRepository.js before ADR-027:
      no created_at column at all, updated_at already TIMESTAMPTZ. Need to
      add created_at as TIMESTAMPTZ.

The migration is idempotent on both shapes: it adds created_at if missing,
then converts each column to TIMESTAMPTZ only if it isn't already.

Conversion treats existing naive TIMESTAMP values as UTC, matching how the
backend writes them via CURRENT_TIMESTAMP on a UTC-configured Postgres.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0032_user_settings_timestamptz'
down_revision: Union[str, Sequence[str], None] = '0031_add_transaction_tags'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add created_at if it's missing (legacy DBs from runtime DDL).
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'user_settings' AND column_name = 'created_at'
            ) THEN
                ALTER TABLE user_settings
                    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
            END IF;
        END
        $$;
    """)

    # 2. Convert created_at to TIMESTAMPTZ if still naive.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'user_settings'
                  AND column_name = 'created_at'
                  AND data_type = 'timestamp without time zone'
            ) THEN
                -- destructive-ok: shipped 2026-05-11, annotated retroactively. TIMESTAMP ->
                -- TIMESTAMPTZ is a widening reinterpretation, not a narrowing: no precision is
                -- lost and the guarded IF EXISTS makes it a no-op once already converted.
                ALTER TABLE user_settings
                    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
            END IF;
        END
        $$;
    """)

    # 3. Convert updated_at to TIMESTAMPTZ if still naive.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'user_settings'
                  AND column_name = 'updated_at'
                  AND data_type = 'timestamp without time zone'
            ) THEN
                -- destructive-ok: shipped 2026-05-11, annotated retroactively. Same widening
                -- reinterpretation as created_at above; naive values are read as UTC, matching how
                -- the backend wrote them. Guarded, so it is a no-op on already-converted shapes.
                ALTER TABLE user_settings
                    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
            END IF;
        END
        $$;
    """)


def downgrade() -> None:
    # Best-effort: convert both columns back to naive TIMESTAMP. Does not
    # drop created_at — re-adding via upgrade is cheap, but losing the row
    # creation timestamps on downgrade would be lossy.
    op.execute("""
        ALTER TABLE user_settings
            ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC',
            ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at AT TIME ZONE 'UTC';
    """)
