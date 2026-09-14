"""Add local AI research, recoverable jobs, and cloud disclosure records.

Revision ID: 0111_ai_research_investigations
Revises: 0110_saved_analyses
Create Date: 2026-09-13

All objects are additive. Document text and investigation results remain local.
Disclosure records store bounded metadata and a payload digest, never the exact
outbound payload or credentials. Grant/request budget reservations are updated
transactionally by the application. Downgrade removes only these new objects.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0111_ai_research_investigations"
down_revision: Union[str, Sequence[str], None] = "0110_saved_analyses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE saved_analysis_definition_versions
            ADD COLUMN state_json JSONB;

        CREATE TABLE ai_research_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
            source_name TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 500),
            media_type TEXT NOT NULL,
            content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            extraction_status TEXT NOT NULL
                CHECK (extraction_status IN ('ready', 'failed', 'unsupported')),
            extraction_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (source_name, content_sha256),
            UNIQUE (source_name, version)
        );

        CREATE TABLE ai_research_passages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID NOT NULL REFERENCES ai_research_documents(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            page_number INTEGER CHECK (page_number > 0),
            section TEXT,
            content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
            embedding_json JSONB,
            search_vector TSVECTOR GENERATED ALWAYS AS
                (to_tsvector('simple', coalesce(section, '') || ' ' || content)) STORED,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (document_id, ordinal)
        );
        CREATE INDEX idx_ai_research_passages_document
            ON ai_research_passages (document_id, ordinal);
        CREATE INDEX idx_ai_research_passages_search
            ON ai_research_passages USING GIN (search_vector);

        CREATE TABLE ai_investigation_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
            question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 8000),
            route TEXT NOT NULL CHECK (route IN ('local', 'openai-api')),
            model TEXT,
            depth TEXT NOT NULL CHECK (depth IN ('quick', 'detailed')),
            language TEXT NOT NULL CHECK (language IN ('en', 'nl')),
            state TEXT NOT NULL CHECK
                (state IN ('queued', 'running', 'waiting', 'partial', 'completed', 'failed', 'cancelled')),
            scope_json JSONB NOT NULL,
            plan_json JSONB,
            checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            result_json JSONB,
            error_json JSONB,
            grant_id UUID,
            cancel_requested_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_ai_investigation_jobs_state_updated
            ON ai_investigation_jobs (state, updated_at DESC);

        CREATE TABLE ai_investigation_steps (
            job_id UUID NOT NULL REFERENCES ai_investigation_jobs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL CHECK (length(step_id) BETWEEN 1 AND 64),
            state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
            attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
            result_json JSONB,
            error_json JSONB,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (job_id, step_id)
        );

        CREATE TABLE ai_disclosure_grants (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            route TEXT NOT NULL CHECK (route = 'openai-api'),
            mode TEXT NOT NULL CHECK
                (mode IN ('cloud-plan-public', 'selected-summary', 'cloud-synthesis-selected')),
            purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
            preview_payload_sha256 TEXT NOT NULL CHECK (preview_payload_sha256 ~ '^[0-9a-f]{64}$'),
            allowed_fields_json JSONB NOT NULL,
            max_requests INTEGER NOT NULL CHECK (max_requests BETWEEN 1 AND 50),
            max_input_characters INTEGER NOT NULL CHECK (max_input_characters BETWEEN 100 AND 200000),
            max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 32000),
            max_cost_micros BIGINT NOT NULL CHECK (max_cost_micros >= 0),
            max_disclosure_units INTEGER NOT NULL CHECK (max_disclosure_units BETWEEN 1 AND 10000),
            used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
            used_input_characters BIGINT NOT NULL DEFAULT 0 CHECK (used_input_characters >= 0),
            used_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_output_tokens >= 0),
            used_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (used_cost_micros >= 0),
            policy_version INTEGER NOT NULL DEFAULT 1,
            retain_exact_payload BOOLEAN NOT NULL DEFAULT false CHECK (retain_exact_payload = false),
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        ALTER TABLE ai_investigation_jobs
            ADD CONSTRAINT fk_ai_investigation_jobs_grant
            FOREIGN KEY (grant_id) REFERENCES ai_disclosure_grants(id) ON DELETE SET NULL;

        CREATE TABLE ai_disclosure_records (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            grant_id UUID NOT NULL REFERENCES ai_disclosure_grants(id) ON DELETE CASCADE,
            job_id UUID REFERENCES ai_investigation_jobs(id) ON DELETE SET NULL,
            route TEXT NOT NULL,
            mode TEXT NOT NULL,
            purpose TEXT NOT NULL,
            field_manifest_json JSONB NOT NULL,
            disclosure_units_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
            payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
            reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
            reserved_cost_micros BIGINT NOT NULL CHECK (reserved_cost_micros >= 0),
            actual_input_tokens INTEGER,
            actual_output_tokens INTEGER,
            actual_cost_micros BIGINT,
            status TEXT NOT NULL CHECK
                (status IN ('authorized', 'sent', 'completed', 'failed', 'cancelled', 'blocked')),
            provider_request_id TEXT,
            policy_snapshot_json JSONB NOT NULL,
            error_code TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at TIMESTAMPTZ
        );
        CREATE INDEX idx_ai_disclosure_records_grant_created
            ON ai_disclosure_records (grant_id, created_at DESC);
        CREATE INDEX idx_ai_disclosure_records_job_created
            ON ai_disclosure_records (job_id, created_at DESC);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS ai_disclosure_records;
        ALTER TABLE ai_investigation_jobs
            DROP CONSTRAINT IF EXISTS fk_ai_investigation_jobs_grant;
        DROP TABLE IF EXISTS ai_disclosure_grants;
        DROP TABLE IF EXISTS ai_investigation_steps;
        DROP TABLE IF EXISTS ai_investigation_jobs;
        DROP TABLE IF EXISTS ai_research_passages;
        DROP TABLE IF EXISTS ai_research_documents;
        ALTER TABLE saved_analysis_definition_versions
            DROP COLUMN IF EXISTS state_json;
        """
    )
