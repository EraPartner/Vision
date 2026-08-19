"""One-time conversion of legacy table-inheritance installs to the flat investments schema (ADR-109).

Revision ID: 0087_flat_investments_conversion
Revises: 0086_portfolio_transactions_import_batch_id
Create Date: 2026-08-02

Fresh installs have had flat `investments` / `portfolio_transactions` tables since the 0001
baseline. Installs carried through the legacy chain still run the ADR-004 table-inheritance
shape: `investments_base` + 7 asset-class child tables behind an `investments` JOIN view (with
an INSTEAD OF UPDATE trigger), and `portfolio_transactions_base` + 7 child tables behind a
`portfolio_transactions` JOIN view. ADR-109 decided the flat shape is the single canonical
schema; this revision is the guarded one-time conversion it specifies.

WHAT IT DOES (legacy installs only — a strict no-op when `investments_base` is absent):

  1. Shape sanity pre-flight: every expected legacy relation (both base tables, all 14 child
     tables, both views) and every load-bearing column (0016 fx_rate_to_eur, 0017 provider
     columns, 0052 account_id, 0086 import_batch_id) must be present, else RAISE — this
     migration converts exactly the shape the migration chain guarantees at 0086 and refuses
     to guess at anything else. A DATA pre-flight follows, turning the legacy states that
     would otherwise abort mid-copy with a raw driver error into curated, actionable RAISEs
     that list the offending rows: crypto symbols longer than the canonical VARCHAR(20), ids
     present in more than one inheritance child table, and base-only rows with no child (no
     asset_class). Every RAISE fires before any conversion work — the database stays at 0086
     with the legacy view working, and the app will not boot until the listed rows are fixed
     (the deliberate trade: refuse loudly rather than guess or truncate).
  2. `ALTER TYPE asset_class ADD VALUE IF NOT EXISTS 'metals'` inside an autocommit block.
     The legacy enum (legacy 0004) never gained 'metals' — the legacy view emits asset_class
     as TEXT so the app never noticed — but the flat table's enum column needs the value, and
     PostgreSQL refuses to use an enum value added in the same transaction. The statement is
     idempotent; everything after it runs in one transaction (all-or-nothing).
  3. Builds `investments_flat` / `portfolio_transactions_flat` with column definitions matching
     0001's flat DDL exactly (plus the flat-path columns later revisions appended: account_id
     from 0052, import_batch_id from 0086), and copies every investment plus every transaction
     whose investment still exists. The legacy hard-delete path removed an investment through
     `investments_base`, but the child transaction tables had no enforceable foreign key and
     therefore kept invisible orphan transactions. The canonical FK uses ON DELETE CASCADE, so
     the conversion completes that intended cascade while warning with the omitted transaction
     ids. The rows remain in the renamed legacy tables for rollback. Investments are copied
     from the base + child JOIN rather than the view because the legacy view never exposed
     `bond_investments.interest_rate` (0017 kept `savi.interest_rate` only) — copying the join
     preserves those values instead of silently dropping them.
  4. Parity pre-flight (ADR-109 §6): row counts and an order-independent hash over id + money
     columns must match between the investments view and its flat copy, and between the valid
     transaction subset and its flat copy, else RAISE (aborting the whole conversion transaction
     — the database is left untouched on the legacy shape).
  5. Swap: canonical index/constraint names still occupied by legacy relations (e.g.
     `investments_pkey` on the pre-0013 `investments_legacy` snapshot) are renamed aside with a
     `legacy_inh_` prefix; the views and inheritance tables are renamed aside the same way; the
     flat copies take the canonical names. Nothing is dropped — the renamed relations ARE the
     rollback (see downgrade). The INSTEAD OF trigger and the `*_investments_full` helper views
     follow their renamed relations automatically (dependencies are by OID).
  6. Recreates the 0001-name triggers, indexes and constraints on the converted tables —
     including the FKs the view shape could never hold: portfolio_transactions.investment_id
     (0001), account_id (0052), import_batch_id (0086), asset_price_history.investment_id
     (0026, with the same orphan-row cleanup 0026 performs on flat installs), and the
     portfolio_import_staging_rows investment FKs (0040, dangling matches nulled — staging
     rows are transient and had no referential integrity on legacy installs).
  7. Resyncs the id sequences to GREATEST(the legacy sequence's next value, MAX(id)+1) — so a
     legacy sequence that ran ahead of the surviving rows never re-issues previously-used ids
     (stale FK-less references like investment_ticker_prefs rows could otherwise attach to a
     reused id) — and ANALYZEs both rewritten tables (per the migration guide — the
     boot-window ANALYZE only covers transactions/asset_price_history).

No materialized view references investments or portfolio_transactions (mv_monthly_summary,
mv_category_totals and mv_cashflow_daily are all transactions-based), so there is nothing to
refresh.

COST: O(investments + portfolio_transactions) copy, once, on legacy installs only — the
data-copying migration ADR-109 accepts as its cost. Both tables are user-portfolio-scale
(thousands of rows, not the millions-scale transactions/asset_price_history tables the
migration guide's batching shapes exist for). Flat installs pay two to_regclass() probes.

ROLLBACK (downgrade): reverse the renames. The converted flat tables are dropped (rows written
after the conversion are lost — the rollback path is destructive by definition), the legacy
views/tables get their canonical names back, including any orphan transactions omitted from the
flat copy, and any index/constraint renamed aside in step 5 gets its original name back. On
installs that were never converted (fresh/flat) downgrade is a no-op.

After this revision every install is on the flat shape before the backend starts listening
(docker-entrypoint.sh / main.js run `alembic upgrade head` ahead of app.listen), so the
runtime `to_regclass` shape-probing and inheritance-aware branching are removed from the
backend in the same release — see ADR-109 "After conversion ships".
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0087_flat_investments_conversion"
down_revision: Union[str, Sequence[str], None] = (
    "0086_portfolio_transactions_import_batch_id"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Legacy relations that must all be present (with the views view-kinded) for the conversion to
# run. Anything else is an unknown hybrid and aborts.
_LEGACY_TABLES = [
    "investments_base",
    "stock_investments",
    "etf_investments",
    "crypto_investments",
    "metals_investments",
    "real_estate_investments",
    "savings_investments",
    "bond_investments",
    "portfolio_transactions_base",
    "stock_transactions",
    "etf_transactions",
    "crypto_transactions",
    "metals_transactions",
    "real_estate_transactions",
    "savings_transactions",
    "bond_transactions",
]

# Canonical relation-namespace names (PK indexes + indexes) the converted tables must own.
# On legacy installs some are already taken by the pre-0013 `investments_legacy` /
# `portfolio_transactions_legacy` snapshots (a table rename keeps its index names), so the
# swap renames any holder aside with this prefix; downgrade renames them back.
_ASIDE_PREFIX = "legacy_inh_"
_CANONICAL_RELATION_NAMES = [
    "investments_pkey",
    "portfolio_transactions_pkey",
    "idx_investments_asset_class",
    "idx_investments_is_active",
    "idx_portfolio_txn_investment_id",
    "idx_portfolio_txn_date",
    "idx_portfolio_txn_type",
    "idx_portfolio_transactions_account_id",
    "idx_portfolio_transactions_import_batch_id",
    "idx_ptxn_investment_account",
    "idx_ptxn_investment_date_id",
]

_CANONICAL_NAMES_SQL_ARRAY = (
    "ARRAY[" + ", ".join(f"'{n}'" for n in _CANONICAL_RELATION_NAMES) + "]"
)


def _is_legacy_shape(bind) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT to_regclass('public.investments_base') IS NOT NULL"
                " OR to_regclass('public.portfolio_transactions_base') IS NOT NULL"
            )
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _is_legacy_shape(bind):
        # Flat install (everything bootstrapped from 0001) — the canonical shape already.
        return

    # ------------------------------------------------------------------
    # 1. Shape sanity pre-flight — refuse anything but the exact legacy
    #    shape the chain guarantees at 0086.
    # ------------------------------------------------------------------
    tables_array = "ARRAY[" + ", ".join(f"'{t}'" for t in _LEGACY_TABLES) + "]"
    op.execute(
        f"""
        DO $$
        DECLARE
            missing text;
        BEGIN
            SELECT string_agg(t, ', ') INTO missing
              FROM unnest({tables_array}) AS t
             WHERE to_regclass('public.' || t) IS NULL;
            IF missing IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-109 conversion: legacy inheritance shape is incomplete '
                    '(missing relations: %). Refusing to convert an unknown schema shape; '
                    'restore from backup or contact support.', missing;
            END IF;

            IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.investments')) IS DISTINCT FROM 'v'
               OR (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.portfolio_transactions')) IS DISTINCT FROM 'v' THEN
                RAISE EXCEPTION 'ADR-109 conversion: investments/portfolio_transactions exist alongside '
                    'the inheritance base tables but are not views. Refusing to convert an unknown '
                    'schema shape; restore from backup or contact support.';
            END IF;

            -- Load-bearing columns later revisions added to the legacy shape.
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'portfolio_transactions_base'
                              AND column_name = 'account_id')
               OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'portfolio_transactions_base'
                              AND column_name = 'import_batch_id')
               OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'portfolio_transactions_base'
                              AND column_name = 'fx_rate_to_eur')
               OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'investments_base'
                              AND column_name = 'price_provider_latest_url') THEN
                RAISE EXCEPTION 'ADR-109 conversion: legacy shape is missing columns the chain '
                    'guarantees at 0086 (0016/0017/0052/0086). Refusing to convert.';
            END IF;
        END $$;
        """
    )

    # ------------------------------------------------------------------
    # 1b. DATA pre-flight — refuse, with actionable errors, the legacy
    #     states that would otherwise abort mid-conversion with a raw
    #     driver error (boot-looping the app with no guidance, since the
    #     chain runs before /health answers). Each RAISE aborts before any
    #     conversion work: the database is left untouched at 0086 and the
    #     legacy view keeps working.
    # ------------------------------------------------------------------
    op.execute(
        """
        DO $$
        DECLARE bad text;
        BEGIN
            -- (a) The canonical investments.symbol is VARCHAR(20) (0001); the legacy
            --     crypto child alone is VARCHAR(50) (legacy 0013). A longer value would
            --     abort the copy with a raw StringDataRightTruncation. Never truncated
            --     silently — the user shortens the symbol instead.
            SELECT string_agg(format('crypto_investments id %s symbol %L', id, symbol), '; ' ORDER BY id)
              INTO bad
              FROM crypto_investments
             WHERE length(symbol) > 20;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-109 conversion: crypto investment symbol(s) longer than 20 characters '
                    'do not fit the canonical investments.symbol VARCHAR(20) column: %. Shorten these '
                    'symbols (edit the investment in the app, or UPDATE crypto_investments via psql) and '
                    'restart. The database is unchanged.', bad;
            END IF;

            -- (b) An id present in more than one child table appears twice through the
            --     inheritance scan. The view and the flat copy BOTH double-count it, so the
            --     parity check would pass and the PRIMARY KEY build would abort with a raw
            --     duplicate-key error instead. (Reachable organically: a behind-max sequence
            --     resync plus one insert into a different child table.)
            SELECT string_agg(id::text, ', ' ORDER BY id) INTO bad
              FROM (SELECT id FROM investments_base GROUP BY id HAVING count(*) > 1) dup;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-109 conversion: investment id(s) % exist in more than one '
                    'asset-class child table (stock_investments/etf_investments/…). Delete or re-id '
                    'the duplicate row(s) so each id lives in exactly one child table, then restart. '
                    'The database is unchanged.', bad;
            END IF;
            SELECT string_agg(id::text, ', ' ORDER BY id) INTO bad
              FROM (SELECT id FROM portfolio_transactions_base GROUP BY id HAVING count(*) > 1) dup;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-109 conversion: portfolio transaction id(s) % exist in more than '
                    'one asset-class child table (stock_transactions/etf_transactions/…). Delete or '
                    're-id the duplicate row(s) so each id lives in exactly one child table, then '
                    'restart. The database is unchanged.', bad;
            END IF;

            -- (c) A row living only in investments_base (no child) has no asset_class.
            --     By design the conversion refuses to guess one (the flat column is NOT
            --     NULL); without this check the copy aborts with a raw NotNullViolation.
            SELECT string_agg(id::text, ', ' ORDER BY id) INTO bad FROM ONLY investments_base;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-109 conversion: investments_base row(s) % have no asset-class '
                    'child row, so their asset_class is unknown — the conversion deliberately refuses '
                    'to guess. Move each row into the correct child table (INSERT INTO '
                    '<class>_investments ... SELECT ...; DELETE FROM ONLY investments_base WHERE id = ...) '
                    'or delete it, then restart. The database is unchanged.', bad;
            END IF;
        END $$;
        """
    )

    # ------------------------------------------------------------------
    # 2. The legacy asset_class enum (legacy 0004) has no 'metals' value —
    #    the view emitted asset_class as TEXT, so the app never needed it.
    #    The flat enum column does. A value added in the current transaction
    #    cannot be used in it, hence the autocommit block; the statement is
    #    idempotent, and everything below runs in one transaction.
    # ------------------------------------------------------------------
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE asset_class ADD VALUE IF NOT EXISTS 'metals'")

    # ------------------------------------------------------------------
    # 3. Flat copies, column definitions matching 0001's DDL exactly
    #    (+ 0052 account_id, + 0086 import_batch_id).
    # ------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE investments_flat (
          id SERIAL,
          name VARCHAR(200) NOT NULL,
          symbol VARCHAR(20),
          asset_class asset_class NOT NULL,
          currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
          current_price NUMERIC(18,6),
          interest_rate NUMERIC(8,4),
          maturity_date DATE,
          location VARCHAR(300),
          municipality VARCHAR(200),
          cadastral_income NUMERIC(12,2),
          municipality_tax_rate NUMERIC(8,4),
          notes TEXT,
          is_active BOOLEAN NOT NULL DEFAULT true,
          price_provider price_provider NOT NULL DEFAULT 'manual',
          price_provider_id VARCHAR(200),
          price_provider_url VARCHAR(500),
          price_provider_latest_url VARCHAR(500),
          price_provider_latest_path VARCHAR(300),
          price_provider_history_url VARCHAR(500),
          price_provider_history_path VARCHAR(300),
          price_provider_history_ts_path VARCHAR(300),
          price_provider_history_price_path VARCHAR(300),
          price_updated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    op.execute(
        """
        CREATE TABLE portfolio_transactions_flat (
          id SERIAL,
          investment_id INTEGER NOT NULL,
          type portfolio_txn_type NOT NULL,
          date DATE NOT NULL,
          amount NUMERIC(18,4) NOT NULL,
          units NUMERIC(18,8),
          price_per_unit NUMERIC(18,6),
          fees NUMERIC(18,4) DEFAULT 0,
          taxes NUMERIC(18,4) DEFAULT 0,
          currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
          fx_rate_to_eur NUMERIC(20,10),
          note TEXT,
          is_recurring BOOLEAN NOT NULL DEFAULT false,
          recurrence_interval recurrence_interval,
          recurrence_end_date DATE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          account_id INTEGER,
          import_batch_id BIGINT
        );
        """
    )

    # Copy investments from the base+child JOIN (not the view): identical to the view's
    # projection except interest_rate also picks up bond_investments.interest_rate, which the
    # legacy view (0017) never exposed. A row living only in investments_base (no child) has
    # no asset_class and violates the NOT NULL — aborting the conversion, by design.
    op.execute(
        """
        INSERT INTO investments_flat (
            id, name, symbol, asset_class, currency, current_price,
            interest_rate, maturity_date, location, municipality, cadastral_income,
            municipality_tax_rate, notes, is_active, price_provider, price_provider_id,
            price_provider_url, price_provider_latest_url, price_provider_latest_path,
            price_provider_history_url, price_provider_history_path,
            price_provider_history_ts_path, price_provider_history_price_path,
            price_updated_at, created_at, updated_at)
        SELECT
            ib.id,
            ib.name,
            COALESCE(si.symbol, ei.symbol, ci.symbol, mi.symbol),
            (CASE
                WHEN si.id IS NOT NULL THEN 'stock'
                WHEN ei.id IS NOT NULL THEN 'etf'
                WHEN ci.id IS NOT NULL THEN 'crypto'
                WHEN mi.id IS NOT NULL THEN 'metals'
                WHEN rei.id IS NOT NULL THEN 'real_estate'
                WHEN savi.id IS NOT NULL THEN 'savings'
                WHEN bi.id IS NOT NULL THEN 'bond'
            END)::asset_class,
            ib.currency,
            COALESCE(si.current_price, ei.current_price, ci.current_price, mi.current_price,
                     rei.current_price, savi.current_price, bi.current_price),
            COALESCE(savi.interest_rate, bi.interest_rate),
            bi.maturity_date,
            rei.location,
            rei.municipality,
            rei.cadastral_income,
            rei.municipality_tax_rate,
            ib.notes,
            ib.is_active,
            COALESCE(ib.price_provider, 'manual'),
            ib.price_provider_id,
            ib.price_provider_url,
            ib.price_provider_latest_url,
            ib.price_provider_latest_path,
            ib.price_provider_history_url,
            ib.price_provider_history_path,
            ib.price_provider_history_ts_path,
            ib.price_provider_history_price_path,
            ib.price_updated_at,
            ib.created_at,
            ib.updated_at
        FROM investments_base ib
        LEFT JOIN stock_investments si ON ib.id = si.id
        LEFT JOIN etf_investments ei ON ib.id = ei.id
        LEFT JOIN crypto_investments ci ON ib.id = ci.id
        LEFT JOIN metals_investments mi ON ib.id = mi.id
        LEFT JOIN real_estate_investments rei ON ib.id = rei.id
        LEFT JOIN savings_investments savi ON ib.id = savi.id
        LEFT JOIN bond_investments bi ON ib.id = bi.id;
        """
    )

    # Legacy investment deletion went through investments_base. Because PostgreSQL inheritance
    # did not propagate the investment FK to transaction children, that valid API action left
    # transaction rows whose investment no longer existed. The canonical FK is ON DELETE CASCADE,
    # so omit those leftovers from the flat copy while preserving them in the legacy relations
    # kept for rollback. Make the repair visible in the migration log.
    op.execute(
        """
        DO $$
        DECLARE bad_ids text;
        BEGIN
            SELECT string_agg(pt.id::text, ', ' ORDER BY pt.id) INTO bad_ids
              FROM portfolio_transactions pt
             WHERE NOT EXISTS (SELECT 1 FROM investments i WHERE i.id = pt.investment_id);
            IF bad_ids IS NOT NULL THEN
                RAISE WARNING 'ADR-109 conversion: omitting legacy portfolio transaction(s) % '
                    'because their investments were previously deleted. This completes the '
                    'canonical ON DELETE CASCADE behavior; rollback keeps the rows in the legacy '
                    'inheritance tables.', bad_ids;
            END IF;
        END $$;
        """
    )

    # The view exposes every flat column (0086's definition), so this is the view's own
    # projection, row for row, restricted only to transactions with a surviving investment.
    op.execute(
        """
        INSERT INTO portfolio_transactions_flat (
            id, investment_id, type, date, amount, units, price_per_unit, fees, taxes,
            currency, fx_rate_to_eur, note, is_recurring, recurrence_interval,
            recurrence_end_date, created_at, updated_at, account_id, import_batch_id)
        SELECT
            id, investment_id, type, date, amount, units, price_per_unit, fees, taxes,
            currency, fx_rate_to_eur, note, is_recurring, recurrence_interval,
            recurrence_end_date, created_at, updated_at, account_id, import_batch_id
        FROM portfolio_transactions pt
        WHERE EXISTS (SELECT 1 FROM investments i WHERE i.id = pt.investment_id);
        """
    )

    # ------------------------------------------------------------------
    # 4. Parity pre-flight (ADR-109 §6): counts + an order-independent hash
    #    over id and money columns, view vs flat copy. Any mismatch aborts
    #    the transaction and leaves the database untouched.
    # ------------------------------------------------------------------
    op.execute(
        """
        DO $$
        DECLARE
            view_count bigint;  flat_count bigint;
            view_hash  numeric; flat_hash  numeric;
        BEGIN
            SELECT COUNT(*),
                   COALESCE(SUM(hashtextextended(concat_ws('|',
                       id::text, name, COALESCE(asset_class::text, '<null>'),
                       COALESCE(symbol, '<null>'), currency,
                       COALESCE(current_price::text, '<null>')), 0)::numeric), 0)
              INTO view_count, view_hash FROM investments;
            SELECT COUNT(*),
                   COALESCE(SUM(hashtextextended(concat_ws('|',
                       id::text, name, COALESCE(asset_class::text, '<null>'),
                       COALESCE(symbol, '<null>'), currency,
                       COALESCE(current_price::text, '<null>')), 0)::numeric), 0)
              INTO flat_count, flat_hash FROM investments_flat;
            IF view_count <> flat_count OR view_hash <> flat_hash THEN
                RAISE EXCEPTION 'ADR-109 conversion: investments parity check failed '
                    '(view % rows / hash %, flat copy % rows / hash %). Aborting without '
                    'changing the schema; restore from backup or contact support.',
                    view_count, view_hash, flat_count, flat_hash;
            END IF;

            SELECT COUNT(*),
                   COALESCE(SUM(hashtextextended(concat_ws('|',
                       id::text, investment_id::text, type::text, date::text, amount::text,
                       COALESCE(units::text, '<null>'), COALESCE(price_per_unit::text, '<null>'),
                       COALESCE(fees::text, '<null>'), COALESCE(taxes::text, '<null>'),
                       currency, COALESCE(fx_rate_to_eur::text, '<null>'),
                       COALESCE(account_id::text, '<null>'),
                       COALESCE(import_batch_id::text, '<null>')), 0)::numeric), 0)
              INTO view_count, view_hash
              FROM portfolio_transactions pt
             WHERE EXISTS (SELECT 1 FROM investments i WHERE i.id = pt.investment_id);
            SELECT COUNT(*),
                   COALESCE(SUM(hashtextextended(concat_ws('|',
                       id::text, investment_id::text, type::text, date::text, amount::text,
                       COALESCE(units::text, '<null>'), COALESCE(price_per_unit::text, '<null>'),
                       COALESCE(fees::text, '<null>'), COALESCE(taxes::text, '<null>'),
                       currency, COALESCE(fx_rate_to_eur::text, '<null>'),
                       COALESCE(account_id::text, '<null>'),
                       COALESCE(import_batch_id::text, '<null>')), 0)::numeric), 0)
              INTO flat_count, flat_hash FROM portfolio_transactions_flat;
            IF view_count <> flat_count OR view_hash <> flat_hash THEN
                RAISE EXCEPTION 'ADR-109 conversion: portfolio_transactions parity check failed '
                    '(view % rows / hash %, flat copy % rows / hash %). Aborting without '
                    'changing the schema; restore from backup or contact support.',
                    view_count, view_hash, flat_count, flat_hash;
            END IF;
        END $$;
        """
    )

    # ------------------------------------------------------------------
    # 5. Swap. First free every canonical relation-namespace name (PK
    #    indexes / index names are schema-global; the pre-0013
    #    investments_legacy snapshot still owns e.g. investments_pkey and
    #    idx_investments_asset_class, and 0079 placed idx_ptxn_* on the
    #    inheritance base). Constraint-owned indexes are renamed through
    #    their constraint so both stay in sync.
    # ------------------------------------------------------------------
    op.execute(
        f"""
        DO $$
        DECLARE
            nm  text;
            con record;
        BEGIN
            FOREACH nm IN ARRAY {_CANONICAL_NAMES_SQL_ARRAY}
            LOOP
                IF to_regclass('public.' || nm) IS NOT NULL THEN
                    -- Only the constraint that OWNS the index (PK/unique/exclusion):
                    -- FK constraints also carry conindid, pointing at the referenced
                    -- unique index, and must not be renamed here.
                    SELECT c.conrelid::regclass::text AS tbl, c.conname AS conname INTO con
                      FROM pg_constraint c
                     WHERE c.conindid = to_regclass('public.' || nm)
                       AND c.contype IN ('p', 'u', 'x');
                    IF FOUND THEN
                        EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                                       con.tbl, con.conname, '{_ASIDE_PREFIX}' || nm);
                    ELSE
                        EXECUTE format('ALTER INDEX %I RENAME TO %I', nm, '{_ASIDE_PREFIX}' || nm);
                    END IF;
                END IF;
            END LOOP;
        END $$;
        """
    )

    # Views and inheritance tables aside (dependencies — the JOIN view, the INSTEAD OF
    # trigger, the *_investments_full helper views, the inheritance links — all follow the
    # renames by OID and keep working against the renamed relations)…
    op.execute("ALTER VIEW investments RENAME TO legacy_inh_investments")
    op.execute(
        "ALTER VIEW portfolio_transactions RENAME TO legacy_inh_portfolio_transactions"
    )
    for tbl in _LEGACY_TABLES:
        op.execute(f"ALTER TABLE {tbl} RENAME TO {_ASIDE_PREFIX}{tbl}")
    # …and the flat copies take the canonical names.
    op.execute("ALTER TABLE investments_flat RENAME TO investments")
    op.execute(
        "ALTER TABLE portfolio_transactions_flat RENAME TO portfolio_transactions"
    )
    # PostgreSQL 18+ catalogues per-column NOT NULL constraints in pg_constraint
    # with auto-generated names taken from the table's CREATE-time name — which
    # here is the transient *_flat name, surviving the rename above. Rename them
    # to what a fresh install gets, so converted and fresh schemas stay
    # name-identical. No-op on PG <= 17, where NOT NULLs are not catalogued.
    op.execute(
        """
        DO $$
        DECLARE con record;
        BEGIN
            FOR con IN
                SELECT conrelid::regclass AS rel, conname
                  FROM pg_constraint
                 WHERE conrelid IN ('investments'::regclass, 'portfolio_transactions'::regclass)
                   AND conname LIKE '%\\_flat\\_%'
            LOOP
                EXECUTE format(
                    'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                    con.rel, con.conname, replace(con.conname, '_flat_', '_')
                );
            END LOOP;
        END $$;
        """
    )

    # ------------------------------------------------------------------
    # 6. Canonical constraints, indexes and triggers (0001/0026/0040/0052/
    #    0079/0086 names), including the FKs the view shape could not hold.
    # ------------------------------------------------------------------
    op.execute(
        "ALTER TABLE investments ADD CONSTRAINT investments_pkey PRIMARY KEY (id)"
    )
    op.execute(
        "ALTER TABLE portfolio_transactions ADD CONSTRAINT portfolio_transactions_pkey PRIMARY KEY (id)"
    )

    op.execute(
        """
        ALTER TABLE portfolio_transactions
            ADD CONSTRAINT portfolio_transactions_investment_id_fkey
            FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        """
    )

    # account_id / import_batch_id were unenforced on legacy child tables (FKs on an
    # inheritance base do not propagate) — a reference whose target row is gone is already
    # meaningless, and both columns are nullable links, so dangling values are nulled.
    op.execute(
        """
        UPDATE portfolio_transactions pt SET account_id = NULL
         WHERE pt.account_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = pt.account_id)
        """
    )
    op.execute(
        """
        ALTER TABLE portfolio_transactions
            ADD CONSTRAINT portfolio_transactions_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
        """
    )
    op.execute(
        """
        UPDATE portfolio_transactions pt SET import_batch_id = NULL
         WHERE pt.import_batch_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM portfolio_import_batches b WHERE b.id = pt.import_batch_id)
        """
    )
    op.execute(
        """
        ALTER TABLE portfolio_transactions
            ADD CONSTRAINT portfolio_transactions_import_batch_id_fkey
            FOREIGN KEY (import_batch_id) REFERENCES portfolio_import_batches(id) ON DELETE SET NULL
        """
    )

    # 0026 skipped this FK on legacy installs; apply it now with the identical orphan cleanup
    # 0026 runs on flat installs (derived price-history rows for deleted investments).
    op.execute(
        "DELETE FROM asset_price_history WHERE investment_id NOT IN (SELECT id FROM investments)"
    )
    op.execute(
        """
        ALTER TABLE asset_price_history
            ADD CONSTRAINT fk_aph_investment
            FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        """
    )

    # 0040 skipped the staging-row investment FKs on legacy installs. Staging rows are
    # transient pipeline state with no integrity guarantee on the legacy shape; dangling
    # matches are nulled (both columns are nullable ON DELETE SET NULL links).
    op.execute(
        """
        UPDATE portfolio_import_staging_rows SET resolved_investment_id = NULL
         WHERE resolved_investment_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM investments i WHERE i.id = resolved_investment_id)
        """
    )
    op.execute(
        """
        UPDATE portfolio_import_staging_rows SET user_override_investment_id = NULL
         WHERE user_override_investment_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM investments i WHERE i.id = user_override_investment_id)
        """
    )
    op.execute(
        """
        ALTER TABLE portfolio_import_staging_rows
            ADD CONSTRAINT fk_pf_staging_resolved_investment
            FOREIGN KEY (resolved_investment_id) REFERENCES investments(id) ON DELETE SET NULL
        """
    )
    op.execute(
        """
        ALTER TABLE portfolio_import_staging_rows
            ADD CONSTRAINT fk_pf_staging_override_investment
            FOREIGN KEY (user_override_investment_id) REFERENCES investments(id) ON DELETE SET NULL
        """
    )

    op.execute("CREATE INDEX idx_investments_asset_class ON investments (asset_class)")
    op.execute("CREATE INDEX idx_investments_is_active ON investments (is_active)")
    op.execute(
        "CREATE INDEX idx_portfolio_txn_investment_id ON portfolio_transactions (investment_id)"
    )
    op.execute("CREATE INDEX idx_portfolio_txn_date ON portfolio_transactions (date)")
    op.execute("CREATE INDEX idx_portfolio_txn_type ON portfolio_transactions (type)")
    op.execute(
        "CREATE INDEX idx_portfolio_transactions_account_id ON portfolio_transactions (account_id)"
    )
    op.execute(
        """
        CREATE INDEX idx_portfolio_transactions_import_batch_id
            ON portfolio_transactions (import_batch_id) WHERE import_batch_id IS NOT NULL
        """
    )
    op.execute(
        "CREATE INDEX idx_ptxn_investment_account ON portfolio_transactions (investment_id, account_id)"
    )
    op.execute(
        "CREATE INDEX idx_ptxn_investment_date_id ON portfolio_transactions (investment_id, date, id)"
    )

    # 0001's updated_at triggers (update_updated_at_column() exists on legacy installs too —
    # legacy 0013 created it).
    op.execute(
        """
        CREATE TRIGGER update_investments_updated_at
            BEFORE UPDATE ON investments
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        """
    )
    op.execute(
        """
        CREATE TRIGGER update_portfolio_txn_updated_at
            BEFORE UPDATE ON portfolio_transactions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        """
    )

    # ------------------------------------------------------------------
    # 7. Sequences + planner stats. (The tables keep their creation-time
    #    sequences, investments_flat_id_seq / portfolio_transactions_flat_id_seq
    #    — the canonical *_id_seq names are still owned by the pre-0013
    #    *_legacy snapshots, and nothing resolves sequences by literal name.)
    # ------------------------------------------------------------------
    # Next id = GREATEST(what the legacy sequence would have issued next, MAX(id)+1).
    # MAX(id)+1 alone would re-issue previously-used ids when the legacy sequence ran
    # AHEAD of the surviving rows (top rows deleted) — and stale FK-less references
    # (investment_ticker_prefs, transactions.portfolio_transaction_id) could silently
    # attach to a reused id. The legacy sequences still exist, owned by the renamed
    # base tables, so their high-water mark is read through pg_get_serial_sequence.
    op.execute(
        """
        DO $$
        DECLARE
            legacy_seq  text;
            legacy_next bigint;
            next_id     bigint;
        BEGIN
            legacy_seq := pg_get_serial_sequence('legacy_inh_investments_base', 'id');
            IF legacy_seq IS NOT NULL THEN
                EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', legacy_seq)
                   INTO legacy_next;
            ELSE
                legacy_next := 1;
            END IF;
            SELECT GREATEST(legacy_next, COALESCE(MAX(id), 0) + 1) INTO next_id FROM investments;
            PERFORM setval(pg_get_serial_sequence('investments', 'id'), next_id, false);

            legacy_seq := pg_get_serial_sequence('legacy_inh_portfolio_transactions_base', 'id');
            IF legacy_seq IS NOT NULL THEN
                EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', legacy_seq)
                   INTO legacy_next;
            ELSE
                legacy_next := 1;
            END IF;
            SELECT GREATEST(legacy_next, COALESCE(MAX(id), 0) + 1) INTO next_id FROM portfolio_transactions;
            PERFORM setval(pg_get_serial_sequence('portfolio_transactions', 'id'), next_id, false);
        END $$;
        """
    )
    op.execute("ANALYZE investments")
    op.execute("ANALYZE portfolio_transactions")


def downgrade() -> None:
    bind = op.get_bind()
    converted = bool(
        bind.execute(
            sa.text(
                "SELECT to_regclass('public.legacy_inh_investments_base') IS NOT NULL"
            )
        ).scalar()
    )
    if not converted:
        # Fresh/flat install, or a legacy install this revision never converted — nothing to
        # reverse (the upgrade was a no-op there).
        return

    # Drop the FKs this revision added onto other tables, then the converted flat tables
    # (freeing the canonical names; rows written after the conversion are lost — the
    # rollback path is destructive by definition).
    op.execute(
        "ALTER TABLE asset_price_history DROP CONSTRAINT IF EXISTS fk_aph_investment"
    )
    op.execute(
        "ALTER TABLE portfolio_import_staging_rows DROP CONSTRAINT IF EXISTS fk_pf_staging_resolved_investment"
    )
    op.execute(
        "ALTER TABLE portfolio_import_staging_rows DROP CONSTRAINT IF EXISTS fk_pf_staging_override_investment"
    )
    op.execute("DROP TABLE portfolio_transactions")
    op.execute("DROP TABLE investments")

    # Reverse the renames: inheritance tables and views take their canonical names back…
    for tbl in reversed(_LEGACY_TABLES):
        op.execute(f"ALTER TABLE {_ASIDE_PREFIX}{tbl} RENAME TO {tbl}")
    op.execute("ALTER VIEW legacy_inh_investments RENAME TO investments")
    op.execute(
        "ALTER VIEW legacy_inh_portfolio_transactions RENAME TO portfolio_transactions"
    )

    # …and every index/constraint renamed aside by the upgrade gets its original name back.
    op.execute(
        f"""
        DO $$
        DECLARE
            nm  text;
            con record;
        BEGIN
            FOREACH nm IN ARRAY {_CANONICAL_NAMES_SQL_ARRAY}
            LOOP
                IF to_regclass('public.{_ASIDE_PREFIX}' || nm) IS NOT NULL THEN
                    -- Same owning-constraint restriction as the upgrade loop: FK
                    -- constraints share conindid with the index they reference.
                    SELECT c.conrelid::regclass::text AS tbl, c.conname AS conname INTO con
                      FROM pg_constraint c
                     WHERE c.conindid = to_regclass('public.{_ASIDE_PREFIX}' || nm)
                       AND c.contype IN ('p', 'u', 'x');
                    IF FOUND THEN
                        EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                                       con.tbl, con.conname, nm);
                    ELSE
                        EXECUTE format('ALTER INDEX %I RENAME TO %I', '{_ASIDE_PREFIX}' || nm, nm);
                    END IF;
                END IF;
            END LOOP;
        END $$;
        """
    )
