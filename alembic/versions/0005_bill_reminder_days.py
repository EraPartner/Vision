"""Add reminder_days_before to planned_transactions

Revision ID: 0005_bill_reminder_days
Revises: 0004_attachments
Create Date: 2026-04-24

Adds an optional reminder window (in days before the planned date) so the
due-soon endpoint can filter bills that need attention.
"""

from alembic import op
import sqlalchemy as sa

revision = '0005_bill_reminder_days'
down_revision = '0004_attachments'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'planned_transactions',
        sa.Column(
            'reminder_days_before',
            sa.Integer(),
            nullable=True,
            server_default=None,
            comment='Days before planned_date to surface as a reminder. NULL = no reminder.',
        ),
    )


def downgrade():
    op.drop_column('planned_transactions', 'reminder_days_before')
