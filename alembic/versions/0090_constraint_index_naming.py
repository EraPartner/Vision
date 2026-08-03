"""Align constraint/index names to the canonical chk_/uq_/idx_ prefixes.

Revision ID: 0090_constraint_index_naming
Revises: 0089_free_text_enum_checks
Create Date: 2026-08-03

The schema's naming was split three ways — `chk_*` vs `ck_*` CHECKs, `uq_*` vs
`uniq_*`/`ux_*` unique indexes, `idx_*` vs `ix_*`/suffix-`*_idx` indexes — and
0001 still carried anonymous inline CHECKs whose auto-generated names have
already forced two pg_constraint-discovery DO-blocks (0015:108-127,
0048:34/65-66). This housekeeping revision settles on **chk_ / uq_ / idx_** as
canonical (documented in docs/reference/code-patterns.md, "Database Naming &
Enum Discipline"), renames the outliers, and gives the four anonymous 0001
CHECKs real names via `RENAME CONSTRAINT` (cheaper and safer than the
drop-and-re-add the finding sketched: validity, catalog dependencies and the
data all stay put).

Inventory RE-DERIVED from the live head-0089 catalogs on BOTH install shapes
(fresh 0001→head and ADR-109 converted-legacy) — the shapes carry identical
names for every object below, so no per-shape branching is needed. Every
rename is nonetheless guarded by existence checks (old present, new absent) so
a partially-migrated or hand-repaired install migrates cleanly instead of
erroring. The `legacy_inh_*` frozen rollback relations of 0087 and anything
0087 itself renamed are explicitly out of scope, as are the PG-18 per-column
NOT NULL constraint names 0087 already handles.

Deliberately NOT renamed (residue, so the diff stays reviewable and the blast
radius auditable):
  * auto-named UNIQUE constraints from 0001 inline UNIQUEs (`*_key`, e.g. the
    eight `*_deduplication_hash_key`, `recipients_normalized_name_key`) — the
    finding's naming-split evidence covers prefix style, not these; renaming
    them buys nothing until one needs an ALTER;
  * explicitly-named `*_check`-suffix CHECKs added by later migrations with
    their names in source (import_staging_rows_match_source_check 0015,
    portfolio_import_*_status_check 0040/0081, db_editor_audit_op_check 0059,
    recipient_match_patterns_*_check 0015) — named, hence no discovery dance;
  * every unnamed 0001 FK — an FK-policy change is the right moment, per the
    0048 precedent.

Blast radius (grepped repo-wide per name): no application code, ON CONFLICT
target, or error handler references any renamed name — the single behavioural
reference was a test regex on `ux_transactions_opening_anchor`
(tests/systemRecipientRows.db.test.js), updated with this revision alongside
the handful of comments/docs that cite old names. Older migrations' own
upgrade()/downgrade() bodies keep the old names correctly: on any path that
reaches them, this revision's downgrade() has already restored those names.

Rollback = the exact reverse renames, same guards.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0090_constraint_index_naming"
down_revision: Union[str, Sequence[str], None] = "0089_free_text_enum_checks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ── constraint renames: (table, old, new) ───────────────────────────────────
_CONSTRAINT_RENAMES = (
    # ck_* → chk_* prefix outliers
    ("accounts", "ck_accounts_active_not_closed", "chk_accounts_active_not_closed"),
    ("accounts", "ck_accounts_statement_balance_has_date", "chk_accounts_statement_balance_has_date"),
    ("custom_parser_configs", "ck_custom_parser_configs_kind", "chk_custom_parser_configs_kind"),
    ("instrument_provider_map", "ck_instrument_provider_map_key_type", "chk_instrument_provider_map_key_type"),
    ("instrument_provider_map", "ck_instrument_provider_map_status", "chk_instrument_provider_map_status"),
    ("planned_transactions", "ck_planned_max_occurrences_positive", "chk_planned_max_occurrences_positive"),
    ("provider_quota", "ck_provider_quota_count_nonneg", "chk_provider_quota_count_nonneg"),
    ("transactions", "ck_transactions_transfer_source", "chk_transactions_transfer_source"),
    ("transfer_dismissals", "ck_transfer_dismissals_ordered", "chk_transfer_dismissals_ordered"),
    # the four anonymous 0001 inline CHECKs (auto-generated names)
    ("ai_messages", "ai_messages_role_check", "chk_ai_messages_role"),
    ("ai_messages", "ai_messages_status_check", "chk_ai_messages_status"),
    ("import_batches", "import_batches_status_check", "chk_import_batches_status"),
    ("import_staging_rows", "import_staging_rows_status_check", "chk_import_staging_rows_status"),
)

# ── index renames: (old, new) ───────────────────────────────────────────────
_INDEX_RENAMES = (
    # unique indexes: uniq_*/ux_* → uq_*
    ("uniq_pte_planned_executed", "uq_pte_planned_executed"),
    ("uniq_transactions_tx_hash", "uq_transactions_tx_hash"),
    ("ux_transactions_opening_anchor", "uq_transactions_opening_anchor"),
    # suffix-style → idx_ prefix
    ("db_editor_audit_table_time_idx", "idx_db_editor_audit_table_time"),
    # ix_* → idx_*
    ("ix_import_staging_rows_matched_pattern_id", "idx_import_staging_rows_matched_pattern_id"),
    ("ix_import_staging_rows_user_override_recipient_id", "idx_import_staging_rows_user_override_recipient_id"),
    ("ix_instrument_provider_map_provider_symbol", "idx_instrument_provider_map_provider_symbol"),
    ("ix_manual_raw_transactions_category_id", "idx_manual_raw_transactions_category_id"),
    ("ix_manual_raw_transactions_recipient_id", "idx_manual_raw_transactions_recipient_id"),
    ("ix_portfolio_import_staging_rows_resolved_investment_id", "idx_portfolio_import_staging_rows_resolved_investment_id"),
    ("ix_portfolio_import_staging_rows_user_override_investment_id", "idx_portfolio_import_staging_rows_user_override_investment_id"),
    ("ix_snapshot_accounts_currency_date", "idx_snapshot_accounts_currency_date"),
    ("ix_transfer_dismissals_b", "idx_transfer_dismissals_b"),
)


def _rename_constraint(table: str, old: str, new: str) -> None:
    """Rename a table constraint iff the table and old name exist and the new
    name does not — tolerant of hand-repaired or partially-migrated installs."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{table}') IS NOT NULL
               AND EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname = '{old}'
                              AND conrelid = 'public.{table}'::regclass)
               AND NOT EXISTS (SELECT 1 FROM pg_constraint
                                WHERE conname = '{new}'
                                  AND conrelid = 'public.{table}'::regclass)
            THEN
                EXECUTE format('ALTER TABLE public.{table} RENAME CONSTRAINT %I TO %I',
                               '{old}', '{new}');
            END IF;
        END;
        $$;
        """
    )


def _rename_index(old: str, new: str) -> None:
    """Rename an index iff the old relation exists and the new name is free."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old}') IS NOT NULL
               AND to_regclass('public.{new}') IS NULL
            THEN
                EXECUTE format('ALTER INDEX public.%I RENAME TO %I', '{old}', '{new}');
            END IF;
        END;
        $$;
        """
    )


def upgrade() -> None:
    for table, old, new in _CONSTRAINT_RENAMES:
        _rename_constraint(table, old, new)
    for old, new in _INDEX_RENAMES:
        _rename_index(old, new)


def downgrade() -> None:
    for table, old, new in reversed(_CONSTRAINT_RENAMES):
        _rename_constraint(table, new, old)
    for old, new in reversed(_INDEX_RENAMES):
        _rename_index(new, old)
