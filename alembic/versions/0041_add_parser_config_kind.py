"""Add a kind discriminator to custom_parser_configs.

Revision ID: 0041_add_parser_config_kind
Revises: 0040_add_portfolio_import_staging
Create Date: 2026-06-15

Saved CSV parsers now exist for two domains: bank-statement imports
('transaction') and portfolio-trade imports ('portfolio'). They share the same
shape (a name + a JSONB config), so rather than a second near-identical table
this adds a `kind` discriminator and widens uniqueness from name to (name, kind)
— a budgeting parser and a portfolio parser may share a name.

Existing rows are all bank-statement parsers; the NOT NULL DEFAULT 'transaction'
backfills them. The backend conflict handler keys on the new
`uq_custom_parser_configs_name_kind` constraint name (see importRoutes.js).

Blast radius: additive column + a unique-index swap on an existing table. The
downgrade is destructive — it deletes any non-'transaction' parsers so the
single-column unique on `name` can be recreated without collisions.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0041_add_parser_config_kind"
down_revision: Union[str, Sequence[str], None] = "0040_add_portfolio_import_staging"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE custom_parser_configs
          ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'transaction';
    """)
    op.execute("""
        ALTER TABLE custom_parser_configs
          DROP CONSTRAINT IF EXISTS ck_custom_parser_configs_kind;
    """)
    op.execute("""
        ALTER TABLE custom_parser_configs
          ADD CONSTRAINT ck_custom_parser_configs_kind
          CHECK (kind IN ('transaction','portfolio'));
    """)

    # Swap name-unique for (name, kind)-unique so both domains can reuse a name.
    op.execute("DROP INDEX IF EXISTS uq_custom_parser_configs_name;")
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_parser_configs_name_kind
          ON custom_parser_configs (name, kind);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_custom_parser_configs_name_kind;")
    # Non-'transaction' parsers can collide on a name-only unique; drop them.
    op.execute("DELETE FROM custom_parser_configs WHERE kind <> 'transaction';")
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_parser_configs_name
          ON custom_parser_configs (name);
    """)
    op.execute("""
        ALTER TABLE custom_parser_configs
          DROP CONSTRAINT IF EXISTS ck_custom_parser_configs_kind;
    """)
    op.execute("ALTER TABLE custom_parser_configs DROP COLUMN IF EXISTS kind;")
