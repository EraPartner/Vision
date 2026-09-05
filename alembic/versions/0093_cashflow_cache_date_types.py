"""Use DATE keys for cash-flow forecast persistence.

Revision ID: 0093_cashflow_cache_date_types
Revises: 0092_updated_at_policy
Create Date: 2026-09-04

The three forecast tables used lexically sortable TEXT date keys. Valid keys
are converted to DATE; malformed cache/history rows are removed first because
they cannot be interpreted and all three tables are regenerable.

``user_id`` remains deliberately. Although Vision is deployed as a single-user
application today, it is a live cache partition used by repository queries and
the nightly pre-warm job. Removing it would collapse distinct logical cache
namespaces for no runtime benefit.

Blast radius: forecast cache/backtest keys and invalid cached rows only.
Downgrade formats the DATE values back to their original YYYY-MM or YYYY-MM-DD
text contracts; deleted invalid rows cannot be reconstructed.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0093_cashflow_cache_date_types"
down_revision: Union[str, Sequence[str], None] = "0092_updated_at_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM cashflow_forecast_accuracy
         WHERE as_of_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
            OR NOT pg_input_is_valid(as_of_month || '-01', 'date');
        -- destructive-ok: ADR-120 converts a validated YYYY-MM cache/history key to DATE;
        -- malformed regenerable rows are removed immediately above and repository code ships together.
        ALTER TABLE cashflow_forecast_accuracy
          ALTER COLUMN as_of_month TYPE DATE
          USING ((as_of_month || '-01')::date);

        DELETE FROM cashflow_forecast_mc
         WHERE month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
            OR NOT pg_input_is_valid(month || '-01', 'date');
        -- destructive-ok: ADR-120 converts a validated YYYY-MM regenerable cache key to DATE;
        -- the repository uses the DATE boundary in the same change.
        ALTER TABLE cashflow_forecast_mc
          ALTER COLUMN month TYPE DATE
          USING ((month || '-01')::date);

        DELETE FROM cashflow_forecast_mc_rolling
         WHERE NOT pg_input_is_valid(today_iso, 'date');
        -- destructive-ok: ADR-120 converts a validated YYYY-MM-DD regenerable cache key to DATE;
        -- the repository uses the DATE boundary in the same change.
        ALTER TABLE cashflow_forecast_mc_rolling
          ALTER COLUMN today_iso TYPE DATE
          USING (today_iso::date);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE cashflow_forecast_mc_rolling
          ALTER COLUMN today_iso TYPE TEXT
          USING (to_char(today_iso, 'YYYY-MM-DD'));
        ALTER TABLE cashflow_forecast_mc
          ALTER COLUMN month TYPE TEXT
          USING (to_char(month, 'YYYY-MM'));
        ALTER TABLE cashflow_forecast_accuracy
          ALTER COLUMN as_of_month TYPE TEXT
          USING (to_char(as_of_month, 'YYYY-MM'));
        """
    )
