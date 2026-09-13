"""Add versioned, read-only analysis dataset views.

Revision ID: 0107_analysis_dataset_views
Revises: 0106_remove_federal_pit_total_alias
Create Date: 2026-09-12

The views expose a deliberately bounded subset of the local user's financial
database. They omit credentials, provider configuration, raw import payloads,
admin audit data, and internal duplicate identities. A future restricted SQL
executor must receive explicit SELECT grants; PUBLIC receives none here.

Blast radius: four ordinary views and one schema. No persisted rows are
rewritten. Downgrade drops only these views and the now-empty schema.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0107_analysis_dataset_views"
down_revision: Union[str, Sequence[str], None] = "0106_remove_federal_pit_total_alias"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE SCHEMA vision_analysis;
        REVOKE ALL ON SCHEMA vision_analysis FROM PUBLIC;

        CREATE VIEW vision_analysis.transactions_v1
        WITH (security_barrier = true) AS
        SELECT
            t.id AS transaction_id,
            t.date AS transaction_date,
            t.amount,
            t.currency,
            t.account_id,
            a.name AS account_name,
            a.display_name AS account_display_name,
            t.recipient_id,
            r.name AS recipient_name,
            t.category_id,
            c.general AS category_general,
            c.detail AS category_detail,
            t.memo,
            t.comment,
            t.is_transfer,
            t.transfer_peer_id,
            t.transfer_source,
            t.is_active,
            t.import_batch_id,
            t.created_at,
            t.updated_at
        FROM public.transactions AS t
        LEFT JOIN public.accounts AS a ON a.id = t.account_id
        LEFT JOIN public.recipients AS r ON r.id = t.recipient_id
        LEFT JOIN public.categories AS c ON c.id = t.category_id;

        CREATE VIEW vision_analysis.accounts_v1
        WITH (security_barrier = true) AS
        SELECT
            a.id AS account_id,
            a.name AS account_name,
            a.display_name,
            a.institution,
            a.currency,
            a.type AS account_type,
            a.liquidity_class,
            a.spendable,
            a.in_net_worth,
            a.tax_wrapper,
            a.owner,
            a.multi_currency_cash,
            a.has_cash_sleeve,
            a.funding_account_id,
            a.is_active,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'currency', sb.currency,
                        'balance', sb.balance,
                        'balance_date', sb.balance_date
                    ) ORDER BY sb.currency
                ) FILTER (WHERE sb.account_id IS NOT NULL),
                '[]'::jsonb
            ) AS statement_balances,
            a.created_at,
            a.updated_at
        FROM public.accounts AS a
        LEFT JOIN public.account_statement_balances AS sb
          ON sb.account_id = a.id
        GROUP BY a.id;

        CREATE VIEW vision_analysis.holding_events_v1
        WITH (security_barrier = true) AS
        SELECT
            pt.id AS event_id,
            pt.investment_id,
            i.name AS investment_name,
            i.symbol,
            i.asset_class,
            pt.account_id,
            a.name AS account_name,
            pt.type AS event_type,
            pt.date AS event_date,
            pt.amount,
            pt.units,
            pt.price_per_unit,
            COALESCE(pt.fees, 0) AS fees,
            COALESCE(pt.taxes, 0) AS taxes,
            pt.currency,
            pt.fx_rate_to_eur,
            pt.is_recurring,
            pt.recurrence_interval,
            pt.recurrence_end_date,
            pt.import_batch_id,
            pt.created_at,
            pt.updated_at
        FROM public.portfolio_transactions AS pt
        JOIN public.investments AS i ON i.id = pt.investment_id
        LEFT JOIN public.accounts AS a ON a.id = pt.account_id;

        CREATE VIEW vision_analysis.cash_flows_v1
        WITH (security_barrier = true) AS
        SELECT
            t.id AS cash_flow_id,
            t.date AS cash_flow_date,
            t.account_id,
            a.name AS account_name,
            t.currency,
            t.amount AS signed_amount,
            CASE
                WHEN t.is_transfer THEN 'transfer'
                WHEN t.amount < 0 THEN 'expense'
                ELSE 'income_or_refund'
            END AS flow_type,
            CASE WHEN NOT t.is_transfer AND t.amount < 0
                 THEN -t.amount ELSE 0 END AS spending_amount,
            CASE WHEN NOT t.is_transfer AND t.amount > 0
                 THEN t.amount ELSE 0 END AS positive_flow_amount,
            t.is_transfer,
            t.transfer_peer_id,
            t.recipient_id,
            r.name AS recipient_name,
            t.category_id,
            c.general AS category_general,
            c.detail AS category_detail,
            t.is_active,
            t.updated_at
        FROM public.transactions AS t
        LEFT JOIN public.accounts AS a ON a.id = t.account_id
        LEFT JOIN public.recipients AS r ON r.id = t.recipient_id
        LEFT JOIN public.categories AS c ON c.id = t.category_id;

        REVOKE ALL ON ALL TABLES IN SCHEMA vision_analysis FROM PUBLIC;
        COMMENT ON SCHEMA vision_analysis IS
          'Versioned local financial datasets; grant SELECT only to the isolated analysis executor role.';
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP VIEW vision_analysis.cash_flows_v1;
        DROP VIEW vision_analysis.holding_events_v1;
        DROP VIEW vision_analysis.accounts_v1;
        DROP VIEW vision_analysis.transactions_v1;
        DROP SCHEMA vision_analysis;
        """
    )
