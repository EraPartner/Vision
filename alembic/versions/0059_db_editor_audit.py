"""Audit log for the admin DB data-editor (raw table view/edit feature).

Revision ID: 0059_db_editor_audit
Revises: 0058_watchlist_added_price
Create Date: 2026-06-18

The admin DB Maintenance UI gains a JetBrains-style table editor: browse, filter, sort and
edit/insert/delete rows with changes committed straight to Postgres. Because those writes bypass
the app's domain logic, every committed statement is recorded here for traceability — alongside a
structured-logger line emitted by the backend (services/dbEditor.js).

One row per committed change: which table, which operation, the row's primary key, the before- and
after-images, and the SQL that ran. Written inside the same transaction as the change, so the audit
trail is atomic with the mutation.

Blast radius: one brand-new table + one index. No existing table is touched and no data migrates.
Downgrade drops the table (discarding accumulated audit history, which is acceptable — it is a log).

NOTE: migrations are not auto-run by the agent — authored here; the user applies it with
`bun run db:upgrade`.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0059_db_editor_audit"
down_revision: Union[str, Sequence[str], None] = "0058_watchlist_added_price"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS db_editor_audit (
            id          BIGSERIAL PRIMARY KEY,
            table_name  TEXT        NOT NULL,
            op          TEXT        NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
            pk_json     JSONB,
            before_json JSONB,
            after_json  JSONB,
            statement   TEXT        NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS db_editor_audit_table_time_idx
            ON db_editor_audit (table_name, created_at DESC);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS db_editor_audit;")
