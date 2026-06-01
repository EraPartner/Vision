"""Add custom_parser_configs table for saved named CSV import parsers.

Revision ID: 0037_add_custom_parser_configs
Revises: 0036_add_transactions_tx_hash
Create Date: 2026-06-01

Custom CSV imports previously required re-entering the full column mapping
(date/recipient/amount columns, date format, separator, encoding, skip-rows)
on every import — the config lived only in transient frontend state.

This table persists a named, reusable parser config. `name` is unique and also
doubles as the bank/account label written onto imported transactions. The
mapping itself is stored as JSONB so the frontend can round-trip its
`CustomConfig` shape without a column-per-field schema.

The `updated_at` column is maintained by the shared `update_updated_at_column()`
trigger function (defined in the baseline schema).
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0037_add_custom_parser_configs'
down_revision: Union[str, Sequence[str], None] = '0036_add_transactions_tx_hash'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS custom_parser_configs (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            config_json JSONB NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_parser_configs_name
        ON custom_parser_configs (name);
    """)

    op.execute("DROP TRIGGER IF EXISTS update_custom_parser_configs_updated_at ON custom_parser_configs;")
    op.execute("""
        CREATE TRIGGER update_custom_parser_configs_updated_at
            BEFORE UPDATE ON custom_parser_configs
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS update_custom_parser_configs_updated_at ON custom_parser_configs;")
    op.execute("DROP INDEX IF EXISTS uq_custom_parser_configs_name;")
    op.execute("DROP TABLE IF EXISTS custom_parser_configs;")
