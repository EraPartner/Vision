"use strict";

const assert = require("node:assert/strict");
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
