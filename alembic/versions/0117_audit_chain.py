"""Add a transactional, append-only audit hash chain foundation.

Revision ID: 0117_audit_chain
Revises: 0116_analysis_monitors

Blast radius: three new tables, two indexes, one trigger function and removal
of split_audit's ON DELETE SET NULL foreign key. No existing data is rewritten.
The split ID remains as immutable provenance after a split is deleted. The
head row serializes application appends. The
checkpoint table records receipts made by an independent anchor, but is not
itself an independent anchor. The application must exclude these tables from
the raw DB editor and must verify against an external checkpoint to detect a
privileged rewrite or rollback.

Rollback plan: only the unused 0117 install with its single expected migration
entry, matching head and legacy high-water marks, and no checkpoint can
downgrade. Any other history refuses downgrade. Preserve a verified export and
use an approved restore of the pre-upgrade backup, or a separate reviewed
data-preservation contract. This migration must not be applied to user data
without approval.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0117_audit_chain"
down_revision: Union[str, Sequence[str], None] = "0116_analysis_monitors"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # destructive-ok: dropping this FK preserves the existing split_id bytes and prevents
    # future split deletions from changing audit evidence; 0117 forward-only audit contract.
    op.execute("ALTER TABLE split_audit DROP CONSTRAINT split_audit_split_id_fkey")
    op.execute(
        """
        CREATE TABLE audit_chain_head (
            singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
            last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
            last_hash CHAR(64) NOT NULL DEFAULT repeat('0', 64)
                CHECK (last_hash ~ '^[0-9a-f]{64}$'),
            legacy_db_editor_max_id BIGINT NOT NULL CHECK (legacy_db_editor_max_id >= 0),
            legacy_split_max_id BIGINT NOT NULL CHECK (legacy_split_max_id >= 0),
            legacy_retag_max_id BIGINT NOT NULL CHECK (legacy_retag_max_id >= 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (last_sequence <> 0 OR last_hash = repeat('0', 64))
        );
        INSERT INTO audit_chain_head (
            singleton, legacy_db_editor_max_id, legacy_split_max_id,
            legacy_retag_max_id
        ) SELECT true,
            COALESCE((SELECT MAX(id) FROM db_editor_audit), 0),
            COALESCE((SELECT MAX(id) FROM split_audit), 0),
            COALESCE((SELECT MAX(id) FROM portfolio_retag_audit), 0);

        CREATE TABLE audit_chain_entries (
            sequence BIGINT PRIMARY KEY CHECK (sequence > 0),
            version SMALLINT NOT NULL CHECK (version > 0),
            previous_hash CHAR(64) NOT NULL
                CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
            entry_hash CHAR(64) NOT NULL
                CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
            payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_audit_chain_entries_created_at
            ON audit_chain_entries (created_at, sequence);

        CREATE TABLE audit_chain_checkpoints (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            sequence BIGINT NOT NULL CHECK (sequence >= 0),
            head_hash CHAR(64) NOT NULL
                CHECK (head_hash ~ '^[0-9a-f]{64}$'),
            anchor_kind TEXT NOT NULL CHECK (length(anchor_kind) BETWEEN 1 AND 100),
            receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 300),
            receipt_hash CHAR(64) NOT NULL
                CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (anchor_kind, receipt_id)
        );
        CREATE INDEX idx_audit_chain_checkpoints_sequence
            ON audit_chain_checkpoints (sequence DESC, id DESC);

        CREATE FUNCTION audit_chain_reject_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'audit chain history is append-only';
        END $$;
        CREATE TRIGGER audit_chain_entries_immutable
            BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_chain_entries
            FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_reject_mutation();
        CREATE TRIGGER audit_chain_checkpoints_immutable
            BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_chain_checkpoints
            FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_reject_mutation();
        CREATE TRIGGER audit_chain_head_no_delete
            BEFORE DELETE OR TRUNCATE ON audit_chain_head
            FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_reject_mutation();
        """
    )


def downgrade() -> None:
    op.execute(
        """
        -- Hold these locks through Alembic's transaction commit. Domain
        -- writers take a domain table before the chain head, so acquire in
        -- that order; no append may race the guard and subsequent DROP.
        LOCK TABLE db_editor_audit, split_audit, portfolio_retag_audit
            IN ACCESS EXCLUSIVE MODE;
        LOCK TABLE audit_chain_head, audit_chain_entries,
            audit_chain_checkpoints IN ACCESS EXCLUSIVE MODE;
        DO $$ BEGIN
            -- The online Alembic callback records 0117's own upgrade in the
            -- same transaction. This one exact entry is the only disposable
            -- history allowed on downgrade. Its hash is hashAuditEntry v1 of
            -- {direction:'upgrade',event:'revision_applied',
            --  heads:['0117_audit_chain'],revision:'0117_audit_chain',
            --  stream:'schema_migration'} at sequence 1 and genesis predecessor.
            IF EXISTS (SELECT 1 FROM audit_chain_checkpoints)
                OR (SELECT COUNT(*) FROM audit_chain_entries) <> 1
                OR NOT EXISTS (
                    SELECT 1 FROM audit_chain_entries
                    WHERE sequence = 1
                      AND version = 1
                      AND previous_hash = repeat('0', 64)
                      AND entry_hash =
                        '3ba734e0082640c23c8771b1b57525b440136602d25ca20fd5e0798e406e6563'
                      AND payload = '{"direction":"upgrade","event":"revision_applied","heads":["0117_audit_chain"],"revision":"0117_audit_chain","stream":"schema_migration"}'::jsonb
                )
                OR NOT EXISTS (
                    SELECT 1 FROM audit_chain_head
                    WHERE singleton = true
                      AND last_sequence = 1
                      AND last_hash =
                        '3ba734e0082640c23c8771b1b57525b440136602d25ca20fd5e0798e406e6563'
                      AND legacy_db_editor_max_id =
                        COALESCE((SELECT MAX(id) FROM db_editor_audit), 0)
                      AND legacy_split_max_id =
                        COALESCE((SELECT MAX(id) FROM split_audit), 0)
                      AND legacy_retag_max_id =
                        COALESCE((SELECT MAX(id) FROM portfolio_retag_audit), 0)
                ) THEN
                RAISE EXCEPTION
                    'cannot downgrade 0117 after audit activity or checkpoint; use reviewed restore or preservation contract';
            END IF;
        END $$;
        DROP TABLE audit_chain_checkpoints;
        DROP TABLE audit_chain_entries;
        DROP TABLE audit_chain_head;
        DROP FUNCTION audit_chain_reject_mutation();
        ALTER TABLE split_audit
          ADD CONSTRAINT split_audit_split_id_fkey
          FOREIGN KEY (split_id) REFERENCES transaction_splits(id)
          ON DELETE SET NULL;
        """
    )
