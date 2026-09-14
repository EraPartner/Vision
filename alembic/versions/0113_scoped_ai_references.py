"""Add encrypted, investigation-scoped reversible AI references.

Revision ID: 0113_scoped_ai_references
Revises: 0112_portfolio_exposure_sources
Create Date: 2026-09-14

The mapping values are authenticated ciphertext. Preview scopes expire after a
short consent window and can be attached to only one investigation. The local
encryption key is deployment state and is deliberately not stored in or backed
up with PostgreSQL. Downgrade removes only the new mapping data.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0113_scoped_ai_references"
down_revision: Union[str, Sequence[str], None] = "0112_portfolio_exposure_sources"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE ai_reference_scopes (
            id UUID PRIMARY KEY,
            job_id UUID UNIQUE REFERENCES ai_investigation_jobs(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            claimed_at TIMESTAMPTZ,
            CHECK ((job_id IS NULL) = (claimed_at IS NULL))
        );
        CREATE INDEX idx_ai_reference_scopes_expiry
            ON ai_reference_scopes (expires_at);

        CREATE TABLE ai_reference_entries (
            scope_id UUID NOT NULL REFERENCES ai_reference_scopes(id) ON DELETE CASCADE,
            token TEXT NOT NULL CHECK
                (token ~ '^\\[\\[VR1:(account|recipient|investment|holding|category|document|subject|amount|date):[A-Za-z0-9_-]{24}\\]\\]$'),
            reference_type TEXT NOT NULL CHECK
                (reference_type IN ('account','recipient','investment','holding','category','document','subject','amount','date')),
            ciphertext BYTEA NOT NULL,
            nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
            auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (scope_id, token),
            UNIQUE (token)
        );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS ai_reference_entries;
        DROP TABLE IF EXISTS ai_reference_scopes;
        """
    )
