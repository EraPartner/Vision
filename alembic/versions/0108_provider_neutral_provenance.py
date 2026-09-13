"""Add durable provider-neutral transaction provenance.

Revision ID: 0108_provider_neutral_provenance
Revises: 0107_analysis_dataset_views
Create Date: 2026-09-12

This is the expand half of the legacy raw-table retirement. It copies every
available legacy row as exact JSONB plus its raw CSV bytes and preserves raw
reference links, including dangling references. It does not drop legacy data.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0108_provider_neutral_provenance"
down_revision: Union[str, Sequence[str], None] = "0107_analysis_dataset_views"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SOURCE_TABLES = (
    ("belfius", "belfius_raw_transactions"),
    ("revolut", "revolut_raw_transactions"),
    ("kbc", "kbc_raw_transactions"),
    ("sabb", "sabb_raw_transactions"),
    ("wise", "wise_raw_transactions"),
    ("vision", "vision_raw_transactions"),
    ("custom", "custom_raw_transactions"),
    ("manual", "manual_raw_transactions"),
)


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE transaction_source_records (
            id BIGSERIAL PRIMARY KEY,
            source_type TEXT NOT NULL,
            legacy_source_id BIGINT NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL,
            deduplication_hash TEXT,
            raw_csv_line TEXT,
            native_payload JSONB NOT NULL,
            migration_status TEXT NOT NULL DEFAULT 'linked'
                CHECK (migration_status IN ('linked', 'unlinked', 'dangling-reference')),
            migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_transaction_source_record UNIQUE (source_type, legacy_source_id)
        );

        CREATE INDEX idx_transaction_source_records_hash
            ON transaction_source_records (source_type, deduplication_hash)
            WHERE deduplication_hash IS NOT NULL;

        CREATE TABLE transaction_source_links (
            id BIGSERIAL PRIMARY KEY,
            source_record_id BIGINT NOT NULL REFERENCES transaction_source_records(id) ON DELETE CASCADE,
            transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
            legacy_transaction_id INTEGER,
            link_status TEXT NOT NULL
                CHECK (link_status IN ('linked', 'dangling-reference')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_transaction_source_link
                UNIQUE (source_record_id, legacy_transaction_id)
        );

        CREATE INDEX idx_transaction_source_links_transaction_id
            ON transaction_source_links (transaction_id)
            WHERE transaction_id IS NOT NULL;

        CREATE TABLE manual_transaction_dedup_claims (
            deduplication_hash CHAR(64) PRIMARY KEY
                CHECK (deduplication_hash ~ '^[0-9a-f]{64}$'),
            transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    for source_type, table in SOURCE_TABLES:
        op.execute(
            f"""
            DO $copy$
            BEGIN
              IF to_regclass('public.{table}') IS NOT NULL THEN
                EXECUTE $sql$
                  INSERT INTO transaction_source_records
                    (source_type, legacy_source_id, recorded_at, deduplication_hash,
                     raw_csv_line, native_payload, migration_status)
                  SELECT '{source_type}', r.id, COALESCE(r.created_at, now()),
                         NULLIF(to_jsonb(r)->>'deduplication_hash', ''),
                         to_jsonb(r)->>'raw_csv_line', to_jsonb(r), 'unlinked'
                    FROM public.{table} AS r
                  ON CONFLICT (source_type, legacy_source_id) DO NOTHING
                $sql$;
              END IF;
            END $copy$;
            """
        )

    op.execute(
        """
        DO $links$
        BEGIN
          IF to_regclass('public.transaction_raw_references') IS NOT NULL THEN
            INSERT INTO transaction_source_records
              (source_type, legacy_source_id, recorded_at, native_payload, migration_status)
            SELECT rr.raw_source_type, rr.raw_source_id, COALESCE(rr.created_at, now()),
                   jsonb_build_object(
                     'missing_legacy_source', true,
                     'raw_source_type', rr.raw_source_type,
                     'raw_source_id', rr.raw_source_id
                   ),
                   'dangling-reference'
              FROM transaction_raw_references AS rr
              LEFT JOIN transaction_source_records AS existing
                ON existing.source_type = rr.raw_source_type
               AND existing.legacy_source_id = rr.raw_source_id
             WHERE existing.id IS NULL
            ON CONFLICT (source_type, legacy_source_id) DO NOTHING;

            INSERT INTO transaction_source_links
              (source_record_id, transaction_id, legacy_transaction_id, link_status, created_at)
            SELECT sr.id, t.id, rr.transaction_id,
                   CASE WHEN t.id IS NULL THEN 'dangling-reference' ELSE 'linked' END,
                   COALESCE(rr.created_at, now())
              FROM transaction_raw_references AS rr
              JOIN transaction_source_records AS sr
                ON sr.source_type = rr.raw_source_type
               AND sr.legacy_source_id = rr.raw_source_id
              LEFT JOIN transactions AS t ON t.id = rr.transaction_id
            ON CONFLICT (source_record_id, legacy_transaction_id) DO NOTHING;

            UPDATE transaction_source_records AS sr
               SET migration_status = CASE
                     WHEN EXISTS (
                       SELECT 1 FROM transaction_source_links AS sl
                        WHERE sl.source_record_id = sr.id
                          AND sl.link_status = 'linked'
                     ) THEN 'linked'
                     WHEN EXISTS (
                       SELECT 1 FROM transaction_source_links AS sl
                        WHERE sl.source_record_id = sr.id
                          AND sl.link_status = 'dangling-reference'
                     ) THEN 'dangling-reference'
                     ELSE 'unlinked'
                   END;
          END IF;
        END $links$;

        DO $manual$
        BEGIN
          IF to_regclass('public.manual_raw_transactions') IS NOT NULL THEN
            INSERT INTO manual_transaction_dedup_claims
              (deduplication_hash, transaction_id, created_at, updated_at)
            SELECT LOWER(m.deduplication_hash), t.id, m.created_at, m.created_at
              FROM manual_raw_transactions AS m
              LEFT JOIN transactions AS t ON t.id = m.transaction_id
             WHERE m.deduplication_hash ~ '^[0-9a-fA-F]{64}$'
            ON CONFLICT (deduplication_hash) DO UPDATE
              SET transaction_id = EXCLUDED.transaction_id,
                  updated_at = EXCLUDED.updated_at;
          END IF;
        END $manual$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE manual_transaction_dedup_claims;
        DROP TABLE transaction_source_links;
        DROP TABLE transaction_source_records;
        """
    )
