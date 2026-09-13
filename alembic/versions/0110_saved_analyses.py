"""Persist versioned reusable analyses and execution runs.

Revision ID: 0110_saved_analyses
Revises: 0109_forward_only_broker_history
Create Date: 2026-09-13

Definitions are append-only versions.  Mutable library metadata points to the
current version and records refresh state, the last usable run, and the latest
failure separately so a failed refresh never destroys a prior result.

Blast radius: three additive tables, their indexes, and one update-protection
trigger.  No existing rows are read or rewritten.  Downgrade drops only these
objects; deleting a saved analysis intentionally cascades through its private
versions and runs.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0110_saved_analyses"
down_revision: Union[str, Sequence[str], None] = "0109_forward_only_broker_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE saved_analyses (
            id TEXT PRIMARY KEY,
            definition_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
            workspace TEXT NOT NULL
                CHECK (workspace IN ('budgeting', 'portfolio', 'research', 'cross-workspace')),
            current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
            refresh_mode TEXT NOT NULL DEFAULT 'live'
                CHECK (refresh_mode IN ('live', 'frozen')),
            parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            charts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            source_references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            refresh_status TEXT NOT NULL DEFAULT 'never-run'
                CHECK (refresh_status IN ('never-run', 'running', 'succeeded', 'failed', 'cancelled')),
            last_successful_run_id TEXT,
            last_error_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE saved_analysis_definition_versions (
            saved_analysis_id TEXT NOT NULL
                REFERENCES saved_analyses(id) ON DELETE CASCADE,
            version INTEGER NOT NULL CHECK (version > 0),
            definition_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (saved_analysis_id, version)
        );

        CREATE OR REPLACE FUNCTION reject_saved_analysis_version_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'saved analysis definition versions are immutable';
        END;
        $$;

        CREATE TRIGGER trg_saved_analysis_version_immutable
            BEFORE UPDATE ON saved_analysis_definition_versions
            FOR EACH ROW EXECUTE FUNCTION reject_saved_analysis_version_update();

        CREATE TABLE saved_analysis_runs (
            id TEXT PRIMARY KEY,
            saved_analysis_id TEXT NOT NULL
                REFERENCES saved_analyses(id) ON DELETE CASCADE,
            definition_version INTEGER NOT NULL CHECK (definition_version > 0),
            status TEXT NOT NULL
                CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
            parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            result_json JSONB,
            error_json JSONB,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK ((status IN ('completed', 'partial')) = (result_json IS NOT NULL)),
            CHECK ((status IN ('failed', 'cancelled')) = (error_json IS NOT NULL)),
            FOREIGN KEY (saved_analysis_id, definition_version)
                REFERENCES saved_analysis_definition_versions(saved_analysis_id, version)
        );

        ALTER TABLE saved_analyses
            ADD CONSTRAINT fk_saved_analyses_last_successful_run
            FOREIGN KEY (last_successful_run_id)
            REFERENCES saved_analysis_runs(id) ON DELETE SET NULL;

        CREATE INDEX idx_saved_analyses_workspace_updated
            ON saved_analyses (workspace, updated_at DESC);
        CREATE INDEX idx_saved_analysis_runs_analysis_created
            ON saved_analysis_runs (saved_analysis_id, created_at DESC);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE saved_analyses
            DROP CONSTRAINT IF EXISTS fk_saved_analyses_last_successful_run;
        DROP TABLE IF EXISTS saved_analysis_runs;
        DROP TRIGGER IF EXISTS trg_saved_analysis_version_immutable
            ON saved_analysis_definition_versions;
        DROP FUNCTION IF EXISTS reject_saved_analysis_version_update();
        DROP TABLE IF EXISTS saved_analysis_definition_versions;
        DROP TABLE IF EXISTS saved_analyses;
        """
    )
