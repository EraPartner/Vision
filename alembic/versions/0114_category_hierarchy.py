"""Add a canonical parent-linked category hierarchy without rekeying assignments.

Revision ID: 0114_category_hierarchy
Revises: 0113_scoped_ai_references

Existing category IDs stay attached to their financial records. One new root is
created for each legacy general name, and existing rows become its children.
The old general/detail pair remains a compatibility projection for old clients.
Downgrade refuses any hierarchy edits that cannot be represented losslessly by
the legacy two-level table.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0114_category_hierarchy"
down_revision: Union[str, Sequence[str], None] = "0113_scoped_ai_references"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM categories
            WHERE btrim(general) = '' OR btrim(detail) = ''
          ) THEN
            RAISE EXCEPTION 'Category hierarchy upgrade needs non-empty legacy general and detail values';
          END IF;
        END $$;

        ALTER TABLE categories
          ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
          ADD COLUMN name TEXT,
          ADD COLUMN hierarchy_only BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN legacy_compatible BOOLEAN NOT NULL DEFAULT true;

        INSERT INTO categories
          (general, detail, name, hierarchy_only, legacy_compatible, is_active)
        SELECT DISTINCT general, '', general, true, false, true
        FROM categories
        ORDER BY general;

        UPDATE categories AS child
        SET parent_id = root.id, name = child.detail
        FROM categories AS root
        WHERE root.hierarchy_only = true
          AND child.hierarchy_only = false
          AND child.general = root.general;

        ALTER TABLE categories
          ALTER COLUMN name SET NOT NULL,
          ADD CONSTRAINT ck_categories_name_nonempty CHECK (btrim(name) <> ''),
          ADD CONSTRAINT ck_categories_not_self_parent CHECK (parent_id IS DISTINCT FROM id),
          ADD CONSTRAINT ck_categories_hierarchy_only_not_legacy
            CHECK (NOT hierarchy_only OR NOT legacy_compatible);

        CREATE UNIQUE INDEX uq_categories_root_name
          ON categories (name) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX uq_categories_sibling_name
          ON categories (parent_id, name) WHERE parent_id IS NOT NULL;
        CREATE INDEX idx_categories_parent_id ON categories (parent_id);

        CREATE TABLE category_merge_aliases (
          general TEXT NOT NULL,
          detail TEXT NOT NULL,
          target_category_id INTEGER NOT NULL
            REFERENCES categories(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (general, detail)
        );
        CREATE INDEX idx_category_merge_aliases_target
          ON category_merge_aliases (target_category_id);

        CREATE TABLE category_root_aliases (
          general TEXT PRIMARY KEY,
          target_category_id INTEGER NOT NULL
            REFERENCES categories(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE FUNCTION category_sync_legacy_row() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        DECLARE root_id INTEGER;
        BEGIN
          IF NOT NEW.legacy_compatible THEN RETURN NEW; END IF;
          IF NEW.general IS NULL OR btrim(NEW.general) = ''
             OR NEW.detail IS NULL OR btrim(NEW.detail) = '' THEN
            RAISE EXCEPTION 'Legacy categories require general and detail'
              USING ERRCODE = 'check_violation';
          END IF;
          IF EXISTS (SELECT 1 FROM category_merge_aliases
                     WHERE general=NEW.general AND detail=NEW.detail) THEN
            RAISE EXCEPTION 'Merged legacy category must be resolved through its alias'
              USING ERRCODE = 'check_violation';
          END IF;
          SELECT id INTO root_id FROM categories
          WHERE parent_id IS NULL AND name = NEW.general;
          IF root_id IS NULL THEN
            SELECT target_category_id INTO root_id FROM category_root_aliases
            WHERE general = NEW.general;
          END IF;
          IF root_id IS NULL THEN
            INSERT INTO categories
              (general, detail, name, hierarchy_only, legacy_compatible, is_active)
            VALUES (NEW.general, '', NEW.general, true, false, true)
            ON CONFLICT (general, detail) DO NOTHING;
            SELECT id INTO root_id FROM categories
            WHERE parent_id IS NULL AND name = NEW.general;
          END IF;
          IF root_id IS NULL THEN
            RAISE EXCEPTION 'Legacy category root could not be resolved'
              USING ERRCODE = 'check_violation';
          END IF;
          NEW.parent_id := root_id;
          NEW.name := NEW.detail;
          RETURN NEW;
        END $fn$;

        CREATE TRIGGER trg_categories_0_sync_legacy
          BEFORE INSERT OR UPDATE OF general, detail ON categories
          FOR EACH ROW EXECUTE FUNCTION category_sync_legacy_row();

        CREATE FUNCTION category_assert_acyclic() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
          PERFORM pg_advisory_xact_lock(1128356178, 1);
          IF EXISTS (
            WITH RECURSIVE ancestors(id, parent_id) AS (
              SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
              UNION ALL
              SELECT p.id, p.parent_id
              FROM categories p JOIN ancestors a ON p.id = a.parent_id
            )
            SELECT 1 FROM ancestors WHERE id = NEW.id
          ) THEN
            RAISE EXCEPTION 'Category hierarchy cycle is not allowed'
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END $fn$;

        CREATE TRIGGER trg_categories_acyclic
          BEFORE INSERT OR UPDATE OF parent_id ON categories
          FOR EACH ROW EXECUTE FUNCTION category_assert_acyclic();

        CREATE VIEW category_paths AS
        WITH RECURSIVE paths AS (
          SELECT id, parent_id, ARRAY[id]::INTEGER[] AS ids,
                 ARRAY[name]::TEXT[] AS names
          FROM categories WHERE parent_id IS NULL
          UNION ALL
          SELECT c.id, c.parent_id, p.ids || c.id, p.names || c.name
          FROM categories c JOIN paths p ON c.parent_id = p.id
        )
        SELECT id, parent_id, ids, names,
               array_to_string(names, ':') AS path_name,
               cardinality(ids) AS depth
        FROM paths;

        CREATE VIEW category_ancestors AS
        WITH RECURSIVE ancestry AS (
          SELECT id AS category_id, id AS ancestor_id, 0 AS distance
          FROM categories
          UNION ALL
          SELECT a.category_id, c.parent_id, a.distance + 1
          FROM ancestry a JOIN categories c ON c.id = a.ancestor_id
          WHERE c.parent_id IS NOT NULL
        )
        SELECT category_id, ancestor_id, distance FROM ancestry;

        ALTER TABLE categories ADD COLUMN path_name TEXT;
        UPDATE categories c SET path_name=p.path_name
        FROM category_paths p WHERE p.id=c.id;
        ALTER TABLE categories ALTER COLUMN path_name SET NOT NULL;
        -- The AFTER trigger computes the full path for new rows. A temporary
        -- non-null default lets the row be inserted before that trigger runs.
        ALTER TABLE categories ALTER COLUMN path_name SET DEFAULT '';

        CREATE FUNCTION category_refresh_path_names() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          WITH RECURSIVE affected(id, path_name) AS (
            SELECT NEW.id,
                   CASE WHEN NEW.parent_id IS NULL THEN NEW.name
                        ELSE parent.path_name || ':' || NEW.name END
            FROM (SELECT 1) AS seed
            LEFT JOIN categories parent ON parent.id = NEW.parent_id
            UNION ALL
            SELECT child.id, affected.path_name || ':' || child.name
            FROM categories child JOIN affected ON child.parent_id = affected.id
          )
          UPDATE categories c SET path_name=affected.path_name
          FROM affected WHERE c.id=affected.id;
          RETURN NEW;
        END $fn$;

        CREATE TRIGGER trg_categories_refresh_path_names
          AFTER INSERT OR UPDATE OF name, parent_id ON categories
          FOR EACH ROW EXECUTE FUNCTION category_refresh_path_names();

        CREATE VIEW vision_analysis.transactions_v2
        WITH (security_barrier = true) AS
        SELECT v1.*, c.path_name AS category_path,
               p.names AS category_path_segments,
               p.ids AS category_path_ids
        FROM vision_analysis.transactions_v1 v1
        LEFT JOIN public.categories c ON c.id = v1.category_id
        LEFT JOIN public.category_paths p ON p.id = v1.category_id;

        CREATE VIEW vision_analysis.cash_flows_v2
        WITH (security_barrier = true) AS
        SELECT v1.*, c.path_name AS category_path,
               p.names AS category_path_segments,
               p.ids AS category_path_ids
        FROM vision_analysis.cash_flows_v1 v1
        LEFT JOIN public.categories c ON c.id = v1.category_id
        LEFT JOIN public.category_paths p ON p.id = v1.category_id;
        REVOKE ALL ON vision_analysis.transactions_v2,
                      vision_analysis.cash_flows_v2 FROM PUBLIC;
        """
    )
    # destructive-ok: both projections contain derived category display names.
    # Runtime startup recreates and refreshes them from unchanged transaction IDs.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_category_totals CASCADE;")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE
          reference RECORD;
          has_root_reference BOOLEAN;
        BEGIN
          IF EXISTS (SELECT 1 FROM category_merge_aliases)
             OR EXISTS (SELECT 1 FROM category_root_aliases)
             OR EXISTS (SELECT 1 FROM categories WHERE NOT legacy_compatible AND NOT hierarchy_only)
             OR EXISTS (
               SELECT 1 FROM categories child
               LEFT JOIN categories root ON root.id = child.parent_id
               WHERE child.legacy_compatible
                 AND (root.id IS NULL OR NOT root.hierarchy_only
                      OR root.parent_id IS NOT NULL
                      OR child.general <> root.name
                      OR child.detail <> child.name)
             )
             OR EXISTS (
               SELECT 1 FROM categories root
               WHERE root.hierarchy_only
                 AND (root.parent_id IS NOT NULL OR root.detail <> ''
                      OR root.name <> root.general)
             ) THEN
            RAISE EXCEPTION 'Category hierarchy contains edits that cannot be represented by legacy general/detail; restore a compatible state before downgrade';
          END IF;

          FOR reference IN
            SELECT con.conrelid::regclass AS table_name,
                   att.attname AS column_name
            FROM pg_constraint con
            JOIN pg_attribute att
              ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
            WHERE con.contype = 'f'
              AND con.confrelid = 'categories'::regclass
              AND con.conrelid <> 'categories'::regclass
              AND cardinality(con.conkey) = 1
          LOOP
            EXECUTE format(
              'SELECT EXISTS (SELECT 1 FROM %s AS ref JOIN categories AS root ON ref.%I = root.id WHERE root.hierarchy_only)',
              reference.table_name, reference.column_name
            ) INTO has_root_reference;
            IF has_root_reference THEN
              RAISE EXCEPTION 'Category hierarchy root is assigned through %.%; downgrade would lose data',
                reference.table_name, reference.column_name;
            END IF;
          END LOOP;
        END $$;

        -- destructive-ok: derived category display projections are rebuilt
        -- by old application code on the next boot after downgrade.
        DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_category_totals CASCADE;

        DROP VIEW vision_analysis.cash_flows_v2;
        DROP VIEW vision_analysis.transactions_v2;
        DROP TABLE category_root_aliases;
        DROP TABLE category_merge_aliases;
        DROP VIEW category_ancestors;
        DROP VIEW category_paths;
        DROP TRIGGER trg_categories_refresh_path_names ON categories;
        DROP FUNCTION category_refresh_path_names();
        DROP TRIGGER trg_categories_0_sync_legacy ON categories;
        DROP FUNCTION category_sync_legacy_row();
        DROP TRIGGER trg_categories_acyclic ON categories;
        DROP FUNCTION category_assert_acyclic();
        UPDATE categories SET parent_id = NULL WHERE legacy_compatible;
        DELETE FROM categories WHERE hierarchy_only = true;
        DROP INDEX idx_categories_parent_id;
        DROP INDEX uq_categories_sibling_name;
        DROP INDEX uq_categories_root_name;
        ALTER TABLE categories
          DROP CONSTRAINT ck_categories_hierarchy_only_not_legacy,
          DROP CONSTRAINT ck_categories_not_self_parent,
          DROP CONSTRAINT ck_categories_name_nonempty,
          DROP COLUMN legacy_compatible,
          DROP COLUMN hierarchy_only,
          DROP COLUMN path_name,
          DROP COLUMN name,
          DROP COLUMN parent_id;
        """
    )
