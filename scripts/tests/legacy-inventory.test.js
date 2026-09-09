const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const checker = path.resolve(__dirname, "../check-legacy-inventory.js");

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-legacy-inventory-"),
  );
  fs.writeFileSync(
    path.join(root, "surface.js"),
    "export const surface = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "TODO.md"),
    "- [ ] **Remove one surface**\n  - Tracking: fixture\n",
  );
  const record = {
    id: "LEG-ONE",
    title: "One surface",
    domain: "test",
    classification: "remove-now",
    disposition: "Unused in the fixture.",
    paths: ["surface.js"],
    readers: "None.",
    writers: "None.",
    persistedData: "None.",
    supportWindow: "None.",
    replacement: "Direct replacement.",
    deletionDependencies: [],
    liveEvidence: "Static fixture evidence.",
    todoTitle: "Remove one surface",
    ...overrides.record,
  };
  const inventory = {
    version: 1,
    auditedAt: "2026-09-09",
    searches: ["fixture scan"],
    requiredSeeds: ["LEG-ONE"],
    summary: {
      total: 1,
      "remove-now": 1,
      "migrate-then-remove": 0,
      "retain-with-reason": 0,
      "historical-record-only": 0,
      unknown: 0,
    },
    records: [record],
    ...overrides.inventory,
  };
  const inventoryPath = path.join(root, "inventory.json");
  fs.writeFileSync(inventoryPath, JSON.stringify(inventory));
  return { root, inventoryPath };
}

function check({ root, inventoryPath }) {
  return spawnSync(
    process.execPath,
    [checker, "--root", root, "--inventory", inventoryPath],
    { encoding: "utf8" },
  );
}

test("accepts a complete inventory with existing evidence paths", () => {
  const result = check(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: 1 records/);
});

test("rejects a missing evidence path", () => {
  const result = check(fixture({ record: { paths: ["missing.js"] } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or invalid repository path/);
});

test("requires actionable records to map to a bounded TODO", () => {
  const result = check(fixture({ record: { todoTitle: null } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /actionable classifications require todoTitle/);
});

test("rejects an actionable title that is absent from TODO.md", () => {
  const result = check(
    fixture({ record: { todoTitle: "Remove an untracked surface" } }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /actionable TODO is missing from TODO\.md/);
});
