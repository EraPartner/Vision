import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const nativeHarnesses = [
  "scripts/with-test-db.sh",
  ".github/scripts/with-native-stack.sh",
];

void test("all disposable native PostgreSQL harnesses preload query statistics", () => {
  for (const relativePath of nativeHarnesses) {
    const source = fs.readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.match(source, /shared_preload_libraries[^\n]*pg_stat_statements/);
  }
});

void test("GitHub CI installs and verifies PostgreSQL 18", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, ".github/scripts/install-postgres-18.sh"),
    "utf8",
  );
  assert.match(source, /postgresql-18/);
  assert.match(source, /postgres --version/);
});
