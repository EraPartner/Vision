const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");
const nativeHarnesses = [
  "scripts/with-test-db.sh",
  ".github/scripts/with-native-stack.sh",
];

test("all disposable native PostgreSQL harnesses preload query statistics", () => {
  for (const relativePath of nativeHarnesses) {
    const source = fs.readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.match(source, /shared_preload_libraries[^\n]*pg_stat_statements/);
  }
});

test("GitHub CI installs and verifies PostgreSQL 18", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, ".github/scripts/install-postgres-18.sh"),
    "utf8",
  );
  assert.match(source, /postgresql-18/);
  assert.match(source, /postgres --version/);
});
