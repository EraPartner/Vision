const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");
const composeFiles = [
  "docker-compose.yml",
  "packaging/electron/resources/docker-compose.yml",
];

test("all Compose PostgreSQL runtimes preload query statistics", () => {
  for (const relativePath of composeFiles) {
    const source = fs.readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.match(source, /shared_preload_libraries=pg_stat_statements/);
  }
});
