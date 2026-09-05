const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("devcontainer setup keeps platform-specific state off the host workspace", () => {
  const launcher = source(".devcontainer/bin/claude");
  const postCreate = source(".devcontainer/post-create.sh");

  for (const mount of [
    "venv",
    "node_modules",
    "apps/frontend/node_modules",
    "apps/node-backend/node_modules",
    "packages/shared-utils/node_modules",
    "packages/types/node_modules",
    "packaging/electron/node_modules",
  ]) {
    assert.match(
      launcher,
      new RegExp(`dep_volume\\s+[^\\n]+\\s+${mount.replaceAll("/", "\\/")}`),
    );
  }

  assert.doesNotMatch(
    postCreate,
    /(?:cat|tee|touch|cp|mv)[^\n]*\s\.env(?:\s|$)/,
  );
  assert.doesNotMatch(postCreate, />\s*\.env(?:\s|$)/);
  assert.match(launcher, /-e DATABASE_URL=/);
  assert.match(launcher, /-e POSTGRES_PASSWORD=/);
});
