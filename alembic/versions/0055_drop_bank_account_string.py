"""Contract phase (NEUTRALIZED — see ADR-088): the bank_account drop must NOT live in the
auto-applied chain.

Revision ID: 0055_drop_bank_account_string
Revises: 0054_account_statement_balance
Create Date: 2026-06-18

This migration ORIGINALLY dropped `transactions.bank_account` / `planned_transactions.bank_account`
+ the dual-write trigger + mv_bank_balances. That was a mistake: the app runs `alembic upgrade
head` on boot, so a "gated, apply-after-soak" migration in the chain is applied immediately,
without the coupled code — which dropped the column out from under the running app and crashed
startup (mv_bank_balances + every bank_account read).

It is now a NO-OP so fresh databases never drop the column. The contract-phase drop is deferred to
a deliberate, OUT-OF-BAND step (run manually, in lockstep with the coupled read/write code +
mv_bank_balances redefinition, after a real dual-write soak), NOT an auto-applied chain migration.
Recovery for any database that already applied the destructive version is `0056` (re-adds
bank_account + the dual-write trigger).
"""

from typing import Sequence, Union


revision: str = "0055_drop_bank_account_string"
down_revision: Union[str, Sequence[str], None] = "0054_account_statement_balance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Intentionally a no-op. The bank_account drop is deferred out of the auto-applied chain.
    pass


def downgrade() -> None:
    pass
