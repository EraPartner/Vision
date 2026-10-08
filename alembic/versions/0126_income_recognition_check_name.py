"""Rename the income-recognition CHECK to the chk_ constraint prefix.

Blast radius: metadata-only rename of one CHECK constraint on
portfolio_transactions. No row is read or rewritten; downgrade restores the
0124 name.
"""
from alembic import op

revision = "0126_income_recognition_check_name"
down_revision = "0125_brokerage_cash_origin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE portfolio_transactions RENAME CONSTRAINT ck_portfolio_income_recognition_role
        TO chk_portfolio_income_recognition_role;
    """)


def downgrade() -> None:
    op.execute("""
      ALTER TABLE portfolio_transactions RENAME CONSTRAINT chk_portfolio_income_recognition_role
        TO ck_portfolio_income_recognition_role;
    """)
