"""Planned execution idempotency — Phase 3 of the non-portfolio refactor.

Revision ID: 0027_planned_execution_idempotency
Revises: 0026_finance_aggregations
Create Date: 2026-04-16

Adds a UNIQUE constraint on planned_transaction_executions over
(planned_transaction_id, executed_transaction_id). The backend execute
endpoint performs two writes (insert execution row + update parent planned
transaction). Without the unique constraint a double-click races the
endpoint and produces duplicate execution rows pointing at the same
transaction.

The constraint lets repositoryPlannedTransactionExecute wrap the two
writes in a single transaction and rely on Postgres error 23505 as the
idempotency signal — second attempt returns the existing row instead of
creating a new one.

Data safety: existing duplicate pairs (if any) are de-duplicated before
the constraint is added. The older row (smallest id) is kept; newer
duplicates are deleted. This is additive from a schema perspective: the
unique index only rejects future duplicates, so rollback is safe.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0027_planned_execution_idempotency'
down_revision: Union[str, Sequence[str], None] = '0026_finance_aggregations'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # De-dup any pre-existing (planned_transaction_id, executed_transaction_id)
    # pairs before creating the unique index. Keep the oldest row per pair.
    op.execute("""
        DELETE FROM planned_transaction_executions a
        USING planned_transaction_executions b
        WHERE a.planned_transaction_id = b.planned_transaction_id
          AND a.executed_transaction_id = b.executed_transaction_id
          AND a.id > b.id;
    """)

    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_pte_planned_executed
            ON planned_transaction_executions (planned_transaction_id, executed_transaction_id);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uniq_pte_planned_executed;")
