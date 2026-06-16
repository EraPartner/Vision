"""Add provider_api_keys table for Settings-managed research provider keys.

Revision ID: 0043_add_provider_api_keys
Revises: 0042_add_research_provider_mapping_and_quota
Create Date: 2026-06-16

Lets the user set the ADR-079 research provider API keys from the in-app Settings
UI instead of (or overriding) the environment / root `.env` (ADR-080). One row per
provider; the key is stored as-is (single-user self-hosted app — same plaintext
threat model as `.env`; the value is masked in API responses and never returned in
full to the frontend). Key resolution prefers a stored value over the env var.

Blast radius: additive — one new table, no change to any existing object, no
backfill. Registered in backup coverage (it is user-configured data worth
preserving). Downgrade drops the table (destructive only to stored keys; the env
fallback continues to work).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0043_add_provider_api_keys"
down_revision: Union[str, Sequence[str], None] = (
    "0042_add_research_provider_mapping_and_quota"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS provider_api_keys (
            provider   TEXT PRIMARY KEY,
            api_key    TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute(
        "DROP TRIGGER IF EXISTS update_provider_api_keys_updated_at ON provider_api_keys;"
    )
    op.execute("""
        CREATE TRIGGER update_provider_api_keys_updated_at
            BEFORE UPDATE ON provider_api_keys
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS update_provider_api_keys_updated_at ON provider_api_keys;"
    )
    op.execute("DROP TABLE IF EXISTS provider_api_keys;")
