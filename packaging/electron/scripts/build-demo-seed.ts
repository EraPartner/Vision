#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { databaseStatsManifest } from "../runtime/database-stats";
import { createNativeRuntime } from "../runtime/native";
import { appRoot } from "../paths";
import { reservePort } from "./native-isolated-smoke";
import { replaceGeneratedDirectory } from "./replace-generated-directory";

const repoRoot = path.resolve(appRoot, "..", "..");
const defaultOutputRoot = path.join(appRoot, "demo-seed");
// tsc emits demo-db/generate.mts as an ES module next to this compiled script.
const generatorPath = path.join(__dirname, "..", "demo-db", "generate.mjs");

/** The generator module's exports, unverified until buildDemoSeed checks them. */
export interface DemoSeedGeneratorResult {
  demoSeedSql?: unknown;
  demoSeedSummary?: unknown;
  demoSeedReferenceDate?: unknown;
}

export interface DemoSeedStats {
  readonly tableCounts: Readonly<Record<string, number>>;
}

export interface BuildDemoSeedOptions {
  nativeRuntimeRoot?: string;
  outputRoot?: string;
  createRuntime?: typeof createNativeRuntime;
  load?: (referenceDate: string) => Promise<DemoSeedGeneratorResult>;
  reserve?: () => Promise<number>;
  referenceDate?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assertSafeDemoSeedDestination(candidate: string): string {
  const destination = path.resolve(candidate);
  if (
    path.basename(destination) !== "demo-seed" ||
    path.dirname(destination) === destination
  ) {
    throw new Error("Demo seed destination must end in demo-seed");
  }
  return destination;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function loadGenerator(
  referenceDate?: string,
): Promise<DemoSeedGeneratorResult> {
  const url = new URL(pathToFileURL(generatorPath).href);
  url.searchParams.set("build", String(Date.now()));
  if (referenceDate) url.searchParams.set("referenceDate", referenceDate);
  const generated: unknown = await import(url.href);
  return isRecord(generated) ? generated : {};
}

export function assertSummaryMatchesStats(
  summary: Readonly<Record<string, unknown>>,
  stats: DemoSeedStats,
): void {
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
      throw Object.assign(
        new Error(`Synthetic Demo row count mismatch for ${table}`),
        { code: "DEMO_SEED_COUNT_MISMATCH" },
      );
    }
  }
}

export async function buildDemoSeed({
  nativeRuntimeRoot,
  outputRoot = defaultOutputRoot,
  createRuntime = createNativeRuntime,
  load = loadGenerator,
  reserve = reservePort,
  referenceDate = new Date().toISOString().slice(0, 10),
}: BuildDemoSeedOptions = {}) {
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
    runtimeId: `vision_demo_seed_${process.pid}`,
    postgresPort,
    appPort: 0,
  });
  try {
    const generated = await load(referenceDate);
    const sql = String(generated.demoSeedSql || "");
    const summary = generated.demoSeedSummary;
    if (!sql.trim() || !isRecord(summary)) {
      throw new Error("Synthetic Demo generator returned an invalid result");
    }
    if (/\bkysely_migration\b/i.test(sql)) {
      throw new Error("Synthetic Demo data must not modify migration state");
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
      referenceDate: generated.demoSeedReferenceDate,
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

export async function main(): Promise<void> {
  const nativeRuntimeRoot =
    process.env.VISION_NATIVE_PAYLOAD_ROOT ||
    path.join(appRoot, "native-runtime");
  const result = await buildDemoSeed({ nativeRuntimeRoot });
  console.log(
    `Prepared native Demo seed for schema ${result.manifest.schemaRevision}.`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = isRecord(error) ? error.message : undefined;
    console.error(error && message ? String(message) : String(error));
    process.exitCode = 1;
  });
}
