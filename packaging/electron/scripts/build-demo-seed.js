#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { databaseStatsManifest } = require("../runtime/database-stats");
const { createNativeRuntime } = require("../runtime/native");
const { reservePort } = require("./native-isolated-smoke");
const { replaceGeneratedDirectory } = require("./replace-generated-directory");

const electronRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(electronRoot, "..", "..");
const defaultOutputRoot = path.join(electronRoot, "demo-seed");
const generatorPath = path.join(electronRoot, "demo-db", "generate.mjs");

function assertSafeDemoSeedDestination(candidate) {
  const destination = path.resolve(candidate);
  if (
    path.basename(destination) !== "demo-seed" ||
    path.dirname(destination) === destination
  ) {
    throw new Error("Demo seed destination must end in demo-seed");
  }
  return destination;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function loadGenerator() {
  return import(`${pathToFileURL(generatorPath).href}?build=${Date.now()}`);
}

function assertSummaryMatchesStats(summary, stats) {
  const expected = {
    accounts: summary.accounts,
    transactions: summary.transactions,
    recipients: summary.recipients,
    investments: summary.investments,
    portfolio_transactions: summary.portfolioTransactions,
    asset_price_history: summary.assetPriceHistory,
    planned_transactions: summary.plannedTransactions,
    transaction_splits: summary.transactionSplits,
  };
  for (const [table, count] of Object.entries(expected)) {
    if (stats.tableCounts[table] !== count) {
      const error = new Error(`Synthetic Demo row count mismatch for ${table}`);
      error.code = "DEMO_SEED_COUNT_MISMATCH";
      throw error;
    }
  }
}

async function buildDemoSeed({
  nativeRuntimeRoot,
  outputRoot = defaultOutputRoot,
  createRuntime = createNativeRuntime,
  load = loadGenerator,
  reserve = reservePort,
} = {}) {
  const payloadRoot = path.resolve(nativeRuntimeRoot || "");
  fs.accessSync(path.join(payloadRoot, "manifest.json"), fs.constants.R_OK);
  const destination = assertSafeDemoSeedDestination(outputRoot);
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-demo-seed-db-"),
  );
  const stagingRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-demo-seed-output-"),
  );
  const postgresPort = await reserve();
  const runtime = createRuntime({
    userDataDir,
    repoRoot,
    runtimeRoot: repoRoot,
    postgresRuntimeRoot: payloadRoot,
    browserRuntimeRoot: payloadRoot,
    alembicPath: path.join(payloadRoot, "vision-alembic"),
    runtimeId: `vision_demo_seed_${process.pid}`,
    postgresPort,
    appPort: 0,
  });
  try {
    const generated = await load();
    const sql = String(generated.demoSeedSql || "");
    const summary = generated.demoSeedSummary;
    if (!sql.trim() || !summary || typeof summary !== "object") {
      throw new Error("Synthetic Demo generator returned an invalid result");
    }
    if (/\balembic_version\b/i.test(sql)) {
      throw new Error("Synthetic Demo data must not modify Alembic state");
    }

    const sqlPath = path.join(stagingRoot, "demo-seed.sql");
    const dumpPath = path.join(stagingRoot, "demo-seed.dump");
    await fs.promises.writeFile(sqlPath, sql, { mode: 0o600 });
    await runtime.ensureLayout();
    await runtime.discover();
    await runtime.migrateDatabase();
    await runtime.applyOwnerSqlFile(sqlPath);
    const stats = await runtime.getDatabaseStats();
    assertSummaryMatchesStats(summary, stats);
    await runtime.dumpDatabase(dumpPath, { format: "custom" });
    await runtime.validateCustomDump(dumpPath);

    const manifest = {
      version: 1,
      logicalSha256: sha256(sql),
      dumpSha256: sha256(await fs.promises.readFile(dumpPath)),
      schemaRevision: stats.schema,
      database: databaseStatsManifest(stats),
      summary,
    };
    await fs.promises.writeFile(
      path.join(stagingRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 },
    );
    await fs.promises.unlink(sqlPath);
    replaceGeneratedDirectory(stagingRoot, destination);
    return { outputRoot: destination, manifest };
  } finally {
    await runtime.stop().catch(() => {});
    await fs.promises.rm(userDataDir, { recursive: true, force: true });
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const nativeRuntimeRoot =
    process.env.VISION_NATIVE_PAYLOAD_ROOT ||
    path.join(electronRoot, "native-runtime");
  const result = await buildDemoSeed({ nativeRuntimeRoot });
  console.log(
    `Prepared native Demo seed for schema ${result.manifest.schemaRevision}.`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  assertSafeDemoSeedDestination,
  assertSummaryMatchesStats,
  buildDemoSeed,
  loadGenerator,
  main,
  sha256,
};
