"""Add explicit portfolio exposure mappings and fund source documents.

Revision ID: 0112_portfolio_exposure_sources
Revises: 0111_ai_research_investigations
Create Date: 2026-09-14

The migration is additive. It stores only user-supplied, versioned source JSON
and explicit classifications. It does not infer classifications or rewrite
portfolio transactions. Downgrade removes the new exposure data only.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0112_portfolio_exposure_sources"
down_revision: Union[str, Sequence[str], None] = "0111_ai_research_investigations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE portfolio_exposure_classifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            investment_id INTEGER REFERENCES investments(id) ON DELETE CASCADE,
            identifier_type TEXT,
            identifier_value TEXT,
            identifier_exchange TEXT,
            issuer_id TEXT NOT NULL CHECK (length(issuer_id) BETWEEN 1 AND 128),
            issuer_name TEXT NOT NULL CHECK (length(issuer_name) BETWEEN 1 AND 256),
            sector TEXT CHECK (length(sector) BETWEEN 1 AND 128),
            issuer_country_code CHAR(2) CHECK (issuer_country_code ~ '^[A-Z]{2}$'),
            source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 300),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (
                (investment_id IS NOT NULL AND identifier_type IS NULL AND identifier_value IS NULL AND identifier_exchange IS NULL)
                OR
                (investment_id IS NULL AND identifier_type IS NOT NULL AND identifier_value IS NOT NULL)
            ),
            CHECK (identifier_type IS NULL OR identifier_type IN ('isin','ticker','sedol','cusip','lei','proprietary'))
        );
        CREATE UNIQUE INDEX uq_portfolio_exposure_classification_investment
            ON portfolio_exposure_classifications (investment_id)
            WHERE investment_id IS NOT NULL;
        CREATE UNIQUE INDEX uq_portfolio_exposure_classification_identifier
            ON portfolio_exposure_classifications
                (identifier_type, identifier_value, COALESCE(identifier_exchange, ''))
            WHERE investment_id IS NULL;

        CREATE TABLE portfolio_fund_holdings_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            investment_id INTEGER NOT NULL UNIQUE REFERENCES investments(id) ON DELETE CASCADE,
            share_class_identifier_json JSONB NOT NULL,
            document_json JSONB NOT NULL,
            source_as_of_date DATE NOT NULL,
            source_sha256 CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_portfolio_fund_holdings_as_of
            ON portfolio_fund_holdings_documents (source_as_of_date DESC);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS portfolio_fund_holdings_documents;
        DROP TABLE IF EXISTS portfolio_exposure_classifications;
        """
    )
