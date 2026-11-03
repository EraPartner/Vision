/**
 * Per-file setup: point this test file at its own copy of the migrated
 * template (see sqliteTemplate.ts). Runs before the file imports any backend
 * module, so config/env.ts reads this path. Imports nothing from src/.
 */
import { copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dir = process.env.VISION_TEST_DB_DIR;
const template = process.env.VISION_TEST_DB_TEMPLATE;
if (dir && template) {
  const file = path.join(dir, `test-${process.pid}-${randomUUID()}.sqlite3`);
  copyFileSync(template, file);
  process.env.VISION_DATABASE_PATH = file;
}
