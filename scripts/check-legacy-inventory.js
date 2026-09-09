#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const inventoryArgument = process.argv.indexOf("--inventory");
const rootArgument = process.argv.indexOf("--root");
const todoArgument = process.argv.indexOf("--todo");
const root =
  rootArgument >= 0
    ? path.resolve(process.argv[rootArgument + 1])
    : repositoryRoot;
const inventoryPath =
  inventoryArgument >= 0
    ? path.resolve(process.argv[inventoryArgument + 1])
    : path.join(repositoryRoot, "docs/audits/legacy-surface-inventory.json");
const todoPath =
  todoArgument >= 0
    ? path.resolve(process.argv[todoArgument + 1])
    : path.join(root, "TODO.md");

const classifications = new Set([
  "remove-now",
  "migrate-then-remove",
  "retain-with-reason",
  "historical-record-only",
  "unknown",
]);
const requiredStrings = [
  "title",
  "domain",
  "disposition",
  "readers",
  "writers",
  "persistedData",
  "supportWindow",
  "replacement",
  "liveEvidence",
];

function fail(message) {
  console.error(`[legacy-inventory] ${message}`);
  process.exitCode = 1;
}

let inventory;
try {
  inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
} catch (error) {
  fail(`cannot parse ${inventoryPath}: ${error.message}`);
  process.exit();
}

if (inventory.version !== 1) fail("version must equal 1");
if (!/^\d{4}-\d{2}-\d{2}$/.test(inventory.auditedAt ?? "")) {
  fail("auditedAt must be YYYY-MM-DD");
}
if (!Array.isArray(inventory.searches) || inventory.searches.length === 0) {
  fail("searches must be a non-empty array");
}
if (
  !Array.isArray(inventory.requiredSeeds) ||
  inventory.requiredSeeds.length === 0
) {
  fail("requiredSeeds must be a non-empty array");
}
if (!Array.isArray(inventory.records) || inventory.records.length === 0) {
  fail("records must be a non-empty array");
}

const ids = new Set();
const actionableTodoTitles = new Set();
const counts = Object.fromEntries(
  [...classifications].map((value) => [value, 0]),
);
for (const [index, record] of (inventory.records ?? []).entries()) {
  const label = record.id || `record ${index}`;
  if (!/^LEG-[A-Z0-9-]+$/.test(record.id ?? "")) {
    fail(`${label}: id must match LEG-[A-Z0-9-]+`);
  } else if (ids.has(record.id)) {
    fail(`${label}: duplicate id`);
  } else {
    ids.add(record.id);
  }
  if (!classifications.has(record.classification)) {
    fail(`${label}: invalid classification ${record.classification}`);
  } else {
    counts[record.classification] += 1;
  }
  for (const field of requiredStrings) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      fail(`${label}: ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(record.paths) || record.paths.length === 0) {
    fail(`${label}: paths must be a non-empty array`);
  } else {
    for (const relativePath of record.paths) {
      if (
        typeof relativePath !== "string" ||
        relativePath.startsWith("/") ||
        !fs.existsSync(path.join(root, relativePath))
      ) {
        fail(`${label}: missing or invalid repository path ${relativePath}`);
      }
    }
  }
  if (!Array.isArray(record.deletionDependencies)) {
    fail(`${label}: deletionDependencies must be an array`);
  }
  const needsTodo =
    record.classification === "remove-now" ||
    record.classification === "migrate-then-remove";
  if (
    needsTodo &&
    (typeof record.todoTitle !== "string" || !record.todoTitle.trim())
  ) {
    fail(`${label}: actionable classifications require todoTitle`);
  } else if (needsTodo) {
    actionableTodoTitles.add(record.todoTitle.trim());
  }
  if (!needsTodo && record.todoTitle !== null) {
    fail(
      `${label}: retained, historical, or unknown records must use todoTitle: null`,
    );
  }
}

let todoSource = "";
try {
  todoSource = fs.readFileSync(todoPath, "utf8");
} catch (error) {
  fail(`cannot read ${todoPath}: ${error.message}`);
}
for (const title of actionableTodoTitles) {
  if (!todoSource.includes(`**${title}**`)) {
    fail(`actionable TODO is missing from TODO.md: ${title}`);
  }
}

for (const id of inventory.requiredSeeds ?? []) {
  if (!ids.has(id)) fail(`required seed ${id} is missing`);
}
for (const classification of classifications) {
  if (inventory.summary?.[classification] !== counts[classification]) {
    fail(
      `summary.${classification} must equal ${counts[classification]}, got ${inventory.summary?.[classification]}`,
    );
  }
}
if (inventory.summary?.total !== ids.size) {
  fail(`summary.total must equal ${ids.size}, got ${inventory.summary?.total}`);
}

if (!process.exitCode) {
  console.log(
    `[legacy-inventory] OK: ${ids.size} records (${counts["remove-now"]} remove now, ${counts["migrate-then-remove"]} migrate then remove)`,
  );
}
