"""Change transactions.date from timestamp to date

Revision ID: b3f9c9a9d6b2
Revises: a82e8e3148ec
Create Date: 2026-02-20 14:40:00.000000
"""
from typing import Union, Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b3f9c9a9d6b2'
down_revision: Union[str, Sequence[str], None] = 'a82e8e3148ec'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: change transactions.date -> DATE.

    This migration is dialect-aware:
    - For PostgreSQL it uses ALTER COLUMN ... TYPE date USING (date::date) to preserve time-to-date conversion.
    - For SQLite and other dialects, it uses the batch API which recreates the table as needed.
    """
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == 'postgresql':
        # Convert timestamp -> date preserving the date component
        op.alter_column(
            'transactions',
            'date',
            existing_type=sa.TIMESTAMP(),
            type_=sa.Date(),
            existing_nullable=False,
            postgresql_using='"date"::date'
        )
    else:
        # SQLite and other dialects: use batch_alter_table which will perform the copy/recreate sequence
        with op.batch_alter_table('transactions', schema=None) as batch_op:
            batch_op.alter_column(
                'date',
                existing_type=sa.DateTime(),
                type_=sa.Date(),
                existing_nullable=False
            )


def downgrade() -> None:
    """Downgrade schema: change transactions.date -> TIMESTAMP.

    Reverse of upgrade. For Postgres use USING to cast date->timestamp (midnight).
    For SQLite use batch_alter_table to recreate the table.
    """
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == 'postgresql':
        op.alter_column(
            'transactions',
            'date',
            existing_type=sa.Date(),
            type_=sa.TIMESTAMP(),
            existing_nullable=False,
            postgresql_using='"date"::timestamp'
        )
    else:
        with op.batch_alter_table('transactions', schema=None) as batch_op:
            batch_op.alter_column(
                'date',
                existing_type=sa.Date(),
                type_=sa.DateTime(),
                existing_nullable=False
            )
