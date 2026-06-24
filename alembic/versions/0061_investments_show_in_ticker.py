"""Per-investment opt-out for the portfolio price ticker (side table).

Revision ID: 0061_investments_show_in_ticker
Revises: 0060_brokerage_import_routing
Create Date: 2026-06-24

The portfolio overview's Wall-Street-style price ticker shows every market-priced holding by
default; this lets a holding be excluded from that tape (managed from the ticker's own "manage"
popover) without affecting any other view or calculation.

This deliberately stores the preference in a SIDE TABLE keyed by investment id rather than a column
on `investments`. `investments` is a plain table on fresh installs (ADR-squashed 0001 schema) but a
VIEW over `investments_base` + per-class child tables on installs carried through the legacy
inheritance schema (legacy 0013). You cannot ALTER ... ADD COLUMN a view, and surfacing a new base
column through the view requires fragile, hard-to-reverse view surgery (the view also carries an
INSTEAD OF update trigger). A side table sidesteps all of that: the migration is a trivial
CREATE/DROP TABLE that is identical and reversible on both schema shapes. The repository LEFT JOINs
it (COALESCE default true) on read and UPSERTs it on the existing PATCH /api/investments/:id path.

  - investment_ticker_prefs.investment_id — one row per holding that has an explicit preference.
  - investment_ticker_prefs.show_in_ticker — FALSE hides the holding from the tape. Absent row =
    TRUE (the default), so every existing holding keeps showing with no backfill.

Blast radius: one new table; no change to investments / investments_base / the inheritance view; no
data migration. No FK (cannot reference a view; an orphaned pref row is harmless — it simply never
joins). Downgrade drops the table.

NOTE: migrations are not auto-run by the agent — authored here; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0061_investments_show_in_ticker"
down_revision: Union[str, Sequence[str], None] = "0060_brokerage_import_routing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS investment_ticker_prefs (
            investment_id  INTEGER PRIMARY KEY,
            show_in_ticker BOOLEAN NOT NULL DEFAULT true
        );
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS investment_ticker_prefs;")
