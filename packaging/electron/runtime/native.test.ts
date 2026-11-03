import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { appRoot } from "../paths";
import {
  safeChildEnv,
  validateArgs,
  classifyDatabaseSwitchState,
  validateApplicationEnv,
  buildNativeBackendEnv,
  isPortFree,
  isDetailedHealthReady,
  lastStartupError,
  verifyRuntimeManifest,
  directoryFingerprint,
  atomicReplaceDirectory,
  createNativeRuntime,
  parseDatabaseToolOutput,
  packagedMigrationVersion,
  LEGACY_POSTGRES_DATA_CODE,
  PACKAGED_DATABASE_TOOL,
  SOURCE_DATABASE_TOOL,
  TRANSITION_COMMAND,
  type NativeRuntimeOptions,
  type PortProbeServer,
  type RunFile,
  type RunFileOptions,
  type RunFileResult,
  type SpawnedChild,
} from "./native";

const repoRoot = path.resolve(appRoot, "..", "..");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isRecord(error) && error.code === code;
}

/** A spawned-process stand-in that emits events like a ChildProcess. */
function fakeChild(
  fields: { pid: number; exitCode?: number | null },
  onUnref: () => void = () => {},
): SpawnedChild {
  return Object.assign(new EventEmitter(), {
    ...fields,
    unref: onUnref,
  });
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A file whose 100-byte SQLite header records `userVersion`. */
function sqliteFile(userVersion: number, body = ""): Buffer {
  const header = Buffer.alloc(4096);
  header.write("SQLite format 3\0", 0, "latin1");
  header.writeUInt16BE(4096, 16);
  header.writeUInt8(2, 18);
  header.writeUInt8(2, 19);
  header.writeUInt32BE(1, 24);
  header.writeUInt32BE(1, 28);
  header.writeUInt32BE(1, 56);
  header.writeInt32BE(userVersion, 60);
  header.writeUInt32BE(1, 92);
  header.writeUInt32BE(3_046_001, 96);
  header.write(body, 100, "utf8");
  return header;
}

function sha256(contents: Buffer | string): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

interface ToolCall {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  command: string;
  operands: string[];
}

/**
 * A RunFile that plays `db-file.ts`: `handler` receives the subcommand and
 * its operands and returns the report fields, or throws to fail the run.
 */
function databaseToolRunFile(
  calls: ToolCall[],
  handler: (
    command: string,
    operands: string[],
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): RunFile {
  return async (
    executable: string,
    args: string[],
    options: RunFileOptions = {},
  ): Promise<RunFileResult> => {
    const index = args.findIndex((arg) =>
      ["verify", "snapshot", "create"].includes(arg),
    );
    assert.ok(index >= 0, `unexpected tool invocation ${args.join(" ")}`);
    const command = String(args[index]);
    const operands = args.slice(index + 1);
    calls.push({ executable, args, env: options.env, command, operands });
    try {
      const report = await handler(command, operands);
      return {
        stdout: `[INFO] logger line before the result\n${JSON.stringify({ ok: true, ...report })}\n`,
        stderr: "",
      };
    } catch (error) {
      throw Object.assign(new Error("Command failed: db-file"), {
        stdout: `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      });
    }
  };
}

/** The report verify/snapshot print for a file on disk. */
async function reportFor(
  file: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const contents = await fs.promises.readFile(file);
  return {
    file,
    bytes: contents.length,
    sha256: sha256(contents),
    sqliteVersion: "3.46.1",
    schemaVersion: contents.readInt32BE(60),
    pendingMigrations: 0,
    ...extra,
  };
}

function sourceRuntime(
  userDataDir: string,
  overrides: Partial<NativeRuntimeOptions> = {},
) {
  return createNativeRuntime({
    userDataDir,
    repoRoot,
    runtimeId: "vision_test",
    bunPath: "/bin/echo",
    ...overrides,
  });
}

void test("safeChildEnv carries only the declared host environment plus explicit overrides", () => {
  const previous = process.env.VISION_TEST_SECRET;
  process.env.VISION_TEST_SECRET = "must-not-leak";
  try {
    const env = safeChildEnv({ PORT: 3456 });
    assert.equal(env.PORT, "3456");
    assert.equal(env.VISION_TEST_SECRET, undefined);
    assert.ok(env.PATH);
  } finally {
    if (previous === undefined) delete process.env.VISION_TEST_SECRET;
    else process.env.VISION_TEST_SECRET = previous;
  }
});

void test("process execution arguments must remain an array of strings", () => {
  assert.deepEqual(validateArgs(["verify", "/tmp/db"]), ["verify", "/tmp/db"]);
  assert.throws(() => validateArgs("db-file verify /tmp/db"), /string array/);
  assert.throws(() => validateArgs(["verify", 42]), /string array/);
});

void test("database switch recovery classifies every atomic rename interruption point", () => {
  assert.equal(
    classifyDatabaseSwitchState({ liveExists: true, previousExists: false }),
    "before-renames",
  );
  assert.equal(
    classifyDatabaseSwitchState({ liveExists: false, previousExists: true }),
    "between-renames",
  );
  assert.equal(
    classifyDatabaseSwitchState({ liveExists: true, previousExists: true }),
    "activated",
  );
  assert.equal(
    classifyDatabaseSwitchState({ liveExists: false, previousExists: false }),
    "unsafe",
  );
});

void test("native application environment accepts only fixed keys and single-line values", () => {
  assert.deepEqual(
    validateApplicationEnv({
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "retired-admin-token",
      OPENAI_API_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-openai-key",
      ADMIN_TOKEN: "wrong-contract",
      DATABASE_URL: "postgresql://vision@127.0.0.1/vision",
      VISION_DATABASE_PATH: "/elsewhere/vision.sqlite3",
      UNRELATED_SECRET: "drop",
    }),
    {
      FRED_API_KEY: "key",
    },
  );
  assert.throws(
    () => validateApplicationEnv({ FRED_API_KEY: "bad\nvalue" }),
    /Invalid value/,
  );
});

void test("native first-start layout keeps the database inside application data, private and resumable", async (t) => {
  const temp = await tempDir(t, "vision-native-layout-");
  const runtime = sourceRuntime(temp, { runtimeId: "vision_layout_test" });
  const first = await runtime.ensureLayout();
  const firstEnv = await fs.promises.readFile(runtime.paths.env, "utf8");
  const second = await runtime.ensureLayout();
  const secondEnv = await fs.promises.readFile(runtime.paths.env, "utf8");
  assert.equal(secondEnv, firstEnv);
  assert.doesNotMatch(firstEnv, /DATABASE_URL|POSTGRES/);
  assert.equal(first.database, path.join(temp, "database", "vision.sqlite3"));
  assert.equal(second.database, first.database);
  assert.equal(runtime.paths.database, first.database);
  assert.equal(runtime.paths.databaseDir, path.join(temp, "database"));
  for (const dir of [
    runtime.paths.nativeRoot,
    runtime.paths.databaseDir,
    runtime.paths.attachments,
  ]) {
    assert.equal((await fs.promises.stat(dir)).mode & 0o777, 0o700, dir);
    assert.ok(dir.startsWith(`${temp}${path.sep}`), dir);
  }
  assert.equal((await fs.promises.stat(runtime.paths.env)).mode & 0o777, 0o600);
  // The backend creates the database file itself on its first start.
  assert.equal(fs.existsSync(runtime.paths.database), false);
});

void test("native layout strips retired secrets but keeps Vision 2.0 credentials for a downgrade", async (t) => {
  const temp = await tempDir(t, "vision-native-retired-env-");
  const runtime = sourceRuntime(temp, { runtimeId: "vision_retired_env_test" });
  await runtime.ensureLayout();
  const current = await fs.promises.readFile(runtime.paths.env, "utf8");
  await fs.promises.writeFile(
    runtime.paths.env,
    [
      current.replace(/\n$/, ""),
      "OPENAI_API_KEY=sk-synthetic-retired",
      "OPENAI_API_ENABLED=true",
      "AI_REFERENCE_MAPPING_KEY=synthetic-mapping-key",
      "DATABASE_URL=postgresql://vision_app:redacted@127.0.0.1:54329/vision",
      "FRED_API_KEY=kept",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  await runtime.ensureLayout();
  const cleaned = await fs.promises.readFile(runtime.paths.env, "utf8");
  assert.equal(
    cleaned,
    `${current}DATABASE_URL=postgresql://vision_app:redacted@127.0.0.1:54329/vision\nFRED_API_KEY=kept\n`,
  );
  await runtime.ensureLayout();
  assert.equal(await fs.promises.readFile(runtime.paths.env, "utf8"), cleaned);
});

void test("native first start persists and unreferences an argument-array backend child", async (t) => {
  const temp = await tempDir(t, "vision-native-start-");
  let unreferenced = false;
  const child = fakeChild({ pid: 123_456 }, () => {
    unreferenced = true;
  });
  let spawned:
    | {
        bin: string;
        args: string[];
        options: { env?: NodeJS.ProcessEnv | undefined };
      }
    | undefined;
  const runtime = sourceRuntime(temp, {
    runtimeId: "vision_start_test",
    appPort: 43_210,
    isPortFree: () => Promise.resolve(true),
    spawnProcess: (bin, args, options) => {
      spawned = { bin, args, options };
      return child;
    },
  });
  await runtime.ensureLayout();
  await fs.promises.appendFile(
    runtime.paths.env,
    "DATABASE_URL=postgresql://vision_app:redacted@127.0.0.1:54329/vision\nVISION_POSTGRES_ADMIN_PASSWORD=redacted\n",
  );

  const result = await runtime.start();
  assert.equal(result.status, "started");
  assert.equal(result.database, runtime.paths.database);
  assert.equal(unreferenced, true);
  assert.ok(spawned);
  assert.equal(spawned.bin, "/bin/echo");
  assert.deepEqual(spawned.args, ["run", "apps/node-backend/src/main.ts"]);
  assert.equal(spawned.options.env?.SERVER_HOST, "127.0.0.1");
  assert.equal(spawned.options.env.VISION_DATABASE_PATH, runtime.paths.database);
  assert.equal(spawned.options.env.ATTACHMENTS_DIR, runtime.paths.attachments);
  for (const key of Object.keys(spawned.options.env)) {
    assert.doesNotMatch(key, /^(?:DATABASE_URL|VISION_POSTGRES|PG)/, key);
  }
  assert.equal((await runtime.readState())?.activeRuntime, "native");

  assert.equal(await runtime.backendStartupFailure(), undefined);
  await fs.promises.appendFile(
    runtime.paths.backendLog,
    `2026-10-19T18:45:42.511Z [ERROR] Failed to start application {"error":"Database has application objects but no migration ledger"}\n`,
  );
  (child as unknown as EventEmitter).emit("exit");
  assert.deepEqual(await runtime.backendStartupFailure(), {
    message: "Database has application objects but no migration ledger",
  });
  await fs.promises.appendFile(
    runtime.paths.backendLog,
    `2026-10-19T18:45:43.000Z [ERROR] Failed to start application {"error":"Vision could not back up the database before migrating it: disk full","code":"PRE_MIGRATION_BACKUP_FAILED"}\n`,
  );
  assert.deepEqual(await runtime.backendStartupFailure(), {
    message: "Vision could not back up the database before migrating it: disk full",
    code: "PRE_MIGRATION_BACKUP_FAILED",
  });
});

void test("Vision 2.0 data without a SQLite database stops startup and stays untouched", async (t) => {
  const temp = await tempDir(t, "vision-native-legacy-");
  let spawns = 0;
  const runtime = sourceRuntime(temp, {
    runtimeId: "vision",
    isPortFree: () => Promise.resolve(true),
    spawnProcess: () => {
      spawns += 1;
      return fakeChild({ pid: 123_457 });
    },
  });
  const legacy = path.join(temp, "native", "vision", "postgres", "data");
  assert.equal(runtime.paths.legacyPostgresData, legacy);
  await fs.promises.mkdir(path.join(legacy, "base"), { recursive: true });
  await fs.promises.writeFile(path.join(legacy, "PG_VERSION"), "18\n");
  await fs.promises.writeFile(path.join(legacy, "base", "1"), "cluster");
  const before = await directoryFingerprint(legacy);
  const beforeStat = await fs.promises.stat(path.join(legacy, "PG_VERSION"));

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(hasCode(LEGACY_POSTGRES_DATA_CODE)(error));
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(TRANSITION_COMMAND));
    assert.ok(error.message.includes(legacy));
    assert.ok(isRecord(error));
    assert.equal(error.dataDirectory, legacy);
    assert.equal(error.command, "bun run transition:v2 -- <backup file>");
    assert.equal(error.backups, path.join(temp, "pre-update-backups"));
    return true;
  });
  assert.equal(spawns, 0);
  assert.equal(fs.existsSync(runtime.paths.database), false);
  assert.deepEqual(await directoryFingerprint(legacy), before);
  assert.equal(
    (await fs.promises.stat(path.join(legacy, "PG_VERSION"))).mtimeMs,
    beforeStat.mtimeMs,
  );

  // Once a SQLite database exists (the transition installed it), both may coexist.
  await fs.promises.writeFile(runtime.paths.database, sqliteFile(1));
  await runtime.start();
  assert.equal(spawns, 1);
  assert.deepEqual(await directoryFingerprint(legacy), before);
});

void test("an empty Vision 2.0 data directory does not block a fresh start", async (t) => {
  const temp = await tempDir(t, "vision-native-legacy-empty-");
  const runtime = sourceRuntime(temp, {
    runtimeId: "vision",
    isPortFree: () => Promise.resolve(true),
    spawnProcess: () => fakeChild({ pid: 123_458 }),
  });
  await fs.promises.mkdir(runtime.paths.legacyPostgresData, { recursive: true });
  assert.equal((await runtime.start()).status, "started");
});

void test("startup error is read from the last failed backend start in the log", () => {
  const log = [
    `2026-10-19T18:37:01.000Z [ERROR] Failed to start application {"error":"old"}`,
    `2026-10-19T18:45:42.511Z [INFO] migration failed {"migration":"0001_baseline"}`,
    `2026-10-19T18:45:42.512Z [ERROR] Failed to start application {"error":"new"}`,
    "",
  ].join("\n");
  assert.equal(lastStartupError(log), "new");
  assert.equal(lastStartupError("2026-10-19T09:21:00.000Z [INFO] ready\n"), undefined);
  assert.equal(lastStartupError("[ERROR] Failed to start application {broken"), undefined);
});

void test("packaged backend environment pins the SQLite database, attachments and loopback", () => {
  const runtimeRoot =
    "/Applications/Vision.app/Contents/Resources/native-runtime";
  const userData = "/Users/test/Library/Application Support/Vision";
  const env = buildNativeBackendEnv({
    runtimeEnv: {
      DATABASE_URL: "postgresql://vision_app:redacted@127.0.0.1:5432/vision",
      DATABASE_URL_MIGRATIONS:
        "postgresql://vision_owner:redacted@127.0.0.1:5432/vision",
      DATABASE_URL_ANALYSIS:
        "postgresql://vision_analysis:redacted@127.0.0.1:5432/vision",
      VISION_POSTGRES_ADMIN_ROLE: "vision_admin",
      VISION_POSTGRES_ADMIN_PASSWORD: "redacted",
      OPENAI_API_KEY: "sk-synthetic-retired",
      OPENAI_API_ENABLED: "true",
      AI_REFERENCE_MAPPING_KEY: "synthetic-mapping-key",
      FRED_API_KEY: "kept",
    },
    port: 43123,
    paths: {
      env: `${userData}/native/vision/runtime.env`,
      attachments: `${userData}/native/vision/attachments`,
      cache: `${userData}/native/vision/cache`,
      database: `${userData}/database/vision.sqlite3`,
    },
    runtimeRoot,
  });

  assert.equal(env.SERVER_HOST, "127.0.0.1");
  assert.equal(env.PORT, "43123");
  assert.equal(env.VISION_DATABASE_PATH, `${userData}/database/vision.sqlite3`);
  assert.equal(env.ATTACHMENTS_DIR, `${userData}/native/vision/attachments`);
  assert.equal(env.VISION_RUNTIME_ROOT, runtimeRoot);
  assert.equal(env.VISION_DIST_DIR, path.join(runtimeRoot, "dist"));
  assert.equal(env.OLLAMA_URL, "http://127.0.0.1:11434");
  assert.equal(env.FRED_API_KEY, "kept");
  for (const removed of [
    "OPENAI_API_KEY",
    "OPENAI_API_ENABLED",
    "AI_REFERENCE_MAPPING_KEY",
    "DATABASE_URL",
    "DATABASE_URL_MIGRATIONS",
    "DATABASE_URL_ANALYSIS",
    "VISION_POSTGRES_ADMIN_ROLE",
    "VISION_POSTGRES_ADMIN_PASSWORD",
  ]) {
    assert.equal(removed in env, false, removed);
  }
  assert.equal(env.VISION_NATIVE_ENV_FILE, `${userData}/native/vision/runtime.env`);
});

void test("the database tool result is the last JSON line that reports ok", () => {
  const report = {
    ok: true,
    file: "/tmp/db.sqlite3",
    bytes: 4096,
    sha256: "a".repeat(64),
    sqliteVersion: "3.46.1",
    schemaVersion: 6,
    pendingMigrations: 0,
  };
  assert.deepEqual(
    parseDatabaseToolOutput(
      `{"level":"info","msg":"opened"}\n[INFO] migrations current\n${JSON.stringify(report)}\n`,
    ),
    {
      ok: true,
      report: {
        file: "/tmp/db.sqlite3",
        bytes: 4096,
        sha256: "a".repeat(64),
        sqliteVersion: "3.46.1",
        schemaVersion: 6,
        pendingMigrations: 0,
        tableCounts: undefined,
      },
    },
  );
  assert.deepEqual(
    parseDatabaseToolOutput(
      `${JSON.stringify({ ...report, tableCounts: { accounts: 6 } })}\n`,
    ),
    {
      ok: true,
      report: {
        file: "/tmp/db.sqlite3",
        bytes: 4096,
        sha256: "a".repeat(64),
        sqliteVersion: "3.46.1",
        schemaVersion: 6,
        pendingMigrations: 0,
        tableCounts: { accounts: 6 },
      },
    },
  );
  assert.deepEqual(
    parseDatabaseToolOutput('{"ok":false,"error":"integrity_check failed: x"}\n'),
    { ok: false, error: "integrity_check failed: x" },
  );
  assert.equal(parseDatabaseToolOutput("no result\n"), undefined);
  assert.equal(parseDatabaseToolOutput(undefined), undefined);
  assert.throws(
    () => parseDatabaseToolOutput(JSON.stringify({ ...report, sha256: "x" })),
    /invalid report/,
  );
  assert.throws(
    () =>
      parseDatabaseToolOutput(
        JSON.stringify({ ...report, tableCounts: { "bad name": 1 } }),
      ),
    /invalid table counts/,
  );
});

void test("the packaged payload runs the bundled database tool as Bun with only its own environment", async (t) => {
  const temp = await tempDir(t, "vision-native-tool-");
  const payload = path.join(temp, "native-runtime");
  await fs.promises.mkdir(path.join(payload, "tools"), { recursive: true });
  await fs.promises.writeFile(path.join(payload, "vision-backend"), "", {
    mode: 0o755,
  });
  await fs.promises.writeFile(
    path.join(payload, ...PACKAGED_DATABASE_TOOL.split("/")),
    "",
  );
  const calls: ToolCall[] = [];
  const runtime = createNativeRuntime({
    userDataDir: path.join(temp, "user"),
    runtimeRoot: payload,
    runtimeId: "vision_tool_test",
    runFile: databaseToolRunFile(calls, (_command, [file]) =>
      reportFor(String(file)),
    ),
  });
  const candidate = path.join(temp, "candidate.sqlite3");
  await fs.promises.writeFile(candidate, sqliteFile(4));
  const report = await runtime.verifyDatabaseFile(candidate);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.sha256, sha256(sqliteFile(4)));
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.executable, path.join(payload, "vision-backend"));
  assert.deepEqual(call.args, [
    path.join(payload, "tools", "db-file.js"),
    "verify",
    candidate,
  ]);
  assert.equal(call.env?.BUN_BE_BUN, "1");
  assert.equal(call.env.VISION_RUNTIME_ROOT, payload);
  assert.equal(call.env.VISION_DATABASE_PATH, runtime.paths.database);
  assert.equal(call.env.VISION_SKIP_DOTENV, "1");
  assert.equal(call.env.NODE_ENV, "production");
});

void test("a source checkout runs db-file.ts with Bun", async (t) => {
  const temp = await tempDir(t, "vision-native-source-tool-");
  const calls: ToolCall[] = [];
  const runtime = sourceRuntime(temp, {
    runFile: databaseToolRunFile(calls, (_command, [file]) =>
      reportFor(String(file)),
    ),
  });
  const candidate = path.join(temp, "candidate.sqlite3");
  await fs.promises.writeFile(candidate, sqliteFile(2));
  await runtime.verifyDatabaseFile(candidate);
  assert.equal(calls[0]?.executable, "/bin/echo");
  assert.deepEqual(calls[0].args, [
    "run",
    SOURCE_DATABASE_TOOL,
    "verify",
    candidate,
  ]);
  assert.equal(calls[0].env?.BUN_BE_BUN, undefined);
  assert.equal(calls[0].env?.VISION_RUNTIME_ROOT, repoRoot);
});

void test("a failed verification surfaces the tool's own error", async (t) => {
  const temp = await tempDir(t, "vision-native-verify-fail-");
  const runtime = sourceRuntime(temp, {
    runFile: databaseToolRunFile([], () => {
      throw new Error("integrity_check failed: page 7 is never used");
    }),
  });
  await assert.rejects(
    runtime.verifyDatabaseFile(path.join(temp, "corrupt.sqlite3")),
    (error: unknown) =>
      hasCode("DATABASE_VERIFY_FAILED")(error) &&
      error instanceof Error &&
      error.message === "integrity_check failed: page 7 is never used",
  );
});

void test("a snapshot appears at its final name only after the tool verified it", async (t) => {
  const temp = await tempDir(t, "vision-native-snapshot-");
  const calls: ToolCall[] = [];
  let failNext = false;
  const runtime = sourceRuntime(temp, {
    runFile: databaseToolRunFile(calls, async (command, [source, destination]) => {
      assert.equal(command, "snapshot");
      const partial = String(destination);
      assert.ok(partial.endsWith(".partial"));
      await fs.promises.copyFile(String(source), partial);
      if (failNext) throw new Error("foreign_key_check found 1 violation(s)");
      return reportFor(partial);
    }),
  });
  const destination = path.join(temp, "backup", "db.sqlite3");
  await assert.rejects(
    runtime.snapshotDatabase(destination),
    hasCode("DATABASE_MISSING"),
  );
  assert.equal(calls.length, 0);

  await fs.promises.writeFile(runtime.paths.database, sqliteFile(5, "live"));
  const report = await runtime.snapshotDatabase(destination);
  assert.equal(report.file, destination);
  assert.equal(report.schemaVersion, 5);
  assert.deepEqual(calls[0]?.operands, [
    runtime.paths.database,
    `${destination}.partial`,
  ]);
  assert.equal((await fs.promises.stat(destination)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${destination}.partial`), false);

  failNext = true;
  const second = path.join(temp, "backup", "second.sqlite3");
  await assert.rejects(
    runtime.snapshotDatabase(second),
    hasCode("DATABASE_SNAPSHOT_FAILED"),
  );
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.existsSync(`${second}.partial`), false);
});

void test("a pending schema upgrade compares the database header with the packaged migrations", async (t) => {
  const temp = await tempDir(t, "vision-native-upgrade-");
  const payload = path.join(temp, "payload");
  const migrations = path.join(payload, "db", "migrations");
  await fs.promises.mkdir(migrations, { recursive: true });
  for (const name of [
    "0001_baseline.sql",
    "0002_next.sql",
    "0002_next.down.sql",
    "0003_latest.sql",
    "README.md",
  ])
    await fs.promises.writeFile(path.join(migrations, name), "");
  assert.equal(packagedMigrationVersion(migrations), 3);
  assert.equal(packagedMigrationVersion(path.join(temp, "missing")), 0);
  const runtime = createNativeRuntime({
    userDataDir: path.join(temp, "user"),
    runtimeRoot: payload,
    runtimeId: "vision_upgrade_test",
  });
  await runtime.ensureLayout();
  assert.equal(await runtime.pendingSchemaUpgrade(), undefined);
  await fs.promises.writeFile(runtime.paths.database, sqliteFile(2));
  assert.deepEqual(await runtime.pendingSchemaUpgrade(), {
    databaseVersion: 2,
    packagedVersion: 3,
  });
  await fs.promises.writeFile(runtime.paths.database, sqliteFile(3));
  assert.equal(await runtime.pendingSchemaUpgrade(), undefined);
});

void test("database statistics come from the file without the backend", async (t) => {
  const temp = await tempDir(t, "vision-native-stats-");
  const runtime = sourceRuntime(temp);
  await runtime.ensureLayout();
  assert.equal((await runtime.getDatabaseStats()).exists, false);
  await fs.promises.writeFile(runtime.paths.database, sqliteFile(7));
  const stats = await runtime.getDatabaseStats();
  assert.equal(stats.exists, true);
  assert.equal(stats.schemaVersion, 7);
  assert.equal(stats.pageSize, 4096);
});

interface RestoreFixture {
  runtime: ReturnType<typeof createNativeRuntime>;
  userDataDir: string;
  calls: ToolCall[];
  original: Buffer;
  candidate: string;
  candidateContents: Buffer;
}

async function restoreFixture(
  t: TestContext,
  { verifyFails = false }: { verifyFails?: boolean } = {},
): Promise<RestoreFixture> {
  const temp = await tempDir(t, "vision-native-restore-");
  const userDataDir = path.join(temp, "user");
  const calls: ToolCall[] = [];
  const runtime = sourceRuntime(userDataDir, {
    runtimeId: "vision_restore_test",
    runFile: databaseToolRunFile(calls, (command, [file]) => {
      assert.equal(command, "verify");
      if (verifyFails) throw new Error("integrity_check failed");
      return reportFor(String(file));
    }),
  });
  await runtime.ensureLayout();
  const original = sqliteFile(3, "original");
  await fs.promises.writeFile(runtime.paths.database, original);
  await fs.promises.writeFile(`${runtime.paths.database}-wal`, "original-wal");
  const candidate = path.join(temp, "restore.sqlite3");
  const candidateContents = sqliteFile(3, "candidate");
  await fs.promises.writeFile(candidate, candidateContents);
  return { runtime, userDataDir, calls, original, candidate, candidateContents };
}

async function generations(userDataDir: string, kind: string): Promise<string[]> {
  return (await fs.promises.readdir(userDataDir)).filter((name) =>
    name.startsWith(`database.${kind}-`),
  );
}

void test("restore activation verifies a staged copy and swaps whole database generations", async (t) => {
  const { runtime, userDataDir, calls, original, candidate, candidateContents } =
    await restoreFixture(t);
  const { switchToken, validation } = await runtime.activateRestoredDatabase(
    candidate,
    { expectedSchemaVersion: 3, expectedSha256: sha256(candidateContents) },
  );
  // The tool verified the staged copy, never the caller's file.
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.operands[0],
    path.join(switchToken.activatedDirectory, "vision.sqlite3"),
  );
  assert.equal(validation.sha256, sha256(candidateContents));
  assert.deepEqual(await fs.promises.readFile(runtime.paths.database), candidateContents);
  assert.equal(fs.existsSync(`${runtime.paths.database}-wal`), false);
  assert.equal(switchToken.version, 2);
  assert.equal(switchToken.kind, "sqlite-directory");
  assert.equal(switchToken.liveDirectory, runtime.paths.databaseDir);
  assert.deepEqual(
    await fs.promises.readFile(
      path.join(switchToken.previousDirectory, "vision.sqlite3"),
    ),
    original,
  );
  assert.equal(
    await fs.promises.readFile(
      path.join(switchToken.previousDirectory, "vision.sqlite3-wal"),
      "utf8",
    ),
    "original-wal",
  );
  assert.deepEqual((await runtime.readState())?.pendingDatabaseSwitch, switchToken);
  assert.deepEqual(await generations(userDataDir, "restore"), []);

  const finalized = await runtime.finalizeDatabaseSwitch(switchToken);
  assert.equal(finalized.status, "finalized");
  const state = await runtime.readState();
  assert.equal(state?.pendingDatabaseSwitch, undefined);
  assert.equal(state?.previousDatabase, switchToken.previousDirectory);
  assert.ok(fs.existsSync(switchToken.previousDirectory));
});

void test("restore activation refuses a copy that does not match the backup metadata", async (t) => {
  const { runtime, userDataDir, original, candidate, candidateContents } =
    await restoreFixture(t);
  await assert.rejects(
    runtime.activateRestoredDatabase(candidate, {
      expectedSha256: "0".repeat(64),
    }),
    hasCode("DATABASE_CHECKSUM_MISMATCH"),
  );
  await assert.rejects(
    runtime.activateRestoredDatabase(candidate, {
      expectedSchemaVersion: 4,
      expectedSha256: sha256(candidateContents),
    }),
    hasCode("DATABASE_SCHEMA_MISMATCH"),
  );
  assert.deepEqual(await fs.promises.readFile(runtime.paths.database), original);
  assert.equal((await runtime.readState())?.pendingDatabaseSwitch, undefined);
  assert.deepEqual(await generations(userDataDir, "restore"), []);
  assert.deepEqual(await generations(userDataDir, "previous"), []);
});

void test("restore activation leaves the live database alone when verification fails", async (t) => {
  const { runtime, userDataDir, original, candidate } = await restoreFixture(t, {
    verifyFails: true,
  });
  await assert.rejects(
    runtime.activateRestoredDatabase(candidate),
    hasCode("DATABASE_VERIFY_FAILED"),
  );
  assert.deepEqual(await fs.promises.readFile(runtime.paths.database), original);
  assert.deepEqual(await generations(userDataDir, "restore"), []);
  await assert.rejects(
    runtime.activateRestoredDatabase(path.join(userDataDir, "missing.sqlite3")),
    hasCode("ENOENT"),
  );
});

void test("rolling back an activated restore puts the previous generation back and keeps the failed one", async (t) => {
  const { runtime, userDataDir, original, candidate, candidateContents } =
    await restoreFixture(t);
  const { switchToken } = await runtime.activateRestoredDatabase(candidate);
  const result = await runtime.rollbackDatabaseSwitch(switchToken);
  assert.deepEqual(await fs.promises.readFile(runtime.paths.database), original);
  assert.equal(
    await fs.promises.readFile(`${runtime.paths.database}-wal`, "utf8"),
    "original-wal",
  );
  assert.ok(result.preservedFailedDatabase);
  assert.deepEqual(
    await fs.promises.readFile(
      path.join(result.preservedFailedDatabase, "vision.sqlite3"),
    ),
    candidateContents,
  );
  assert.equal((await runtime.readState())?.pendingDatabaseSwitch, undefined);
  assert.deepEqual(await generations(userDataDir, "previous"), []);
});

void test("a tampered restore journal can never rename a directory outside the database generations", async (t) => {
  const { runtime, userDataDir, original } = await restoreFixture(t);
  const outside = path.join(path.dirname(userDataDir), "elsewhere");
  await fs.promises.mkdir(outside);
  for (const token of [
    {
      version: 2,
      kind: "sqlite-directory",
      liveDirectory: runtime.paths.databaseDir,
      previousDirectory: outside,
      activatedDirectory: path.join(userDataDir, "database.restore-1"),
    },
    {
      version: 2,
      kind: "sqlite-directory",
      liveDirectory: path.join(userDataDir, "other"),
      previousDirectory: path.join(userDataDir, "database.previous-1"),
      activatedDirectory: path.join(userDataDir, "database.restore-1"),
    },
  ]) {
    await assert.rejects(
      runtime.rollbackDatabaseSwitch(token),
      /No matching native database switch/,
    );
  }
  assert.ok(fs.existsSync(outside));
  assert.deepEqual(await fs.promises.readFile(runtime.paths.database), original);
});

for (const phase of ["before", "between", "after"] as const) {
  void test(`startup recovers a restore interrupted ${phase} the generation renames`, async (t) => {
    const temp = await tempDir(t, "vision-restore-recovery-");
    const userDataDir = path.join(temp, "user");
    const runtime = sourceRuntime(userDataDir, {
      runtimeId: "vision_recovery_test",
    });
    await runtime.ensureLayout();
    const live = runtime.paths.databaseDir;
    const previous = path.join(userDataDir, "database.previous-1-fixture");
    const activated = path.join(userDataDir, "database.restore-1-fixture");
    const write = async (dir: string, contents: string) => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, "vision.sqlite3"), contents);
    };
    await fs.promises.rm(live, { recursive: true, force: true });
    if (phase === "before") {
      await write(live, "original");
      await write(activated, "candidate");
    }
    if (phase === "between") {
      await write(previous, "original");
    }
    if (phase === "after") {
      await write(previous, "original");
      await write(live, "candidate");
    }
    await runtime.writeState({
      activeRuntime: "native",
      pendingDatabaseSwitch: {
        version: 2,
        kind: "sqlite-directory",
        liveDirectory: live,
        previousDirectory: previous,
        activatedDirectory: activated,
        activatedAt: new Date().toISOString(),
      },
    });
    await runtime.ensureDatabaseReady();
    assert.equal(
      await fs.promises.readFile(runtime.paths.database, "utf8"),
      "original",
    );
    assert.equal(fs.existsSync(previous), false);
    assert.equal((await runtime.readState())?.pendingDatabaseSwitch, undefined);
    await runtime.ensureDatabaseReady();
    assert.equal(
      await fs.promises.readFile(runtime.paths.database, "utf8"),
      "original",
    );
  });
}

void test("a Vision 2.0 PostgreSQL restore journal is left for Vision 2.0", async (t) => {
  const temp = await tempDir(t, "vision-restore-v1-journal-");
  const runtime = sourceRuntime(temp, { runtimeId: "vision_v1_journal" });
  await runtime.ensureLayout();
  await fs.promises.writeFile(runtime.paths.database, sqliteFile(1));
  const v1 = {
    version: 1,
    liveDatabase: "vision",
    previousDatabase: "vision_previous_1",
    activatedDatabase: "vision_restore_1",
  };
  await runtime.writeState({ pendingDatabaseSwitch: v1 });
  await runtime.ensureDatabaseReady();
  assert.deepEqual((await runtime.readState())?.pendingDatabaseSwitch, v1);
  assert.ok(fs.existsSync(runtime.paths.database));
});

void test("finalizing a restore keeps only the newest previous generations", async (t) => {
  const temp = await tempDir(t, "vision-restore-prune-");
  const runtime = sourceRuntime(temp, { runtimeId: "vision_prune" });
  await runtime.ensureLayout();
  const names = [1, 2, 3, 4, 5].map((n) => `database.previous-${n}-old`);
  for (const [index, name] of names.entries()) {
    const dir = path.join(temp, name);
    await fs.promises.mkdir(dir);
    const time = new Date(Date.UTC(2026, 0, index + 1));
    await fs.promises.utimes(dir, time, time);
  }
  await fs.promises.mkdir(path.join(temp, "database.failed-1-keep"));
  await runtime.finalizeDatabaseSwitch({
    version: 2,
    kind: "sqlite-directory",
    liveDirectory: runtime.paths.databaseDir,
    previousDirectory: path.join(temp, "database.previous-5-old"),
    activatedDirectory: path.join(temp, "database.restore-5-old"),
  });
  assert.deepEqual((await generations(temp, "previous")).sort(), [
    "database.previous-3-old",
    "database.previous-4-old",
    "database.previous-5-old",
  ]);
  assert.ok(fs.existsSync(path.join(temp, "database.failed-1-keep")));
});

void test("attachment replacement verifies content and atomically replaces the destination", async (t) => {
  const temp = await tempDir(t, "vision-attachment-swap-");
  const source = path.join(temp, "source");
  const destination = path.join(temp, "attachments");
  await fs.promises.mkdir(path.join(source, "10"), { recursive: true });
  await fs.promises.writeFile(path.join(source, "10", "new.pdf"), "new-content");
  await fs.promises.mkdir(path.join(destination, "9"), { recursive: true });
  await fs.promises.writeFile(path.join(destination, "9", "old.pdf"), "old-content");

  const before = await directoryFingerprint(source);
  const result = await atomicReplaceDirectory(source, destination);
  const after = await directoryFingerprint(destination);

  assert.equal(result.digest, before.digest);
  assert.equal(after.digest, before.digest);
  await assert.rejects(fs.promises.access(path.join(destination, "9", "old.pdf")));
});

void test("native port discovery rejects a foreign listener", async () => {
  const emitter = new EventEmitter();
  const fakeServer: PortProbeServer = Object.assign(emitter, {
    unref: () => {},
    listen: () => emitter.emit("error", { code: "EADDRINUSE" }),
    // A foreign listener fails before the probe would close its server.
    close: () => {},
  });
  assert.equal(await isPortFree(3002, "127.0.0.1", () => fakeServer), false);
});

void test("detailed readiness requires the backend database connection", () => {
  assert.equal(isDetailedHealthReady({ database: { connected: true } }), true);
  assert.equal(isDetailedHealthReady({ database: { connected: false } }), false);
  assert.equal(isDetailedHealthReady({ database: true }), false);
});

void test("native activation ignores retired legacy-install evidence", async (t) => {
  const temp = await tempDir(t, "vision-native-guard-");
  const embedded = path.join(temp, "embedded_compose");
  await fs.promises.mkdir(embedded, { recursive: true });
  await fs.promises.writeFile(path.join(embedded, ".env"), "redacted-test-placeholder\n");
  const runtime = sourceRuntime(temp, { runtimeId: "vision_guard_test" });
  const state = await runtime.assertNativeActive();
  assert.equal(state?.activeRuntime, "native");
  assert.equal(state.activation, "fresh-install");
});

void test("packaged native payload verification rejects modified files", async (t) => {
  const temp = await tempDir(t, "vision-native-manifest-");
  const payload = path.join(temp, "payload@18+safe.txt");
  await fs.promises.writeFile(payload, "expected");
  const digest = sha256("expected");
  await fs.promises.writeFile(
    path.join(temp, "manifest.json"),
    JSON.stringify({
      version: 1,
      entries: [{ path: "payload@18+safe.txt", bytes: 8, sha256: digest }],
    }),
  );
  assert.equal(
    (await verifyRuntimeManifest(temp, { required: true })).status,
    "verified",
  );
  await fs.promises.writeFile(path.join(temp, "unlisted.txt"), "extra");
  await assert.rejects(
    verifyRuntimeManifest(temp, { required: true }),
    hasCode("NATIVE_RUNTIME_CORRUPT"),
  );
  await fs.promises.rm(path.join(temp, "unlisted.txt"));
  await fs.promises.symlink(payload, path.join(temp, "payload-link.txt"));
  await assert.rejects(
    verifyRuntimeManifest(temp, { required: true }),
    hasCode("NATIVE_RUNTIME_CORRUPT"),
  );
  await fs.promises.rm(path.join(temp, "payload-link.txt"));
  await fs.promises.writeFile(payload, "modified");
  await assert.rejects(
    verifyRuntimeManifest(temp, { required: true }),
    hasCode("NATIVE_RUNTIME_CORRUPT"),
  );
});
