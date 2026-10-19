-- Alembic 0128_category_path_on_legacy_rename, kept so a database stopped at
-- 0126 or 0127 can be adopted onto 0001_baseline (ADR-222). Applied only by the
-- adoption bridge in apps/node-backend/src/database/migrate.ts. Never edit.
DROP TRIGGER trg_categories_refresh_path_names ON categories;
CREATE TRIGGER trg_categories_refresh_path_names
  AFTER INSERT OR UPDATE OF name, parent_id, general, detail ON categories
  FOR EACH ROW EXECUTE FUNCTION category_refresh_path_names();

UPDATE categories c SET path_name = p.path_name
FROM category_paths p
WHERE p.id = c.id AND c.path_name IS DISTINCT FROM p.path_name;
