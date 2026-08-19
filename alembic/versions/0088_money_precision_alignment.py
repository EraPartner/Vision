"""Align every sibling money column to NUMERIC(18,4), the domain precision (ADR-060 D7).

Revision ID: 0088_money_precision_alignment
Revises: 0087_flat_investments_conversion
Create Date: 2026-08-02

Migration 0025 retyped `transactions.amount` to NUMERIC(18,4) and stopped there, forking
money precision: every sibling money column stayed NUMERIC(15,2), so a 4-decimal
transaction could not be split exactly (splits round to cents), a planned→executed copy
gained precision headroom one way only, and statement/loan/raw-bank figures truncated to
cents on write. ADR-060's 2026-07-10 addendum (decision D7) settles it: **NUMERIC(18,4)
is the domain precision for money columns**, aligned in one revision. This is that
revision.

WHAT IT WIDENS — re-derived from the live schema at 0087 (information_schema), not the
2026-07-06 finding list; the two agree, and a flat 0087 install and a 0087-converted
legacy install carry the identical NUMERIC(15,2) inventory (verified against both):

    transactions.balance
    planned_transactions.amount / loan_principal / loan_regular_payment_amount
    planned_transaction_loan_schedule.payment_amount / principal_amount /
        interest_amount / remaining_principal
    transaction_splits.amount, split_payments.amount
    agg_split_outstanding.original_amount / paid_amount / outstanding_amount
    accounts.statement_balance
    the 8 raw-bank tables' money columns (amount/balance and their per-bank variants:
        kbc credit_amount/debit_amount, revolut fee, wise source/target/source_fee)

It also REPLACES `fn_agg_split_outstanding_sync` (0019): its plpgsql locals were declared
NUMERIC(15,2), which would keep rounding a 4-dp split amount to cents on its way into
agg_split_outstanding even after the columns widen. Same body, locals at NUMERIC(18,4).
The 0062 split-guard trigger (`enforce_split_within_amount`) needs no change — its local
is unconstrained `numeric` and its `> ABS(NEW.amount) + 0.005` tolerance remains valid
(a 4-dp split set summing exactly to a 4-dp parent passes with margin).

LEGACY OVERPAYMENT TRIGGER: databases that ran the pre-squash migration
`0028_split_audit_overpayment_guard` still carry
`trg_split_payment_overpayment_guard`. Fresh databases on the consolidated chain never
created it: payment serialization and the exact storage-precision cap live in
`splitRepository.addPayment` under `SELECT ... FOR UPDATE`. PostgreSQL records the
legacy trigger's `UPDATE OF amount` column dependency, so it refuses to retype
`split_payments.amount` while that trigger exists. Drop the trigger and its function
before the retype to converge upgraded databases on the canonical fresh-install shape.
The cleanup is intentionally retained on downgrade; restoring a legacy-only, cent-scale
guard would recreate schema drift and a weaker `+ 0.005` rule.

DELIBERATELY NOT TOUCHED:
  * `import_staging_rows.amount`/`balance` NUMERIC(20,4) — explicitly kept by the ADR
    ("wider than its commit target is harmless").
  * `investments` / `portfolio_transactions` / snapshot / watchlist columns — already at
    (18,4)/(18,6)/(18,8); the ADR addendum scopes D7 to the (15,2) transaction-ledger
    siblings and is silent on portfolio precision (residue: investments.cadastral_income
    (12,2), portfolio_snapshot_accounts.value and …snapshots.value_fx_neutral (18,2)).
  * Rate columns — loan_annual_interest_rate (8,4), wise exchange_rate (20,10),
    exchange_rates.rate_to_eur (20,10): rates, not money.
  * `legacy_inh_*` relations left by a 0087 conversion — frozen rollback copies, and all
    portfolio-shaped: none carries a (15,2) money column (verified on a converted
    install), so there is nothing to widen and freezing them keeps 0087's downgrade an
    exact restore.

MATERIALIZED VIEWS: PostgreSQL refuses to retype a column any view depends on, so the
three runtime MVs (mv_monthly_summary, mv_category_totals, mv_cashflow_daily — absent
from migrations since 0084/0085; created post-listen by materializedViewService) are
probed for a column-level dependency on the columns above and dropped (drop-only, the
0084/0085 pattern — the warmup rebuilds them off the boot path). Today none of their
definitions — current or historical — references any widened column (they aggregate
transactions.amount, which is already (18,4)), so the probe is expected to drop nothing;
it exists so a future definition that does bind one cannot brick this ALTER. Any OTHER
view depending on these columns is unknown to the app and cannot be rebuilt here, so the
ALTER is left to fail loudly rather than guess (refuse-loudly doctrine, 0087 precedent).

COST — honest correction to the ADR's "metadata-level retype, no data rewrite" claim:
that is only true when the display SCALE is unchanged. Verified on PostgreSQL 16.13:
(15,2)→(18,2) keeps the relfilenode (pure precision growth is a no-op relabel), but
(15,2)→(18,4) CHANGES the scale, fails numeric's no-rewrite test, and rewrites the table
and every index on it under ACCESS EXCLUSIVE. So this migration pays one full rewrite
per listed table — `transactions` is the big one (same cost shape 0025 already paid on
the same table, per the migration guide: "expect the rewrite and ANALYZE afterwards").
All columns of a table are widened in a single ALTER TABLE statement so each table is
rewritten exactly once, and each rewritten table is ANALYZEd here (the boot-window
ANALYZE in migrate.js only covers transactions/asset_price_history, and the docker
entrypoint path runs alembic directly without it).

ROLLBACK (downgrade): re-narrow with `USING round(col, 2)` per the ADR — lossy for
values that actually used the extra precision (the rollback path is destructive by
definition), and restore the (15,2)-local sync function verbatim from 0019. One
constraint interaction makes re-narrowing more than lossy: `chk_split_amount_positive`
/ `chk_split_payment_amount_positive` require amount > 0, so a SUB-CENT split or
payment (e.g. 0.0040 — legal at 18,4) rounds to 0.00 and would abort the downgrade
mid-ALTER with a raw check_violation. A pre-flight DO block therefore RAISEs first,
with a curated message listing the offending rows (0087 pre-flight style) so the
operator can merge/delete them; the database is left untouched at 0088.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0088_money_precision_alignment"
down_revision: Union[str, Sequence[str], None] = "0087_flat_investments_conversion"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Every NUMERIC(15,2) money column in the public schema at 0087 — the complete D7
# alignment inventory. All columns of a table sit in one entry so the table is
# rewritten once, whatever its column count.
MONEY_COLUMNS: "list[tuple[str, tuple[str, ...]]]" = [
    ("transactions", ("balance",)),
    (
        "planned_transactions",
        ("amount", "loan_principal", "loan_regular_payment_amount"),
    ),
    (
        "planned_transaction_loan_schedule",
        (
            "payment_amount",
            "principal_amount",
            "interest_amount",
            "remaining_principal",
        ),
    ),
    ("transaction_splits", ("amount",)),
    ("split_payments", ("amount",)),
    ("agg_split_outstanding", ("original_amount", "paid_amount", "outstanding_amount")),
    ("accounts", ("statement_balance",)),
    ("belfius_raw_transactions", ("amount", "balance")),
    ("custom_raw_transactions", ("amount", "balance")),
    ("kbc_raw_transactions", ("amount", "balance", "credit_amount", "debit_amount")),
    ("manual_raw_transactions", ("amount",)),
    ("revolut_raw_transactions", ("amount", "fee", "balance")),
    ("sabb_raw_transactions", ("amount",)),
    ("vision_raw_transactions", ("amount", "balance")),
    ("wise_raw_transactions", ("source_amount", "target_amount", "source_fee_amount")),
]

# The only MVs the app owns and will rebuild by itself (materializedViewService, post-listen
# warmup). Anything else that binds one of the columns is NOT dropped — the ALTER fails
# loudly instead, because nothing here could recreate an object it does not know.
RUNTIME_MVS = ("mv_monthly_summary", "mv_category_totals", "mv_cashflow_daily")


def _drop_runtime_mvs_bound_to_money_columns(conn) -> None:
    """Drop any of the three runtime MVs with a column-level dependency on a widened column.

    Dependencies of a view body live on its pg_rewrite rule (not the view relation), with
    refobjsubid pointing at the referenced column — so this only fires for an MV that
    truly binds one of the columns being retyped, never for the (expected) case where the
    MVs aggregate only transactions.amount.
    """
    mv_list = ", ".join(f"'{name}'" for name in RUNTIME_MVS)
    col_list = ", ".join(f"'{t}.{c}'" for t, cols in MONEY_COLUMNS for c in cols)
    rows = conn.execute(
        sa.text(
            f"""
            SELECT DISTINCT mv.relname
            FROM pg_rewrite rw
            JOIN pg_class mv ON mv.oid = rw.ev_class AND mv.relkind = 'm'
            JOIN pg_namespace n ON n.oid = mv.relnamespace AND n.nspname = 'public'
            JOIN pg_depend dep ON dep.classid = 'pg_rewrite'::regclass
                              AND dep.objid = rw.oid
                              AND dep.refclassid = 'pg_class'::regclass
                              AND dep.refobjsubid > 0
            JOIN pg_class src ON src.oid = dep.refobjid
            JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = dep.refobjsubid
            WHERE mv.relname IN ({mv_list})
              AND src.relname || '.' || a.attname IN ({col_list})
            """
        )
    )
    for (name,) in rows:
        # destructive-ok: derived data only — materializedViewService.createMaterializedViews
        # recreates and populates any missing runtime MV from the post-listen warmup on the
        # same boot (0084/0085 precedent); dropped here only when it blocks the retype.
        conn.execute(sa.text(f"DROP MATERIALIZED VIEW IF EXISTS {name} CASCADE"))


# fn_agg_split_outstanding_sync with its locals at the (18,4) domain precision. Body is
# otherwise verbatim from 0019 — (15,2) locals would silently round a 4-dp split back to
# cents inside the trigger path even after the columns widen.
_AGG_SYNC_FN_18_4 = """
    CREATE OR REPLACE FUNCTION fn_agg_split_outstanding_sync(p_split_id INTEGER)
    RETURNS void AS $$
    DECLARE
        v_recipient_id INTEGER;
        v_original NUMERIC(18, 4);
        v_paid NUMERIC(18, 4);
    BEGIN
        SELECT s.recipient_id, s.amount
        INTO v_recipient_id, v_original
        FROM transaction_splits s
        WHERE s.id = p_split_id;

        IF v_recipient_id IS NULL THEN
            DELETE FROM agg_split_outstanding WHERE split_id = p_split_id;
            RETURN;
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM split_payments
        WHERE split_id = p_split_id;

        INSERT INTO agg_split_outstanding (
            split_id, recipient_id, original_amount, paid_amount,
            outstanding_amount, updated_at
        ) VALUES (
            p_split_id, v_recipient_id, v_original, v_paid,
            v_original - v_paid, NOW()
        )
        ON CONFLICT (split_id) DO UPDATE
        SET recipient_id = EXCLUDED.recipient_id,
            original_amount = EXCLUDED.original_amount,
            paid_amount = EXCLUDED.paid_amount,
            outstanding_amount = EXCLUDED.outstanding_amount,
            updated_at = NOW();
    END;
    $$ LANGUAGE plpgsql;
"""

# The pre-D7 aggregate function, restored verbatim (0019) on downgrade, (15,2) locals
# included. The separate legacy overpayment guard is intentionally not restored; see the
# migration docstring.
_AGG_SYNC_FN_15_2 = _AGG_SYNC_FN_18_4.replace("NUMERIC(18, 4)", "NUMERIC(15, 2)")


def _drop_legacy_overpayment_guard(conn) -> None:
    """Remove the pre-squash trigger that blocks retyping split_payments.amount.

    The consolidated migration chain never creates this object. Keeping the cleanup
    idempotent makes both a converted legacy database and a fresh database safe, while
    avoiding CASCADE so any unexpected third-party dependency still fails loudly.
    """
    # destructive-ok: ADR-112 retires this legacy-only trigger; the consolidated chain
    # never creates it and splitRepository.addPayment already owns the locked exact cap.
    conn.execute(
        sa.text(
            "DROP TRIGGER IF EXISTS trg_split_payment_overpayment_guard ON split_payments"
        )
    )
    # destructive-ok: ADR-112 removes the now-unreferenced legacy function after its
    # sole trigger; no CASCADE is used, so an unexpected dependency still blocks safely.
    conn.execute(
        sa.text("DROP FUNCTION IF EXISTS fn_split_payment_overpayment_guard()")
    )


def upgrade() -> None:
    conn = op.get_bind()
    _drop_legacy_overpayment_guard(conn)
    _drop_runtime_mvs_bound_to_money_columns(conn)
    for table, columns in MONEY_COLUMNS:
        # destructive-ok: pure WIDENING, NUMERIC(15,2) -> NUMERIC(18,4) per the ADR-060 D7
        # addendum (2026-07-10: 18,4 is the domain precision) — both precision and scale
        # grow, so no existing value can be truncated; narrowing lives in downgrade() only.
        clauses = ", ".join(
            f"ALTER COLUMN {col} TYPE NUMERIC(18, 4)" for col in columns
        )
        conn.execute(sa.text(f"ALTER TABLE {table} {clauses}"))
    conn.execute(sa.text(_AGG_SYNC_FN_18_4))
    # The scale change rewrote each table in full (see docstring) — refresh planner stats
    # here: the migrate.js post-upgrade ANALYZE covers only transactions, and the docker
    # entrypoint runs alembic without it.
    for table, _ in MONEY_COLUMNS:
        conn.execute(sa.text(f"ANALYZE {table}"))


def downgrade() -> None:
    conn = op.get_bind()
    # Pre-flight (0087 style): a sub-cent split/payment amount is legal at the
    # (18,4) domain precision but rounds to 0.00 under this downgrade's
    # USING round(col, 2), violating chk_split_amount_positive /
    # chk_split_payment_amount_positive and aborting mid-ALTER with a raw
    # driver error. Refuse loudly BEFORE any DDL, listing the offending rows,
    # so the database stays untouched at 0088 and the operator knows exactly
    # what to merge or delete.
    conn.execute(
        sa.text(
            """
            DO $$
            DECLARE
                offending text;
                n bigint;
            BEGIN
                CREATE TEMP TABLE _0088_subcent ON COMMIT DROP AS
                    SELECT 'transaction_splits' AS src, id, amount
                      FROM transaction_splits
                     WHERE amount > 0 AND round(amount, 2) = 0
                    UNION ALL
                    SELECT 'split_payments', id, amount
                      FROM split_payments
                     WHERE amount > 0 AND round(amount, 2) = 0;

                SELECT count(*) INTO n FROM _0088_subcent;
                IF n > 0 THEN
                    SELECT string_agg(src || ' id=' || id || ' amount=' || amount, '; '
                                      ORDER BY src, id)
                      INTO offending
                      FROM (SELECT * FROM _0088_subcent ORDER BY src, id LIMIT 20) capped;
                    RAISE EXCEPTION USING
                        ERRCODE = 'check_violation',
                        MESSAGE = format(
                            '0088 downgrade refused: %s sub-cent split/payment row(s) would round '
                            'to 0.00 under NUMERIC(15,2) and violate the positive-amount checks. '
                            'Merge or delete these rows, then retry (first 20 listed): %s',
                            n, offending);
                END IF;
            END
            $$;
            """
        )
    )
    # A manually restored legacy trigger has the same column dependency and
    # cent-scale semantics. Keep the canonical no-trigger shape on downgrade too.
    _drop_legacy_overpayment_guard(conn)
    _drop_runtime_mvs_bound_to_money_columns(conn)
    for table, columns in MONEY_COLUMNS:
        # Re-narrow per the ADR's rollback clause: round(col, 2) — lossy exactly for the
        # values that used the 4-dp headroom. Explicit USING because the assignment cast
        # would raise on such values instead of rounding them.
        clauses = ", ".join(
            f"ALTER COLUMN {col} TYPE NUMERIC(15, 2) USING round({col}, 2)"
            for col in columns
        )
        conn.execute(sa.text(f"ALTER TABLE {table} {clauses}"))
    conn.execute(sa.text(_AGG_SYNC_FN_15_2))
    for table, _ in MONEY_COLUMNS:
        conn.execute(sa.text(f"ANALYZE {table}"))
