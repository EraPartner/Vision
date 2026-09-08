"""Add durable audit receipts for bulk portfolio broker re-tagging.

Revision ID: 0100_portfolio_retag_audit
Revises: 0099_canonical_biweekly_recurrence
Create Date: 2026-09-07

The source and destination account IDs deliberately have no foreign keys. An
audit receipt must survive later account deletion and remain self-contained.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0100_portfolio_retag_audit"
down_revision: Union[str, Sequence[str], None] = "0099_canonical_biweekly_recurrence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE portfolio_retag_audit (
          id BIGSERIAL CONSTRAINT portfolio_retag_audit_pkey PRIMARY KEY,
          idempotency_key UUID NOT NULL
            CONSTRAINT uq_portfolio_retag_audit_idempotency_key UNIQUE,
          request_fingerprint CHAR(64) NOT NULL,
          from_account_id INTEGER,
          to_account_id INTEGER,
          transaction_ids JSONB NOT NULL,
          previous_assignments JSONB NOT NULL,
          selected_count INTEGER NOT NULL
            CONSTRAINT chk_portfolio_retag_audit_selected_count
            CHECK (selected_count > 0),
          changed_count INTEGER NOT NULL
            CONSTRAINT chk_portfolio_retag_audit_changed_count CHECK (
            changed_count >= 0 AND changed_count <= selected_count
          ),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_portfolio_retag_transaction_ids_array
            CHECK (jsonb_typeof(transaction_ids) = 'array'),
          CONSTRAINT chk_portfolio_retag_previous_assignments_array
            CHECK (jsonb_typeof(previous_assignments) = 'array')
        );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        -- destructive-ok: Downgrading intentionally removes immutable broker
        -- re-tag receipts. Export a backup before using this rollback.
        DROP TABLE portfolio_retag_audit;
        """
    )
