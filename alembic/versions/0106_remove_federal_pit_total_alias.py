"""Remove the persisted Belgian-tax federalPITTotal alias.

Revision ID: 0106_remove_federal_pit_total_alias
Revises: 0105_retire_legacy_exchange_rate_cache
Create Date: 2026-09-11

The alias can occur only inside frozen calculations stored in
user_settings['belgian_tax_profile_snapshot_meta_v1']. Before rewriting, the
migration requires every alias to be a JSON number with an equal numeric
federalPITBeforeExemption value. Any alias-only, malformed, or divergent value
aborts the migration atomically.

Blast radius: one user_settings JSONB row. The row is already included in the
normal database backup. Downgrade recreates the redundant alias from the
canonical numeric value.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0106_remove_federal_pit_total_alias"
down_revision: Union[str, Sequence[str], None] = (
    "0105_retire_legacy_exchange_rate_cache"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE
            invalid_count bigint;
        BEGIN
            LOCK TABLE user_settings IN SHARE ROW EXCLUSIVE MODE;

            SELECT count(*) INTO invalid_count
              FROM user_settings
             WHERE key = 'belgian_tax_profile_snapshot_meta_v1'
               AND jsonb_typeof(value) <> 'object';
            IF invalid_count <> 0 THEN
                RAISE EXCEPTION
                    'federalPITTotal retirement refused: snapshot metadata must be a JSON object';
            END IF;

            SELECT count(*) INTO invalid_count
              FROM user_settings AS settings
              CROSS JOIN LATERAL jsonb_each(settings.value) AS year_entry
             WHERE settings.key = 'belgian_tax_profile_snapshot_meta_v1'
               AND jsonb_typeof(year_entry.value) = 'object'
               AND jsonb_typeof(year_entry.value->'frozenCalculation') = 'object'
               AND (year_entry.value->'frozenCalculation') ? 'federalPITTotal'
               AND (
                   NOT ((year_entry.value->'frozenCalculation') ? 'federalPITBeforeExemption')
                   OR jsonb_typeof(
                       year_entry.value->'frozenCalculation'->'federalPITTotal'
                   ) <> 'number'
                   OR jsonb_typeof(
                       year_entry.value->'frozenCalculation'->'federalPITBeforeExemption'
                   ) <> 'number'
                   OR year_entry.value->'frozenCalculation'->'federalPITTotal'
                      <> year_entry.value->'frozenCalculation'->'federalPITBeforeExemption'
               );
            IF invalid_count <> 0 THEN
                RAISE EXCEPTION
                    'federalPITTotal retirement refused: % alias values are missing, malformed, or divergent',
                    invalid_count;
            END IF;

            UPDATE user_settings AS settings
               SET value = rewritten.value
              FROM (
                  SELECT source.key,
                         jsonb_object_agg(
                             year_entry.key,
                             CASE
                                 WHEN jsonb_typeof(year_entry.value) = 'object'
                                  AND jsonb_typeof(
                                      year_entry.value->'frozenCalculation'
                                  ) = 'object'
                                  AND (year_entry.value->'frozenCalculation')
                                      ? 'federalPITTotal'
                                 THEN jsonb_set(
                                     year_entry.value,
                                     '{frozenCalculation}',
                                     (year_entry.value->'frozenCalculation')
                                         - 'federalPITTotal'
                                 )
                                 ELSE year_entry.value
                             END
                         ) AS value
                    FROM user_settings AS source
                    CROSS JOIN LATERAL jsonb_each(source.value) AS year_entry
                   WHERE source.key = 'belgian_tax_profile_snapshot_meta_v1'
                   GROUP BY source.key
              ) AS rewritten
             WHERE settings.key = rewritten.key
               AND settings.value <> rewritten.value;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE user_settings AS settings
           SET value = rewritten.value
          FROM (
              SELECT source.key,
                     jsonb_object_agg(
                         year_entry.key,
                         CASE
                             WHEN jsonb_typeof(year_entry.value) = 'object'
                              AND jsonb_typeof(
                                  year_entry.value->'frozenCalculation'
                              ) = 'object'
                              AND jsonb_typeof(
                                  year_entry.value->'frozenCalculation'
                                      ->'federalPITBeforeExemption'
                              ) = 'number'
                             THEN jsonb_set(
                                 year_entry.value,
                                 '{frozenCalculation}',
                                 (year_entry.value->'frozenCalculation') ||
                                     jsonb_build_object(
                                         'federalPITTotal',
                                         year_entry.value->'frozenCalculation'
                                             ->'federalPITBeforeExemption'
                                     )
                             )
                             ELSE year_entry.value
                         END
                     ) AS value
                FROM user_settings AS source
                CROSS JOIN LATERAL jsonb_each(source.value) AS year_entry
               WHERE source.key = 'belgian_tax_profile_snapshot_meta_v1'
                 AND jsonb_typeof(source.value) = 'object'
               GROUP BY source.key
          ) AS rewritten
         WHERE settings.key = rewritten.key
           AND settings.value <> rewritten.value;
        """
    )
