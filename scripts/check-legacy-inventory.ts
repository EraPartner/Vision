#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function flagPath(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined) throw new TypeError(`${flag} requires a path`);
  return path.resolve(value);
}

const root = flagPath("--root") ?? repositoryRoot;
const inventoryPath =
  flagPath("--inventory") ??
  path.join(repositoryRoot, "docs/audits/legacy-surface-inventory.json");
const todoPath = flagPath("--todo") ?? path.join(root, "TODO.md");

const classifications = [
  "remove-now",
  "migrate-then-remove",
  "retain-with-reason",
  "historical-record-only",
  "unknown",
] as const;
type Classification = (typeof classifications)[number];
const classificationSet: ReadonlySet<unknown> = new Set(classifications);
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isClassification(value: unknown): value is Classification {
  return classificationSet.has(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): void {
  console.error(`[legacy-inventory] ${message}`);
  process.exitCode = 1;
}

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
} catch (error) {
  fail(`cannot parse ${inventoryPath}: ${errorMessage(error)}`);
  process.exit();
}
const inventory: JsonObject = isObject(parsed) ? parsed : {};

if (inventory.version !== 1) fail("version must equal 1");
if (
  typeof inventory.auditedAt !== "string" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(inventory.auditedAt)
) {
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

const records: unknown[] = Array.isArray(inventory.records)
  ? inventory.records
  : [];
const ids = new Set<unknown>();
const actionableTodoTitles = new Set<string>();
const counts: Record<Classification, number> = {
  "remove-now": 0,
  "migrate-then-remove": 0,
  "retain-with-reason": 0,
  "historical-record-only": 0,
  unknown: 0,
};
for (const [index, entry] of records.entries()) {
  const record: JsonObject = isObject(entry) ? entry : {};
  const label =
    typeof record.id === "string" && record.id !== ""
      ? record.id
      : `record ${index}`;
  if (typeof record.id !== "string" || !/^LEG-[A-Z0-9-]+$/.test(record.id)) {
    fail(`${label}: id must match LEG-[A-Z0-9-]+`);
  } else if (ids.has(record.id)) {
    fail(`${label}: duplicate id`);
  } else {
    ids.add(record.id);
  }
  if (!isClassification(record.classification)) {
    fail(`${label}: invalid classification ${String(record.classification)}`);
  } else {
    counts[record.classification] += 1;
  }
  for (const field of requiredStrings) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
      fail(`${label}: ${field} must be a non-empty string`);
    }
  }
  const paths: unknown[] | undefined = Array.isArray(record.paths)
    ? record.paths
    : undefined;
  if (paths === undefined || paths.length === 0) {
    fail(`${label}: paths must be a non-empty array`);
  } else {
    for (const relativePath of paths) {
      if (
        typeof relativePath !== "string" ||
        relativePath.startsWith("/") ||
        !fs.existsSync(path.join(root, relativePath))
      ) {
        fail(
          `${label}: missing or invalid repository path ${String(relativePath)}`,
        );
      }
    }
  }
  if (!Array.isArray(record.deletionDependencies)) {
    fail(`${label}: deletionDependencies must be an array`);
  }
  const needsTodo =
    record.classification === "remove-now" ||
    record.classification === "migrate-then-remove";
  const todoTitle = record.todoTitle;
  if (needsTodo && (typeof todoTitle !== "string" || !todoTitle.trim())) {
    fail(`${label}: actionable classifications require todoTitle`);
  } else if (needsTodo && typeof todoTitle === "string") {
    actionableTodoTitles.add(todoTitle.trim());
  }
  if (!needsTodo && todoTitle !== null) {
    fail(
      `${label}: retained, historical, or unknown records must use todoTitle: null`,
    );
  }
}

let todoSource = "";
try {
  todoSource = fs.readFileSync(todoPath, "utf8");
} catch (error) {
  fail(`cannot read ${todoPath}: ${errorMessage(error)}`);
}
for (const title of actionableTodoTitles) {
  if (!todoSource.includes(`**${title}**`)) {
    fail(`actionable TODO is missing from TODO.md: ${title}`);
  }
}

const requiredSeeds: unknown[] = Array.isArray(inventory.requiredSeeds)
  ? inventory.requiredSeeds
  : [];
for (const id of requiredSeeds) {
  if (!ids.has(id)) fail(`required seed ${String(id)} is missing`);
}
const summary: JsonObject | undefined = isObject(inventory.summary)
  ? inventory.summary
  : undefined;
for (const classification of classifications) {
  if (summary?.[classification] !== counts[classification]) {
    fail(
      `summary.${classification} must equal ${counts[classification]}, got ${String(summary?.[classification])}`,
    );
  }
}
if (summary?.total !== ids.size) {
  fail(`summary.total must equal ${ids.size}, got ${String(summary?.total)}`);
}

if ((process.exitCode ?? 0) === 0) {
  console.log(
    `[legacy-inventory] OK: ${ids.size} records (${counts["remove-now"]} remove now, ${counts["migrate-then-remove"]} migrate then remove)`,
  );
}
