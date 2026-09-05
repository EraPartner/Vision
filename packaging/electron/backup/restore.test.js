"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { assertBackupSchemaCompatible } = require("./restore");

test("restore rejects a backup created on a newer Vision schema", () => {
  assert.throws(
    () =>
      assertBackupSchemaCompatible(
        "0072_future_revision",
        "0071_current_revision",
      ),
    (error) =>
      error instanceof Error &&
      error.message.startsWith("BUNDLE_SCHEMA_NEWER:") &&
      error.message.includes("0072_future_revision") &&
      error.message.includes("0071_current_revision"),
  );
});

test("restore accepts equal and older Vision schema revisions", () => {
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible(
      "0071_current_revision",
      "0071_current_revision",
    ),
  );
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible(
      "0070_previous_revision",
      "0071_current_revision",
    ),
  );
});

test("restore does not reject schema identifiers that cannot be ordered", () => {
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible("hash_revision", "0071_current_revision"),
  );
});

test("restore fallbacks use the centrally pinned PostgreSQL image", () => {
  const source = fs.readFileSync(path.join(__dirname, "restore.js"), "utf8");

  assert.match(
    source,
    /const \{ POSTGRES_IMAGE, dockerEnv, run, composeArgs \} = require\("\.\.\/compose"\);/,
  );
  assert.doesNotMatch(source, /postgres:\d+/);
  assert.equal(source.match(/\.catch\(\(\) => POSTGRES_IMAGE\)/g)?.length, 3);
  assert.equal(source.match(/let pgImageTag = POSTGRES_IMAGE;/g)?.length, 2);
});
