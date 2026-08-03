"""Named CHECKs for the four free-text enum columns (TEXT + named CHECK rule).

Revision ID: 0089_free_text_enum_checks
Revises: 0088_money_precision_alignment
Create Date: 2026-08-03

Enum discipline in this schema was three-tier with no written rule: PG native
enums (9), TEXT + CHECK (~14), and free text validated only in app code. This
revision adopts the written rule — **TEXT + a named `chk_*` CHECK for every new
enum-like column** (PG enums need ALTER TYPE ceremony, cannot drop values, and
already carry dead values — see `revolut_state`, 3 of whose 5 values the adapter
drops before insert) — and closes the four columns that had NO database-side
vocabulary at all. The rule itself is documented in
docs/reference/code-patterns.md ("Database Naming & Enum Discipline").

The four CHECK families, value sets re-derived from the CURRENT write paths
(not the 2026-07-06 finding inventory):

1. `planned_transactions.recurrence_pattern` —
   `chk_planned_transactions_recurrence_pattern`. Mirrors the app validator
   (`src/lib/calculations/recurrence.js`): the six SUPPORTED_PATTERNS
   ('daily','weekly','biweekly','monthly','quarterly','yearly') plus the custom
   grammar "every N days?" with N >= 1. The route stores the client's raw
   string and validates with lowercase+trim (`isValidPattern`), so the CHECK
   compares `lower(btrim(...))` — exactly the values the calculator can
   advance. NULL allowed (non-recurring rows).
   NOTE the spelling: 'biweekly', NOT the `recurrence_interval` PG enum's
   'bi-weekly'. Those are the two forked vocabularies; this CHECK canonicalises
   the app-side one. The enum (used by portfolio_transactions) keeps its
   spelling — converting existing PG enums is explicitly out of scope.

2. `portfolio_import_staging_rows.match_source` —
   `chk_portfolio_import_staging_rows_match_source`. The only writer is
   `portfolioImportPipeline/matchInvestments.js`, which has only ever emitted
   'symbol' | 'name_exact' (verified across git history); NULL = unresolved.
   Brings the column to parity with its sibling
   `import_staging_rows.match_source` (CHECKed since 0015).

3. `portfolio_import_staging_rows.route` —
   `chk_portfolio_import_staging_rows_route`. 0060 (ADR-095) documents and
   `portfolioImportPipeline/validate.js` writes 'cash' | 'portfolio'; NULL for
   non-brokerage batches.

4. `transaction_raw_references.raw_source_type` —
   `chk_transaction_raw_references_raw_source_type`. The value names which
   `<type>_raw_transactions` table `raw_source_id` points into, so the valid
   set is the eight raw-bank tables that exist at this head: 'belfius',
   'custom', 'kbc', 'manual', 'revolut', 'sabb', 'vision', 'wise'. (The
   adapter registry additionally knows ing/bnp/generic, but those have no raw
   table — a reference to them would dangle, so they are deliberately NOT in
   the CHECK. Column is NOT NULL, so no NULL arm.)

Rollout follows the 0046/0049 precedent: each CHECK is added NOT VALID (new and
updated rows enforced immediately), then VALIDATEd tolerantly inside a
DO-block that catches check_violation. A long-lived install holding a value
outside the derived set (e.g. a 'fortnightly' recurrence typo that predates
`isValidPattern`, or a raw reference from a since-removed source) must not be
bricked at boot — migrations run fail-fast — so on violation the constraint
simply stays NOT VALID and a WARNING logs the audit + manual-VALIDATE recipe.

One data normalisation, 0049-style (rows that BECOME valid): recurrence
patterns spelled 'bi-weekly' are rewritten to 'biweekly'. The frontend mapper
already displays 'bi-weekly' as biweekly (plannedPaymentMapper.ts, "DB-enum
compat spelling") but `calculateNextDate` returns null for it — such a row is
shown as biweekly yet never advances. The rewrite makes storage match both the
display and the calculator. Idempotent; a no-op on clean databases.

Both install shapes verified: fresh (0001→head) and ADR-109 converted-legacy
carry identical shapes for all four columns; the `legacy_inh_*` frozen rollback
relations are untouched.

Rollback = drop the four constraints (the normalisation is intentionally kept,
exactly like 0049 kept its currency normalisation).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0089_free_text_enum_checks"
down_revision: Union[str, Sequence[str], None] = "0088_money_precision_alignment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, constraint name, CHECK expression, audit column) — the single source
# of truth; tests mirror this list literally so drift fails the suite.
_CHECKS = (
    (
        "planned_transactions",
        "chk_planned_transactions_recurrence_pattern",
        "recurrence_pattern IS NULL"
        " OR lower(btrim(recurrence_pattern)) IN"
        " ('daily','weekly','biweekly','monthly','quarterly','yearly')"
        " OR lower(btrim(recurrence_pattern)) ~"
        " '^every[[:space:]]+0*[1-9][0-9]*[[:space:]]+days?$'",
        "recurrence_pattern",
    ),
    (
        "portfolio_import_staging_rows",
        "chk_portfolio_import_staging_rows_match_source",
        "match_source IS NULL OR match_source IN ('symbol','name_exact')",
        "match_source",
    ),
    (
        "portfolio_import_staging_rows",
        "chk_portfolio_import_staging_rows_route",
        "route IS NULL OR route IN ('cash','portfolio')",
        "route",
    ),
    (
        "transaction_raw_references",
        "chk_transaction_raw_references_raw_source_type",
        "raw_source_type IN"
        " ('belfius','custom','kbc','manual','revolut','sabb','vision','wise')",
        "raw_source_type",
    ),
)


def upgrade() -> None:
    # Normalise the forked spelling before validating: 'bi-weekly' rows display
    # as biweekly in the frontend but never advance in the calculator. Rows
    # that become valid are fixed; anything else is left for the audit query.
    op.execute(
        """
        UPDATE planned_transactions
           SET recurrence_pattern = 'biweekly'
         WHERE lower(btrim(recurrence_pattern)) = 'bi-weekly'
        """
    )

    for table, constraint, expression, column in _CHECKS:
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {constraint}")
        op.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {constraint}"
            f" CHECK ({expression}) NOT VALID"
        )
        # Tolerant VALIDATE (0049 precedent): a long-lived install with legacy
        # out-of-vocabulary rows keeps booting; the constraint stays NOT VALID
        # (still enforced for new/updated rows) and the WARNING carries the
        # cleanup recipe. The expression's own quotes must be doubled to sit
        # inside the RAISE WARNING string literal.
        audit_expr = expression.replace("'", "''")
        op.execute(
            f"""
            DO $$
            BEGIN
                ALTER TABLE {table} VALIDATE CONSTRAINT {constraint};
            EXCEPTION WHEN check_violation THEN
                RAISE WARNING 'Vision migration 0089: could not VALIDATE {constraint} because {table}.{column} holds values outside the app vocabulary. The constraint remains NOT VALID; new and updated rows are still enforced. Audit with: SELECT id, {column} FROM {table} WHERE NOT ({audit_expr}); fix those rows, then run: ALTER TABLE {table} VALIDATE CONSTRAINT {constraint};';
            END;
            $$;
            """
        )


def downgrade() -> None:
    for table, constraint, _expression, _column in reversed(_CHECKS):
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {constraint}")
