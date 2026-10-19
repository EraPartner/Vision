"""Refresh category paths when a legacy category is renamed.

Renaming a legacy category updates only general/detail. The BEFORE trigger
then rewrites name and parent_id, but PostgreSQL fires UPDATE OF column
triggers only for columns named in the statement, so the path trigger
(UPDATE OF name, parent_id) never ran and path_name kept the old path.

Blast radius: the categories path trigger and stale path_name values. The
repair rewrites path_name only where it differs from the computed hierarchy
path; no amounts, ids or links change. Rollback restores the 0114 trigger
column list and keeps the repaired paths, which are correct under either
trigger. Never run against user data without approval.
"""

from alembic import op

revision = "0128_category_path_on_legacy_rename"
down_revision = "0127_bank_chronology"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      DROP TRIGGER trg_categories_refresh_path_names ON categories;
      CREATE TRIGGER trg_categories_refresh_path_names
        AFTER INSERT OR UPDATE OF name, parent_id, general, detail ON categories
        FOR EACH ROW EXECUTE FUNCTION category_refresh_path_names();

      UPDATE categories c SET path_name = p.path_name
      FROM category_paths p
      WHERE p.id = c.id AND c.path_name IS DISTINCT FROM p.path_name;
    """)


def downgrade() -> None:
    op.execute("""
      DROP TRIGGER trg_categories_refresh_path_names ON categories;
      CREATE TRIGGER trg_categories_refresh_path_names
        AFTER INSERT OR UPDATE OF name, parent_id ON categories
        FOR EACH ROW EXECUTE FUNCTION category_refresh_path_names();
    """)
