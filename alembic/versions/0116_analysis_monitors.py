"""Persist local analysis and dossier monitor observations and inbox episodes.

Revision ID: 0116_analysis_monitors
Revises: 0115_research_dossiers

Additive upgrade. Downgrade refuses to discard monitors or notifications. A
target deletion retains its monitor, observations, and inbox with a null live
foreign key and its original target identity/label.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0116_analysis_monitors"
down_revision: Union[str, Sequence[str], None] = "0115_research_dossiers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE analysis_monitors (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            kind TEXT NOT NULL CHECK (kind IN ('analysis-threshold','dossier-evidence')),
            title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
            enabled BOOLEAN NOT NULL DEFAULT true,
            saved_analysis_id TEXT REFERENCES saved_analyses(id) ON DELETE SET NULL,
            dossier_id UUID REFERENCES research_dossiers(id) ON DELETE SET NULL,
            historical_target_id TEXT NOT NULL CHECK (length(historical_target_id) BETWEEN 1 AND 100),
            target_label TEXT NOT NULL CHECK (length(target_label) BETWEEN 1 AND 300),
            field_id TEXT,
            operator TEXT CHECK (operator IN ('above','below')),
            threshold NUMERIC,
            interval_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 15 AND 10080),
            cooldown_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (cooldown_minutes BETWEEN 0 AND 10080),
            next_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_checked_at TIMESTAMPTZ,
            last_status TEXT,
            condition_revision INTEGER NOT NULL DEFAULT 1 CHECK (condition_revision > 0),
            active_episode_key UUID,
            pending_signature TEXT,
            pending_since TIMESTAMPTZ,
            last_notified_at TIMESTAMPTZ,
            lease_token UUID,
            lease_expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
            CHECK (
                (kind = 'analysis-threshold' AND dossier_id IS NULL AND
                    field_id IS NOT NULL AND length(field_id) BETWEEN 1 AND 100 AND
                    operator IS NOT NULL AND threshold IS NOT NULL)
                OR
                (kind = 'dossier-evidence' AND saved_analysis_id IS NULL AND
                    field_id IS NULL AND operator IS NULL AND threshold IS NULL)
            )
        );
        CREATE INDEX idx_analysis_monitors_due
            ON analysis_monitors (next_due_at, id) WHERE enabled;
        CREATE INDEX idx_analysis_monitors_saved_analysis
            ON analysis_monitors (saved_analysis_id) WHERE saved_analysis_id IS NOT NULL;
        CREATE INDEX idx_analysis_monitors_dossier
            ON analysis_monitors (dossier_id) WHERE dossier_id IS NOT NULL;

        CREATE TABLE analysis_monitor_observations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            monitor_id UUID NOT NULL REFERENCES analysis_monitors(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN
                ('baseline','unchanged','triggered','cooldown-pending','partial','stale','failed')),
            previous_value TEXT,
            current_value TEXT,
            previous_evidence_version INTEGER,
            current_evidence_version INTEGER,
            evidence_hash TEXT,
            condition_revision INTEGER NOT NULL CHECK (condition_revision > 0),
            analysis_definition_version INTEGER,
            analysis_run_id TEXT REFERENCES saved_analysis_runs(id) ON DELETE SET NULL,
            historical_analysis_run_id TEXT,
            analysis_run_status TEXT,
            analysis_window_json JSONB,
            coverage_json JSONB NOT NULL DEFAULT '{"status":"unknown"}'::jsonb
                CHECK (jsonb_typeof(coverage_json) = 'object'),
            reason_code TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
            checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK ((status IN ('baseline','unchanged','triggered','cooldown-pending')
                AND (current_value IS NOT NULL OR evidence_hash IS NOT NULL))
                OR status IN ('partial','stale','failed'))
        );
        CREATE INDEX idx_analysis_monitor_observations_history
            ON analysis_monitor_observations (monitor_id, checked_at DESC, id DESC);

        CREATE TABLE analysis_monitor_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            monitor_id UUID NOT NULL REFERENCES analysis_monitors(id) ON DELETE CASCADE,
            observation_id UUID NOT NULL UNIQUE REFERENCES analysis_monitor_observations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('analysis-threshold','dossier-evidence')),
            title TEXT NOT NULL,
            reason_code TEXT NOT NULL,
            reason TEXT NOT NULL,
            previous_value TEXT,
            current_value TEXT,
            episode_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            read_at TIMESTAMPTZ,
            UNIQUE (monitor_id, episode_key)
        );
        CREATE INDEX idx_analysis_monitor_notifications_inbox
            ON analysis_monitor_notifications (created_at DESC, id DESC);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM analysis_monitors)
               OR EXISTS (SELECT 1 FROM analysis_monitor_notifications) THEN
                RAISE EXCEPTION 'cannot downgrade 0116: export and remove monitors first';
            END IF;
        END $$;
        DROP TABLE analysis_monitor_notifications;
        DROP TABLE analysis_monitor_observations;
        DROP TABLE analysis_monitors;
        """
    )
