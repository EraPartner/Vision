"""Normalize saved-chart filter memberships with foreign keys.

Revision ID: 0096_normalize_saved_chart_filters
Revises: 0095_enable_pg_stat_statements
Create Date: 2026-09-04

PostgreSQL cannot enforce foreign keys for elements inside INTEGER[] columns.
Move category, recipient, and tag selections into ordinary membership tables.
The repository continues to expose the existing array-shaped API contract.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0096_normalize_saved_chart_filters"
down_revision: Union[str, Sequence[str], None] = "0095_enable_pg_stat_statements"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE saved_chart_categories (
          saved_chart_id INTEGER NOT NULL,
          category_id INTEGER NOT NULL,
          CONSTRAINT pk_saved_chart_categories
            PRIMARY KEY (saved_chart_id, category_id),
          CONSTRAINT fk_saved_chart_categories_chart
            FOREIGN KEY (saved_chart_id)
            REFERENCES saved_charts(id) ON DELETE CASCADE,
          CONSTRAINT fk_saved_chart_categories_entity
            FOREIGN KEY (category_id)
            REFERENCES categories(id) ON DELETE CASCADE
        );

        INSERT INTO saved_chart_categories (saved_chart_id, category_id)
        SELECT DISTINCT sc.id, category.id
        FROM saved_charts sc
        CROSS JOIN LATERAL unnest(sc.category_ids) AS selected(id)
        JOIN categories category ON category.id = selected.id;

        CREATE INDEX idx_saved_chart_categories_category
          ON saved_chart_categories (category_id);

        CREATE TABLE saved_chart_recipients (
          saved_chart_id INTEGER NOT NULL,
          recipient_id INTEGER NOT NULL,
          CONSTRAINT pk_saved_chart_recipients
            PRIMARY KEY (saved_chart_id, recipient_id),
          CONSTRAINT fk_saved_chart_recipients_chart
            FOREIGN KEY (saved_chart_id)
            REFERENCES saved_charts(id) ON DELETE CASCADE,
          CONSTRAINT fk_saved_chart_recipients_entity
            FOREIGN KEY (recipient_id)
            REFERENCES recipients(id) ON DELETE CASCADE
        );

        INSERT INTO saved_chart_recipients (saved_chart_id, recipient_id)
        SELECT DISTINCT sc.id, recipient.id
        FROM saved_charts sc
        CROSS JOIN LATERAL unnest(sc.recipient_ids) AS selected(id)
        JOIN recipients recipient ON recipient.id = selected.id;

        CREATE INDEX idx_saved_chart_recipients_recipient
          ON saved_chart_recipients (recipient_id);

        CREATE TABLE saved_chart_tags (
          saved_chart_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          CONSTRAINT pk_saved_chart_tags
            PRIMARY KEY (saved_chart_id, tag_id),
          CONSTRAINT fk_saved_chart_tags_chart
            FOREIGN KEY (saved_chart_id)
            REFERENCES saved_charts(id) ON DELETE CASCADE,
          CONSTRAINT fk_saved_chart_tags_entity
            FOREIGN KEY (tag_id)
            REFERENCES tags(id) ON DELETE CASCADE
        );

        INSERT INTO saved_chart_tags (saved_chart_id, tag_id)
        SELECT DISTINCT sc.id, tag.id
        FROM saved_charts sc
        CROSS JOIN LATERAL unnest(sc.tag_ids) AS selected(id)
        JOIN tags tag ON tag.id = selected.id;

        CREATE INDEX idx_saved_chart_tags_tag
          ON saved_chart_tags (tag_id);
        """
    )

    # destructive-ok: every valid membership was backfilled into constrained
    # tables above. Pre-existing dangling array elements are intentionally
    # pruned because they cannot identify a live filter entity.
    op.execute(
        """
        ALTER TABLE saved_charts
          DROP COLUMN category_ids,
          DROP COLUMN recipient_ids,
          DROP COLUMN tag_ids;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE saved_charts
          ADD COLUMN category_ids INTEGER[] NOT NULL DEFAULT '{}',
          ADD COLUMN recipient_ids INTEGER[] NOT NULL DEFAULT '{}',
          ADD COLUMN tag_ids INTEGER[] NOT NULL DEFAULT '{}';
        """
    )

    op.execute(
        """
        UPDATE saved_charts sc
        SET category_ids = memberships.ids
        FROM (
          SELECT saved_chart_id,
                 array_agg(category_id ORDER BY category_id) AS ids
          FROM saved_chart_categories
          GROUP BY saved_chart_id
        ) memberships
        WHERE memberships.saved_chart_id = sc.id;

        UPDATE saved_charts sc
        SET recipient_ids = memberships.ids
        FROM (
          SELECT saved_chart_id,
                 array_agg(recipient_id ORDER BY recipient_id) AS ids
          FROM saved_chart_recipients
          GROUP BY saved_chart_id
        ) memberships
        WHERE memberships.saved_chart_id = sc.id;

        UPDATE saved_charts sc
        SET tag_ids = memberships.ids
        FROM (
          SELECT saved_chart_id,
                 array_agg(tag_id ORDER BY tag_id) AS ids
          FROM saved_chart_tags
          GROUP BY saved_chart_id
        ) memberships
        WHERE memberships.saved_chart_id = sc.id;

        DROP TABLE saved_chart_tags;
        DROP TABLE saved_chart_recipients;
        DROP TABLE saved_chart_categories;
        """
    )
