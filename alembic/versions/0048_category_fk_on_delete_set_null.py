"""Explicit ON DELETE SET NULL for the soft category references.

Revision ID: 0048_category_fk_on_delete_set_null
Revises: 0047_one_primary_bank_account_per_recipient
Create Date: 2026-06-18

Three foreign keys to categories(id) were created inline with no ON DELETE
clause, so they default to NO ACTION (RESTRICT):
  - transactions.category_id
  - recipients.default_category_id
  - planned_transactions.category_id

`category_id` is a nullable, optional classification on all three tables, but
categoryRepository.hardDelete issues a bare DELETE with no pre-check — so
deleting an in-use category currently raises a raw 23503 that surfaces to the
client as a 500. This migration makes the references explicit ON DELETE SET
NULL: deleting a category now succeeds and un-categorizes the affected rows,
which matches the columns already being nullable.

DECISION / ALTERNATIVE: the other reasonable policy is to keep RESTRICT
explicitly and have the delete route translate 23503 into a 409 Conflict
("category in use"). That preserves the data but needs an app change. SET NULL
was chosen because the reference is optional by design and silently un-blocking
the delete is the less surprising behavior for an optional tag-like field.
Reviewer: if you prefer the protective RESTRICT+409 path, do not apply this
migration — handle 23503 in routes/categories.js instead.

NOTE: recipient/account FKs that protect history (e.g. transactions.recipient_id)
are deliberately left as RESTRICT — deleting a recipient that still has
transactions should remain blocked.

Blast radius: constraint swap only (drop + re-add FK), no row rewrite. The
constraint name is looked up dynamically so this works regardless of the
auto-generated name. Downgrade restores the constraint without ON DELETE.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0048_category_fk_on_delete_set_null"
down_revision: Union[str, Sequence[str], None] = (
    "0047_one_primary_bank_account_per_recipient"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, column, name to (re)create the constraint under)
_FKS = (
    ("transactions", "category_id", "transactions_category_id_fkey"),
    ("recipients", "default_category_id", "recipients_default_category_id_fkey"),
    ("planned_transactions", "category_id", "planned_transactions_category_id_fkey"),
)


def _drop_existing_category_fk(table: str, column: str) -> None:
    """Drop whatever FK currently backs (table.column) -> categories(id)."""
    op.execute(
        f"""
        DO $$
        DECLARE cname text;
        BEGIN
          SELECT con.conname INTO cname
            FROM pg_constraint con
           WHERE con.conrelid = '{table}'::regclass
             AND con.contype = 'f'
             AND con.confrelid = 'categories'::regclass
             AND con.conkey = ARRAY[
                   (SELECT attnum FROM pg_attribute
                     WHERE attrelid = '{table}'::regclass AND attname = '{column}')
                 ]::smallint[];
          IF cname IS NOT NULL THEN
            EXECUTE format('ALTER TABLE {table} DROP CONSTRAINT %I', cname);
          END IF;
        END $$;
        """
    )


def upgrade() -> None:
    for table, column, name in _FKS:
        _drop_existing_category_fk(table, column)
        op.execute(
            f"""
            ALTER TABLE {table}
                ADD CONSTRAINT {name}
                FOREIGN KEY ({column}) REFERENCES categories(id) ON DELETE SET NULL
            """
        )


def downgrade() -> None:
    for table, column, name in _FKS:
        _drop_existing_category_fk(table, column)
        op.execute(
            f"""
            ALTER TABLE {table}
                ADD CONSTRAINT {name}
                FOREIGN KEY ({column}) REFERENCES categories(id)
            """
        )
