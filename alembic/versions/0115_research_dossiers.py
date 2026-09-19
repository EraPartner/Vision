"""Add versioned local research dossiers and deletion-safe links.

Revision ID: 0115_research_dossiers
Revises: 0114_category_hierarchy
Create Date: 2026-09-19

Upgrade is additive. Downgrade is guarded: it refuses to discard any dossier.
The backup registry must include all three tables before deployment.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0115_research_dossiers"
down_revision: Union[str, Sequence[str], None] = "0114_category_hierarchy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE research_dossiers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            workspace TEXT NOT NULL CHECK (workspace IN
                ('budgeting','portfolio','research','cross-workspace')),
            title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
            content_json JSONB NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_research_dossiers_workspace_updated
            ON research_dossiers (workspace, updated_at DESC, id);

        CREATE TABLE research_dossier_versions (
            dossier_id UUID NOT NULL REFERENCES research_dossiers(id) ON DELETE CASCADE,
            version INTEGER NOT NULL CHECK (version > 0),
            snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (dossier_id, version)
        );
        CREATE FUNCTION reject_research_dossier_version_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'research dossier versions are immutable';
        END;
        $$;
        CREATE TRIGGER trg_research_dossier_version_immutable
            BEFORE UPDATE ON research_dossier_versions
            FOR EACH ROW EXECUTE FUNCTION reject_research_dossier_version_update();

        CREATE TABLE research_dossier_links (
            dossier_id UUID NOT NULL REFERENCES research_dossiers(id) ON DELETE CASCADE,
            link_type TEXT NOT NULL CHECK (link_type IN ('category','investment','saved-analysis')),
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            historical_id TEXT NOT NULL CHECK (length(historical_id) BETWEEN 1 AND 100),
            label_snapshot TEXT NOT NULL CHECK (length(label_snapshot) BETWEEN 1 AND 500),
            category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            investment_id INTEGER REFERENCES investments(id) ON DELETE SET NULL,
            saved_analysis_id TEXT REFERENCES saved_analyses(id) ON DELETE SET NULL,
            PRIMARY KEY (dossier_id, link_type, ordinal),
            CHECK (
                (link_type = 'category' AND investment_id IS NULL AND saved_analysis_id IS NULL)
                OR (link_type = 'investment' AND category_id IS NULL AND saved_analysis_id IS NULL)
                OR (link_type = 'saved-analysis' AND category_id IS NULL AND investment_id IS NULL)
            )
        );
        CREATE INDEX idx_research_dossier_links_category
            ON research_dossier_links (category_id) WHERE category_id IS NOT NULL;
        CREATE INDEX idx_research_dossier_links_investment
            ON research_dossier_links (investment_id) WHERE investment_id IS NOT NULL;
        CREATE INDEX idx_research_dossier_links_saved_analysis
            ON research_dossier_links (saved_analysis_id) WHERE saved_analysis_id IS NOT NULL;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM research_dossiers) THEN
                RAISE EXCEPTION 'cannot downgrade 0115: export and remove research dossiers first';
            END IF;
        END $$;
        DROP TABLE research_dossier_links;
        DROP TRIGGER trg_research_dossier_version_immutable ON research_dossier_versions;
        DROP FUNCTION reject_research_dossier_version_update();
        DROP TABLE research_dossier_versions;
        DROP TABLE research_dossiers;
        """
    )
