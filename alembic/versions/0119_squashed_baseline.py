"""Bridge the maintained schema to the reviewed fresh-install baseline.

Revision ID: 0119_squashed_baseline
Revises: 0118_audit_retention_pruner

This revision rewrites no data and creates no objects. The fresh installer
loads alembic/baseline/0119_fresh.sql into an empty database. Existing installs
reach this revision through the historical graph, but only after the guarded
manual contracts have produced the exact reviewed PostgreSQL 18 schema.

Rollback is a no-DDL downgrade to 0118. Historical migrations remain present;
older data-bearing contract steps require their documented backup/restore path.
Never apply this revision to user data without an approved maintenance window.
"""

from pathlib import Path
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0119_squashed_baseline"
down_revision: Union[str, Sequence[str], None] = "0118_audit_retention_pruner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# PostgreSQL 18 normalizes one equivalent CHECK expression after the baseline
# dump is restored. Accept only the two observed catalog shapes, not arbitrary
# databases that happen to carry the 0118 version marker.
MAINTAINED_SCHEMA = "9e634493345024873f8dce83c2fc142d46cf090becf6e519ac56d492a20ea146"
RESTORED_BASELINE_SCHEMA = (
    "8508bf6f1c047ff28ea0eaa3e0381580c7c4e5ea94d5f772b0e4e5a2bd6cbc10"
)
FINGERPRINT_SQL = (
    Path(__file__).resolve().parents[1] / "baseline" / "schema_fingerprint.sql"
)


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        raise RuntimeError("The squashed baseline bridge requires PostgreSQL")
    actual = connection.execute(text(FINGERPRINT_SQL.read_text())).scalar_one()
    if actual not in {MAINTAINED_SCHEMA, RESTORED_BASELINE_SCHEMA}:
        raise RuntimeError(
            "Schema differs from the reviewed baseline. Stop writers, restore-test "
            "a fresh backup, complete the guarded manual contracts, and use "
            "the explicit bridge procedure. No revision or data was changed."
        )


def downgrade() -> None:
    # This revision has no DDL or data rewrite. Alembic's audit hook records
    # the version change in the existing append-only chain.
    pass
