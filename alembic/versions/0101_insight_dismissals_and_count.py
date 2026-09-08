"""Persist insight dismissals and a cheap versioned digest count.

Revision ID: 0101_insight_dismissals_and_count
Revises: 0100_portfolio_retag_audit
Create Date: 2026-09-08
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0101_insight_dismissals_and_count"
down_revision: Union[str, Sequence[str], None] = "0100_portfolio_retag_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE insight_dismissals (
          id BIGSERIAL CONSTRAINT insight_dismissals_pkey PRIMARY KEY,
          kind TEXT NOT NULL CONSTRAINT chk_insight_dismissals_kind
            CHECK (kind IN ('subscription_new', 'subscription_price_change', 'category_outlier')),
          recipient_id INTEGER CONSTRAINT fk_insight_dismissals_recipient_id
            REFERENCES recipients(id) ON DELETE CASCADE,
          category_id INTEGER CONSTRAINT fk_insight_dismissals_category_id
            REFERENCES categories(id) ON DELETE CASCADE,
          month_start DATE,
          dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deviation_at_dismiss DOUBLE PRECISION,
          CONSTRAINT chk_insight_dismissals_shape CHECK (
            (kind IN ('subscription_new', 'subscription_price_change')
              AND recipient_id IS NOT NULL AND category_id IS NULL
              AND month_start IS NULL AND deviation_at_dismiss IS NULL)
            OR
            (kind = 'category_outlier' AND recipient_id IS NULL
              AND category_id IS NOT NULL AND month_start IS NOT NULL
              AND deviation_at_dismiss IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX uq_insight_dismissals_subscription
          ON insight_dismissals (kind, recipient_id)
          WHERE kind IN ('subscription_new', 'subscription_price_change');
        CREATE UNIQUE INDEX uq_insight_dismissals_outlier
          ON insight_dismissals (category_id, month_start)
          WHERE kind = 'category_outlier';

        CREATE TABLE insight_digest_state (
          singleton_id SMALLINT CONSTRAINT insight_digest_state_pkey PRIMARY KEY,
          undismissed_count INTEGER,
          dirty_version BIGINT NOT NULL DEFAULT 1,
          computed_version BIGINT NOT NULL DEFAULT 0,
          computed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          CONSTRAINT chk_insight_digest_singleton CHECK (singleton_id = 1),
          CONSTRAINT chk_insight_digest_count CHECK (undismissed_count IS NULL OR undismissed_count >= 0)
        );
        INSERT INTO insight_digest_state (singleton_id) VALUES (1);

        CREATE TABLE insight_cash_projections (
          month_start DATE NOT NULL,
          currency CHAR(3) NOT NULL,
          method_id TEXT NOT NULL,
          month_end_net_cashflow NUMERIC(20, 4) NOT NULL,
          observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT insight_cash_projections_pkey
            PRIMARY KEY (month_start, currency, method_id),
          CONSTRAINT chk_insight_cash_projection_month
            CHECK (month_start = date_trunc('month', month_start)::date)
        );

        CREATE FUNCTION mark_insight_digest_dirty() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE insight_digest_state
             SET dirty_version = dirty_version + 1
           WHERE singleton_id = 1;
          RETURN NULL;
        END;
        $$;

        CREATE TRIGGER trg_transactions_insight_digest_dirty
          AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON transactions
          FOR EACH STATEMENT EXECUTE FUNCTION mark_insight_digest_dirty();
        CREATE TRIGGER trg_categories_insight_digest_dirty
          AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON categories
          FOR EACH STATEMENT EXECUTE FUNCTION mark_insight_digest_dirty();
        CREATE TRIGGER trg_recipients_insight_digest_dirty
          AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON recipients
          FOR EACH STATEMENT EXECUTE FUNCTION mark_insight_digest_dirty();
        CREATE TRIGGER trg_planned_transactions_insight_digest_dirty
          AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON planned_transactions
          FOR EACH STATEMENT EXECUTE FUNCTION mark_insight_digest_dirty();
        CREATE TRIGGER trg_insight_dismissals_digest_dirty
          AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON insight_dismissals
          FOR EACH STATEMENT EXECUTE FUNCTION mark_insight_digest_dirty();
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TRIGGER trg_insight_dismissals_digest_dirty ON insight_dismissals;
        DROP TRIGGER trg_planned_transactions_insight_digest_dirty ON planned_transactions;
        DROP TRIGGER trg_recipients_insight_digest_dirty ON recipients;
        DROP TRIGGER trg_categories_insight_digest_dirty ON categories;
        DROP TRIGGER trg_transactions_insight_digest_dirty ON transactions;
        DROP FUNCTION mark_insight_digest_dirty();
        -- destructive-ok: This table contains derived forecast observations.
        DROP TABLE insight_cash_projections;
        -- destructive-ok: Downgrade removes saved insight-dismissal preferences.
        DROP TABLE insight_dismissals;
        DROP TABLE insight_digest_state;
        """
    )
