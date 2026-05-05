"""Fix attachments.transaction_id type mismatch: BIGINT → INTEGER

Revision ID: 0027_fix_attachments_bigint
Revises: 0026_asset_price_history_fk
Create Date: 2026-05-05

attachments.transaction_id was declared BIGINT but transactions.id is SERIAL
(int4 / INTEGER). The type mismatch forces implicit casts on every join and
prevents Postgres from using some index strategies. Corrects to INTEGER to
match the referenced column type.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0027_fix_attachments_bigint'
down_revision: Union[str, Sequence[str], None] = '0026_asset_price_history_fk'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_transaction_id_fkey"
    ))
    op.execute(sa.text(
        "ALTER TABLE attachments "
        "ALTER COLUMN transaction_id TYPE INTEGER USING transaction_id::INTEGER"
    ))
    op.execute(sa.text("""
        ALTER TABLE attachments
            ADD CONSTRAINT attachments_transaction_id_fkey
            FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    """))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_transaction_id_fkey"
    ))
    op.execute(sa.text(
        "ALTER TABLE attachments ALTER COLUMN transaction_id TYPE BIGINT"
    ))
    op.execute(sa.text("""
        ALTER TABLE attachments
            ADD CONSTRAINT attachments_transaction_id_fkey
            FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    """))
