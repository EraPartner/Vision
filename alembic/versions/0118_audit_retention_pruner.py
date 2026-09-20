"""Allow guarded pruning of complete, year-old audit chain prefixes.

Revision ID: 0118_audit_retention_pruner
Revises: 0117_audit_chain

Blast radius: one SECURITY DEFINER function; no table or existing row changes.
The caller must hold an independently authenticated receipt that binds the
pruned predecessor. This function alone cannot authenticate that receipt.
It checks age, continuity, an existing checkpoint, and the boundary hash
under the audit head lock before deleting an entire prefix atomically.

Rollback plan: remove the function only while the genesis entry remains.
After any prefix prune, older application code cannot verify the retained
chain and downgrade must refuse. Never apply to user data without approval.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0118_audit_retention_pruner"
down_revision: Union[str, Sequence[str], None] = "0117_audit_chain"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION audit_chain_prune_prefix(p_through BIGINT, p_hash CHAR(64))
        RETURNS BIGINT
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
          current_head RECORD;
          earliest BIGINT;
          boundary_hash CHAR(64);
          deleted_count BIGINT;
        BEGIN
          SELECT last_sequence, last_hash INTO current_head
            FROM public.audit_chain_head WHERE singleton = true FOR UPDATE;
          IF NOT FOUND OR p_through IS NULL OR p_through < 1 OR
             p_through >= current_head.last_sequence OR
             p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'invalid audit retention boundary';
          END IF;
          SELECT min(sequence) INTO earliest FROM public.audit_chain_entries;
          IF earliest IS NULL OR earliest > p_through + 1 THEN
            RAISE EXCEPTION 'audit retention prefix is incomplete';
          END IF;
          IF earliest = p_through + 1 THEN
            IF NOT EXISTS (
              SELECT 1 FROM public.audit_chain_entries
               WHERE sequence = earliest AND previous_hash = p_hash
            ) THEN
              RAISE EXCEPTION 'audit retention boundary hash changed';
            END IF;
            RETURN 0;
          END IF;
          SELECT entry_hash INTO boundary_hash FROM public.audit_chain_entries
           WHERE sequence = p_through;
          IF boundary_hash IS DISTINCT FROM p_hash OR
             (SELECT count(*) FROM public.audit_chain_entries
               WHERE sequence BETWEEN earliest AND p_through)
               <> p_through - earliest + 1 OR
             EXISTS (SELECT 1 FROM public.audit_chain_entries
               WHERE sequence BETWEEN earliest AND p_through
                 AND created_at >= now() - interval '1 year') OR
             NOT EXISTS (SELECT 1 FROM public.audit_chain_checkpoints
               WHERE sequence >= p_through
                 AND anchor_kind = 'macos_keychain_witness_hmac_v3') THEN
            RAISE EXCEPTION 'audit retention prefix is not eligible';
          END IF;
          ALTER TABLE public.audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable;
          DELETE FROM public.audit_chain_entries WHERE sequence <= p_through;
          GET DIAGNOSTICS deleted_count = ROW_COUNT;
          ALTER TABLE public.audit_chain_entries ENABLE TRIGGER audit_chain_entries_immutable;
          IF deleted_count <> p_through - earliest + 1 OR
             NOT EXISTS (SELECT 1 FROM public.audit_chain_entries
               WHERE sequence = p_through + 1 AND previous_hash = p_hash) THEN
            RAISE EXCEPTION 'audit retention successor is invalid';
          END IF;
          RETURN deleted_count;
        END;
        $$;
        REVOKE ALL ON FUNCTION audit_chain_prune_prefix(BIGINT, CHAR(64)) FROM PUBLIC;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM audit_chain_entries WHERE sequence = 1)
          THEN RAISE EXCEPTION
            'cannot downgrade audit retention after a prefix was pruned';
          END IF;
        END $$;
        DROP FUNCTION audit_chain_prune_prefix(BIGINT, CHAR(64));
        """
    )
