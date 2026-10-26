import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { appRoot } from "../paths";
import { must, parseJsonAs } from "../test-support";
import {
  safeChildEnv,
  managedPostgresChildEnv,
  validateArgs,
  parsePostgresMajor,
  parsePostgresVersionNumber,
  classifyDatabaseSwitchState,
  assertPostgres18Version,
  bundledPostgresBin,
  discoverPostgres18,
  runtimeNames,
  RUNTIME_MANAGED_MATERIALIZED_VIEWS,
  REQUIRED_POSTGRES_EXTENSIONS,
  nativeEnvContents,
  materializedViewOwnershipSql,
  databaseConfigFromEnv,
  validateApplicationEnv,
  buildNativeBackendEnv,
  isPortFree,
  isDetailedHealthReady,
  lastStartupError,
  managedPostgresArgs,
  MANAGED_POSTGRES_TUNING,
  verifyRuntimeManifest,
  directoryFingerprint,
  atomicReplaceDirectory,
  createNativeRuntime,
  type PortProbeServer,
  type RunFile,
  type RunFileResult,
  type SpawnedChild,
} from "./native";

const repoRoot = path.resolve(appRoot, "..", "..");

/** Adapts a synchronous fake to the async RunFile contract; a throw becomes a rejection. */
function fakeRunFile(
  fake: (executable: string, args: string[]) => RunFileResult,
): RunFile {
  return (executable, args) =>
    new Promise((resolve) => resolve(fake(executable, args)));
}

interface ProcessCall {
  executable: string;
  args: string[];
}

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

const POSTGRES_TOOLS = [
  "postgres",
  "initdb",
  "pg_ctl",
  "psql",
  "pg_dump",
  "pg_restore",
  "pg_isready",
  "createdb",
  "dropdb",
];

async function createBundledPostgresFixture(temp: string) {
  const runtimeRoot = path.join(temp, "native-runtime");
  const postgresRoot = path.join(runtimeRoot, "postgres");
  const binDir = path.join(postgresRoot, "root", "bin");
  await fs.promises.mkdir(binDir, { recursive: true });
  for (const tool of POSTGRES_TOOLS) {
    await fs.promises.writeFile(path.join(binDir, tool), "test", {
      mode: 0o755,
    });
  }
  await fs.promises.writeFile(
    path.join(postgresRoot, "runtime.json"),
    `${JSON.stringify({
      version: 1,
      postgresMajor: 18,
      postgresVersion: "18.6",
      platform: process.platform,
      architecture: process.arch,
      binRelative: "bin",
    })}\n`,
  );
  return { runtimeRoot, postgresRoot, binDir };
}

function postgresFixtureRunFile(calls: ProcessCall[] = []): RunFile {
  return async (executable, args) => {
    calls.push({ executable: path.basename(executable), args: [...args] });
    if (args[0] === "--version") {
      return {
        stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
        stderr: "",
      };
    }
    if (path.basename(executable) === "initdb") {
      const dataDirectory = args[args.indexOf("-D") + 1];
      assert.ok(dataDirectory);
      await fs.promises.mkdir(dataDirectory, { recursive: true });
      await fs.promises.writeFile(
        path.join(dataDirectory, "PG_VERSION"),
        "18\n",
      );
      await fs.promises.writeFile(
        path.join(dataDirectory, "postgresql.conf"),
        "# generated fixture\n",
      );
      return { stdout: "initialized", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

void test("safeChildEnv carries only the declared host environment plus explicit overrides", () => {
  const previous = process.env.VISION_TEST_SECRET;
  process.env.VISION_TEST_SECRET = "must-not-leak";
  try {
    const env = safeChildEnv({ PORT: 3456 });
    assert.equal(env.PORT, "3456");
    assert.equal(env.VISION_TEST_SECRET, undefined);
    assert.ok(env.PATH);
    assert.doesNotMatch(env.PATH, /postgresql@18\/bin/);
  } finally {
    if (previous === undefined) delete process.env.VISION_TEST_SECRET;
    else process.env.VISION_TEST_SECRET = previous;
  }
});

void test("managed PostgreSQL uses a portable locale instead of the host locale", () => {
  const previous = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
  };
  process.env.LANG = "invalid-host-locale";
  process.env.LC_ALL = "invalid-host-locale";
  process.env.LC_CTYPE = "invalid-host-locale";
  try {
    const env = managedPostgresChildEnv();
    assert.equal(env.LANG, "C");
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.LC_CTYPE, "C");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});

void test("process execution arguments must remain an array of strings", () => {
  assert.deepEqual(validateArgs(["-h", "127.0.0.1"]), ["-h", "127.0.0.1"]);
  assert.throws(() => validateArgs("psql -h 127.0.0.1"), /string array/);
  assert.throws(() => validateArgs(["-h", 42]), /string array/);
});

void test("managed PostgreSQL disables Unix sockets and binds only loopback TCP", () => {
  assert.deepEqual(
    managedPostgresArgs("/private/path with spaces/data", 54329),
    [
      "-D",
      "/private/path with spaces/data",
      "-h",
      "127.0.0.1",
      "-p",
      "54329",
      "-k",
      "",
    ],
  );
});

void test("PostgreSQL discovery accepts major 18 and rejects older tools", () => {
  assert.equal(parsePostgresMajor("pg_dump (PostgreSQL) 18.6"), 18);
  assert.equal(parsePostgresMajor("postgres (PostgreSQL) 18.1"), 18);
  assert.equal(
    parsePostgresVersionNumber("pg_dump (PostgreSQL) 18.6"),
    180_006,
  );
  assert.equal(
    assertPostgres18Version("pg_dump", "pg_dump (PostgreSQL) 18.6"),
    18,
  );
  assert.throws(
    () => assertPostgres18Version("pg_dump", "pg_dump (PostgreSQL) 17.5"),
    hasCode("POSTGRES_WRONG_VERSION"),
  );
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

void test("PostgreSQL discovery fails when a required version-18 tool is absent", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-discovery-"),
  );
  try {
    for (const tool of [
      "postgres",
      "psql",
      "pg_dump",
      "pg_isready",
      "createdb",
    ]) {
      const file = path.join(temp, tool);
      await fs.promises.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    await assert.rejects(
      discoverPostgres18({
        binDir: temp,
        runFile: () => Promise.resolve({ stdout: "PostgreSQL 18.6", stderr: "" }),
      }),
      hasCode("POSTGRES_NOT_FOUND"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("bundled PostgreSQL metadata is pinned and cannot traverse the payload", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-metadata-"),
  );
  try {
    const fixture = await createBundledPostgresFixture(temp);
    assert.equal(bundledPostgresBin(fixture.runtimeRoot), fixture.binDir);

    const metadataPath = path.join(fixture.postgresRoot, "runtime.json");
    const metadata = parseJsonAs(
      await fs.promises.readFile(metadataPath, "utf8"),
      isRecord,
      "runtime.json",
    );
    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, postgresVersion: "18.5" }),
    );
    assert.throws(
      () => bundledPostgresBin(fixture.runtimeRoot),
      hasCode("POSTGRES_RUNTIME_MISMATCH"),
    );

    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, binRelative: "../../bin" }),
    );
    assert.throws(
      () => bundledPostgresBin(fixture.runtimeRoot),
      hasCode("POSTGRES_RUNTIME_MISMATCH"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL initializes a private loopback-only cluster with argument arrays", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-init-"),
  );
  const calls: ProcessCall[] = [];
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_init",
      bunPath: "/bin/echo",
      runFile: postgresFixtureRunFile(calls),
    });
    await runtime.discover();
    const config = await runtime.ensureLayout();
    const result = await runtime.ensureManagedPostgresCluster(config);

    assert.equal(result.status, "initialized");
    assert.equal(
      (await fs.promises.stat(runtime.paths.postgresData)).mode & 0o777,
      0o700,
    );
    const initdb = calls.find((call) => call.executable === "initdb");
    assert.ok(initdb);
    assert.ok(Array.isArray(initdb.args));
    assert.ok(initdb.args.includes("--data-checksums"));
    assert.ok(initdb.args.includes("--auth-local=scram-sha-256"));
    assert.ok(initdb.args.includes("--auth-host=scram-sha-256"));
    assert.equal(
      initdb.args[initdb.args.indexOf("--username") + 1],
      "vision_managed_init_admin",
    );
    const configContents = await fs.promises.readFile(
      path.join(runtime.paths.postgresData, "vision.conf"),
      "utf8",
    );
    assert.match(
      configContents,
      /listen_addresses = '127\.0\.0\.1'[\s\S]*port = 54329/,
    );
    assert.match(configContents, /unix_socket_directories = ''/);
    assert.match(
      configContents,
      /shared_preload_libraries = 'pg_stat_statements'/,
    );
    for (const line of MANAGED_POSTGRES_TUNING) {
      assert.ok(configContents.split("\n").includes(line), line);
    }
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native PostgreSQL bootstraps query-statistics observability", () => {
  assert.deepEqual(REQUIRED_POSTGRES_EXTENSIONS, [
    "pg_trgm",
    "pgcrypto",
    "pg_stat_statements",
  ]);
});

void test("managed PostgreSQL provisions roles, database and extensions in one session", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-extension-bootstrap-"),
  );
  const calls: ProcessCall[] = [];
  const secretStatements: string[] = [];
  try {
    const { runtimeRoot } = await createBundledPostgresFixture(temp);
    const runtimeId = "vision_extension_bootstrap";
    const postgresData = path.join(
      temp,
      "user-data",
      "native",
      runtimeId,
      "postgres",
      "data",
    );
    const runFile: RunFile = async (executable, args) => {
      if (args.includes("--file")) {
        const sqlFile = args[args.indexOf("--file") + 1];
        assert.ok(sqlFile);
        secretStatements.push(await fs.promises.readFile(sqlFile, "utf8"));
      }
      calls.push({ executable: path.basename(executable), args: [...args] });
      if (args[0] === "--version") {
        return {
          stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
          stderr: "",
        };
      }
      if (path.basename(executable) === "pg_isready") {
        return { stdout: "accepting connections", stderr: "" };
      }
      const command = args[args.indexOf("--command") + 1] || "";
      if (command.includes("SHOW server_version_num")) {
        return {
          stdout: `180006\nlocalhost\n${postgresData}\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: runtimeRoot,
      runtimeId,
      bunPath: "/bin/echo",
      runFile,
    });
    await runtime.ensureLayout();
    await runtime.discover();
    await fs.promises.mkdir(postgresData, { recursive: true });
    await fs.promises.writeFile(path.join(postgresData, "PG_VERSION"), "18\n");
    await fs.promises.writeFile(
      path.join(postgresData, "postgresql.conf"),
      "# fixture\ninclude = 'vision.conf'\n",
    );
    await fs.promises.writeFile(
      path.join(postgresData, "vision.conf"),
      [
        "listen_addresses = '127.0.0.1'",
        "port = 54329",
        "unix_socket_directories = ''",
        "password_encryption = 'scram-sha-256'",
        "shared_preload_libraries = 'pg_stat_statements'",
        "logging_collector = off",
        ...MANAGED_POSTGRES_TUNING,
        "",
      ].join("\n"),
    );

    await runtime.bootstrapDatabase();

    assert.equal(secretStatements.length, 1);
    const sql = secretStatements[0] ?? "";
    for (const role of [
      `${runtimeId}_owner`,
      `${runtimeId}_app`,
      "vision_analysis_executor",
    ]) {
      assert.ok(
        sql.includes(
          `SELECT 'CREATE ROLE ${role} NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') \\gexec`,
        ),
        role,
      );
    }
    assert.match(
      sql,
      /ALTER ROLE vision_analysis_executor WITH LOGIN PASSWORD .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/,
    );
    assert.match(sql, /default_transaction_read_only = on/);
    assert.match(sql, /search_path = vision_analysis, pg_catalog/);
    assert.match(
      sql,
      new RegExp(
        `CREATE DATABASE ${runtimeId} OWNER "${runtimeId}_owner" TEMPLATE template0`,
      ),
    );
    // Extensions are installed by the cluster administrator inside the app database.
    const connect = sql.indexOf(`\\connect ${runtimeId}\n`);
    assert.ok(connect > 0);
    assert.ok(
      sql.indexOf("CREATE EXTENSION IF NOT EXISTS pg_stat_statements;") >
        connect,
    );
    const session = calls.find(({ args }) => args.includes("--file"));
    assert.ok(session);
    assert.equal(
      session.args[session.args.indexOf("-U") + 1],
      `${runtimeId}_admin`,
    );
    assert.ok(
      calls.every(({ args }) => !args.some((arg) => arg.includes("PASSWORD"))),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL upgrades observability config for an existing cluster", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-observability-upgrade-"),
  );
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_observability_upgrade",
      bunPath: "/bin/echo",
      runFile: postgresFixtureRunFile(),
    });
    await runtime.discover();
    const config = await runtime.ensureLayout();
    await fs.promises.mkdir(runtime.paths.postgresData, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "PG_VERSION"),
      "18\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "postgresql.conf"),
      "# existing cluster\ninclude = 'vision.conf'\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "vision.conf"),
      "logging_collector = off\n",
    );

    const first = await runtime.ensureManagedPostgresCluster(config);
    assert.equal(first.status, "existing");
    assert.equal(first.configChanged, true);
    const configContents = await fs.promises.readFile(
      path.join(runtime.paths.postgresData, "vision.conf"),
      "utf8",
    );
    assert.match(
      configContents,
      /shared_preload_libraries = 'pg_stat_statements'/,
    );
    const second = await runtime.ensureManagedPostgresCluster(config);
    assert.equal(second.configChanged, false);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL restarts a warm cluster after observability config changes", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-observability-restart-"),
  );
  const calls: ProcessCall[] = [];
  const child = fakeChild({ pid: 123_457, exitCode: null });
  try {
    const fixture = await createBundledPostgresFixture(temp);
    let spawned = false;
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_observability_restart",
      bunPath: "/bin/echo",
      isPortFree: () => Promise.resolve(true),
      spawnPostgresProcess: () => {
        spawned = true;
        return child;
      },
      runFile: fakeRunFile((executable, args) => {
        const command = path.basename(executable);
        calls.push({ executable: command, args: [...args] });
        if (args[0] === "--version") {
          return {
            stdout: `${command} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (command === "pg_isready") {
          return { stdout: "accepting connections", stderr: "" };
        }
        if (command === "psql") {
          return {
            stdout: `180006\nlocalhost\n${runtime.paths.postgresData}\n`,
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      }),
    });
    await runtime.ensureLayout();
    await fs.promises.mkdir(runtime.paths.postgresData, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "PG_VERSION"),
      "18\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "postgresql.conf"),
      "# existing cluster\ninclude = 'vision.conf'\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "vision.conf"),
      "logging_collector = off\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "postmaster.pid"),
      "999999\n",
    );

    await runtime.ensurePostgresReady();

    const stopIndex = calls.findIndex(
      ({ executable }) => executable === "pg_ctl",
    );
    assert.ok(stopIndex >= 0);
    assert.equal(spawned, true);
    assert.ok(
      calls.slice(0, stopIndex).some(({ executable }) => executable === "psql"),
      "the running server is inspected before it is stopped",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL quarantines an interrupted first initialization before retrying", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-recovery-"),
  );
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_recovery",
      bunPath: "/bin/echo",
      runFile: postgresFixtureRunFile(),
    });
    await runtime.discover();
    const config = await runtime.ensureLayout();
    await fs.promises.mkdir(runtime.paths.postgresData, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "interrupted"),
      "synthetic fixture",
    );

    await runtime.ensureManagedPostgresCluster(config);
    assert.equal(
      (
        await fs.promises.readFile(
          path.join(runtime.paths.postgresData, "PG_VERSION"),
          "utf8",
        )
      ).trim(),
      "18",
    );
    const entries = await fs.promises.readdir(runtime.paths.postgresRoot);
    assert.ok(entries.some((entry) => entry.startsWith("data.incomplete-")));
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL fails closed when its private port is occupied", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-collision-"),
  );
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_collision",
      bunPath: "/bin/echo",
      isPortFree: () => Promise.resolve(false),
      runFile: fakeRunFile((executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready")
          throw new Error("not ready");
        return { stdout: "", stderr: "" };
      }),
    });
    await runtime.ensureLayout();
    await fs.promises.mkdir(runtime.paths.postgresData, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "PG_VERSION"),
      "18\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "postgresql.conf"),
      "# existing cluster\ninclude = 'vision.conf'\n",
    );
    await assert.rejects(
      runtime.ensurePostgresReady(),
      hasCode("POSTGRES_PORT_COLLISION"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("managed PostgreSQL shutdown targets only Vision's exact data directory", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-stop-"),
  );
  const calls: ProcessCall[] = [];
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_stop",
      bunPath: "/bin/echo",
      runFile: postgresFixtureRunFile(calls),
    });
    await runtime.ensureLayout();
    await fs.promises.mkdir(runtime.paths.postgresData, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "PG_VERSION"),
      "18\n",
    );
    await fs.promises.writeFile(
      path.join(runtime.paths.postgresData, "postmaster.pid"),
      "999999\n",
    );

    await runtime.stopPostgres();
    const pgCtl = calls.find((call) => call.executable === "pg_ctl");
    assert.ok(pgCtl);
    assert.deepEqual(pgCtl.args, [
      "-D",
      runtime.paths.postgresData,
      "-m",
      "fast",
      "-w",
      "-t",
      "30",
      "stop",
    ]);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("generated native environment is loopback-only and separates owner/application roles", () => {
  const names = runtimeNames("vision_test");
  const config = databaseConfigFromEnv(nativeEnvContents(names));
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 54329);
  assert.equal(config.database, "vision_test");
  assert.equal(config.adminRole, "vision_test_admin");
  assert.equal(config.ownerRole, "vision_test_owner");
  assert.equal(config.appRole, "vision_test_app");
  assert.notEqual(config.ownerPassword, config.appPassword);
  assert.notEqual(config.adminPassword, config.ownerPassword);
  assert.match(config.ownerPassword, /^[0-9a-f]{64}$/);
});

void test("native analysis credentials follow the configured executor and reject foreign targets", () => {
  const contents = nativeEnvContents(runtimeNames("vision_test"));
  const config = databaseConfigFromEnv(contents);
  assert.equal(config.analysisPassword, config.appPassword);
  const custom =
    "postgresql://vision_analysis_executor:custom%27password@127.0.0.1:54329/vision_test";
  assert.equal(
    databaseConfigFromEnv(`${contents}DATABASE_URL_ANALYSIS=${custom}\n`)
      .analysisPassword,
    "custom'password",
  );
  for (const invalid of [
    custom.replace("vision_analysis_executor", "other"),
    custom.replace("127.0.0.1", "other.invalid"),
    custom.replace(":54329", ":54330"),
    custom.replace("/vision_test", "/other"),
  ]) {
    assert.throws(
      () =>
        databaseConfigFromEnv(`${contents}DATABASE_URL_ANALYSIS=${invalid}\n`),
      /fixed executor/,
    );
  }
});

void test("restore ownership handoff is limited to runtime-managed materialized views", () => {
  assert.deepEqual(RUNTIME_MANAGED_MATERIALIZED_VIEWS, [
    "mv_monthly_summary",
    "mv_category_totals",
  ]);
  const sql = materializedViewOwnershipSql("vision_test_app");
  for (const view of RUNTIME_MANAGED_MATERIALIZED_VIEWS) {
    assert.match(
      sql,
      new RegExp(
        `ALTER MATERIALIZED VIEW IF EXISTS "public"\\."${view}" OWNER TO "vision_test_app";`,
      ),
    );
  }
  assert.doesNotMatch(sql, /mv_cashflow_daily/);
  assert.doesNotMatch(sql, /GRANT\s+.*ROLE|ALTER\s+TABLE/i);
  assert.throws(
    () => materializedViewOwnershipSql("unsafe; role"),
    /Invalid PostgreSQL identifier/,
  );
});

void test("database activation applies materialized-view ownership inside the staging database", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-restore-ownership-"),
  );
  const binDir = path.join(temp, "bin");
  const calls: ProcessCall[] = [];
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of POSTGRES_TOOLS) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const dumpPath = path.join(temp, "source.dump");
    await fs.promises.writeFile(dumpPath, "synthetic custom dump");
    const runFile: RunFile = fakeRunFile((executable, args) => {
      calls.push({ executable: path.basename(executable), args: [...args] });
      if (args[0] === "--version") {
        return {
          stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
          stderr: "",
        };
      }
      const command = args[args.indexOf("--command") + 1] || "";
      if (path.basename(executable) === "pg_isready") {
        return { stdout: "accepting connections", stderr: "" };
      }
      if (command.includes("SHOW server_version_num")) {
        return { stdout: "180006\nlocalhost\n/external/data\n", stderr: "" };
      }
      if (command.includes("SHOW shared_preload_libraries")) {
        return { stdout: "pg_stat_statements\n", stderr: "" };
      }
      if (
        command.includes("SELECT 1 FROM pg_roles") ||
        command.includes("SELECT 1 FROM pg_database")
      ) {
        return { stdout: "1\n", stderr: "" };
      }
      if (command.includes("to_regclass('public.kysely_migration')")) {
        return { stdout: "t\n", stderr: "" };
      }
      if (command.includes("FROM public.kysely_migration")) {
        return { stdout: "0064_example\n", stderr: "" };
      }
      if (command.includes("FROM pg_catalog.pg_tables")) {
        return { stdout: "42\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeId: "vision_restore_owner_test",
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      runFile,
    });

    await runtime.activateRestoredDatabase(dumpPath, {
      format: "custom",
      expectedSchemaHead: "0064_example",
    });

    const restoreIndex = calls.findIndex(
      ({ executable, args }) =>
        executable === "pg_restore" && args.includes("-d"),
    );
    const ownershipIndex = calls.findIndex(({ executable, args }) => {
      const command = args[args.indexOf("--command") + 1] || "";
      return (
        executable === "psql" &&
        command.includes("ALTER MATERIALIZED VIEW IF EXISTS")
      );
    });
    assert.ok(restoreIndex >= 0);
    assert.ok(ownershipIndex > restoreIndex);
    const restoreCall = calls[restoreIndex];
    assert.ok(restoreCall);
    const restoreTarget = restoreCall.args[restoreCall.args.indexOf("-d") + 1];
    const stagingExtensionIndex = calls.findIndex(({ executable, args }) => {
      const command = args[args.indexOf("--command") + 1] || "";
      return (
        executable === "psql" &&
        args[args.indexOf("-d") + 1] === restoreTarget &&
        command.includes("CREATE EXTENSION")
      );
    });
    assert.ok(stagingExtensionIndex >= 0);
    assert.ok(stagingExtensionIndex < restoreIndex);
    assert.ok(restoreCall.args.includes("--no-comments"));
    const ownershipCall = calls[ownershipIndex];
    assert.ok(ownershipCall);
    assert.equal(
      ownershipCall.args[ownershipCall.args.indexOf("--dbname") + 1],
      restoreTarget,
    );
    const ownershipSql =
      ownershipCall.args[ownershipCall.args.indexOf("--command") + 1];
    assert.match(
      ownershipSql ?? "",
      /OWNER TO "vision_restore_owner_test_app"/,
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native seed SQL is applied transactionally with an argument array", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-seed-sql-"),
  );
  const calls: ProcessCall[] = [];
  try {
    const { binDir } = await createBundledPostgresFixture(temp);
    const runtimeId = "vision_seed_sql_test";
    const postgresData = path.join(
      temp,
      "user-data",
      "native",
      runtimeId,
      "postgres",
      "data",
    );
    const sqlPath = path.join(temp, "seed data.sql");
    await fs.promises.writeFile(sqlPath, "SELECT 1;\n");
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeId,
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      runFile: fakeRunFile((executable, args) => {
        calls.push({ executable: path.basename(executable), args: [...args] });
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready") {
          return { stdout: "accepting connections", stderr: "" };
        }
        const command = args[args.indexOf("--command") + 1] || "";
        if (command.includes("SHOW server_version_num")) {
          return {
            stdout: `180006\nlocalhost\n${postgresData}\n`,
            stderr: "",
          };
        }
        if (command.includes("SHOW shared_preload_libraries")) {
          return { stdout: "pg_stat_statements\n", stderr: "" };
        }
        if (
          command.includes("SELECT 1 FROM pg_roles") ||
          command.includes("SELECT 1 FROM pg_database")
        ) {
          return { stdout: "1\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
    });

    const result = await runtime.applyOwnerSqlFile(sqlPath);
    assert.equal(result.status, "applied");
    const applyCall = calls.find(
      ({ executable, args }) =>
        executable === "psql" && args.includes("--single-transaction"),
    );
    assert.ok(applyCall);
    assert.equal(applyCall.args[applyCall.args.indexOf("--file") + 1], sqlPath);
    assert.ok(applyCall.args.includes("ON_ERROR_STOP=1"));
    assert.equal(
      applyCall.args.some((arg) => arg.includes("SELECT 1;")),
      false,
    );

    const linkedSqlPath = path.join(temp, "linked-seed.sql");
    await fs.promises.symlink(sqlPath, linkedSqlPath);
    await assert.rejects(
      runtime.applyOwnerSqlFile(linkedSqlPath),
      hasCode("INVALID_POSTGRES_SEED"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native runtime rejects invalid PostgreSQL ports before creating state", () => {
  for (const postgresPort of [0, 65_536, 1.5, "not-a-port"]) {
    assert.throws(
      () =>
        createNativeRuntime({
          userDataDir: os.tmpdir(),
          repoRoot: repoRoot,
          runtimeId: "vision_invalid_port",
          postgresPort,
        }),
      /Invalid native PostgreSQL port/,
    );
  }
});

void test("native PostgreSQL readiness pins every probe to one loopback TCP port", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-port-"),
  );
  const binDir = path.join(temp, "bin");
  const calls: ProcessCall[] = [];
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of [
      "postgres",
      "initdb",
      "pg_ctl",
      "psql",
      "pg_dump",
      "pg_restore",
      "pg_isready",
      "createdb",
      "dropdb",
    ]) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_port_test",
      postgresBinDir: binDir,
      postgresPort: 55_432,
      bunPath: "/bin/echo",
      runFile: fakeRunFile((executable, args) => {
        calls.push({ executable: path.basename(executable), args });
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready") {
          return { stdout: "accepting connections", stderr: "" };
        }
        if (
          args.some((arg) =>
            arg.includes("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "pg_stat_statements\n", stderr: "" };
        }
        throw new Error("Unexpected process call");
      }),
    });

    await runtime.ensurePostgresReady({ startService: false });
    const probes = calls.filter(({ args }) => args[0] !== "--version");
    assert.equal(probes.length, 3);
    for (const { args } of probes) {
      assert.deepEqual(args.slice(0, 4), ["-h", "127.0.0.1", "-p", "55432"]);
    }
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("external PostgreSQL fails with an actionable observability prerequisite", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-external-observability-"),
  );
  const binDir = path.join(temp, "bin");
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of POSTGRES_TOOLS) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_external_observability",
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      runFile: fakeRunFile((executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready") {
          return { stdout: "accepting connections", stderr: "" };
        }
        if (
          args.some((arg) =>
            arg.includes("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "auto_explain\n", stderr: "" };
        }
        throw new Error("Unexpected process call");
      }),
    });

    await assert.rejects(
      runtime.ensurePostgresReady({ startService: false }),
      (error: unknown) =>
        hasCode("POSTGRES_OBSERVABILITY_UNAVAILABLE")(error) &&
        error instanceof Error &&
        error.message.includes("restart PostgreSQL"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native application environment accepts only fixed keys and single-line values", () => {
  assert.deepEqual(
    validateApplicationEnv({
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "retired-admin-token",
      OPENAI_API_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-openai-key",
      ADMIN_TOKEN: "wrong-contract",
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

void test("native first-start layout is restrictive and safely resumable", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-layout-"),
  );
  try {
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_layout_test",
    });
    const first = await runtime.ensureLayout();
    const firstEnv = await fs.promises.readFile(runtime.paths.env, "utf8");
    const second = await runtime.ensureLayout();
    const secondEnv = await fs.promises.readFile(runtime.paths.env, "utf8");
    assert.equal(secondEnv, firstEnv);
    assert.equal(second.database, first.database);
    assert.equal(
      (await fs.promises.stat(runtime.paths.nativeRoot)).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await fs.promises.stat(runtime.paths.env)).mode & 0o777,
      0o600,
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native layout strips retired secrets from an existing env file once", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-retired-env-"),
  );
  try {
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_retired_env_test",
    });
    await runtime.ensureLayout();
    const current = await fs.promises.readFile(runtime.paths.env, "utf8");
    await fs.promises.writeFile(
      runtime.paths.env,
      [
        current.replace(/\n$/, ""),
        "OPENAI_API_KEY=sk-synthetic-retired",
        "OPENAI_API_ENABLED=true",
        "AI_REFERENCE_MAPPING_KEY=synthetic-mapping-key",
        "FRED_API_KEY=kept",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    await runtime.ensureLayout();
    const cleaned = await fs.promises.readFile(runtime.paths.env, "utf8");
    assert.equal(cleaned, `${current}FRED_API_KEY=kept\n`);
    await runtime.ensureLayout();
    assert.equal(
      await fs.promises.readFile(runtime.paths.env, "utf8"),
      cleaned,
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native first start persists and unreferences an argument-array backend child", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-start-"),
  );
  const binDir = path.join(temp, "bin");
  let unreferenced = false;
  const child = fakeChild({ pid: 123_456 }, () => {
    unreferenced = true;
  });
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of [
      "postgres",
      "initdb",
      "pg_ctl",
      "psql",
      "pg_dump",
      "pg_restore",
      "pg_isready",
      "createdb",
      "dropdb",
    ]) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    let spawned:
      | {
          bin: string;
          args: string[];
          options: { env?: NodeJS.ProcessEnv | undefined };
        }
      | undefined;
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_start_test",
      appPort: 43_210,
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      isPortFree: () => Promise.resolve(true),
      runFile: fakeRunFile((executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready") {
          return { stdout: "accepting connections", stderr: "" };
        }
        if (
          args.some((arg) =>
            arg.includes("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "pg_stat_statements\n", stderr: "" };
        }
        if (
          args.some((arg) => arg.includes("SELECT 1 FROM pg_roles")) ||
          args.some((arg) => arg.includes("SELECT 1 FROM pg_database"))
        ) {
          return { stdout: "1\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      spawnProcess: (bin, args, options) => {
        spawned = { bin, args, options };
        return child;
      },
    });

    const result = await runtime.start();
    assert.equal(result.status, "started");
    assert.equal(unreferenced, true);
    assert.ok(spawned);
    assert.equal(spawned.bin, "/bin/echo");
    assert.deepEqual(spawned.args, ["run", "apps/node-backend/src/main.ts"]);
    assert.equal(spawned.options.env?.SERVER_HOST, "127.0.0.1");
    assert.equal((await runtime.readState())?.activeRuntime, "native");

    assert.equal(await runtime.backendStartupFailure(), undefined);
    await fs.promises.appendFile(
      runtime.paths.backendLog,
      `2026-10-19T18:45:42.511Z [ERROR] Failed to start application {"error":"Database has application objects but no migration marker"}\n`,
    );
    (child as unknown as EventEmitter).emit("exit");
    assert.equal(
      await runtime.backendStartupFailure(),
      "Database has application objects but no migration marker",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("start runs the pre-migration hook only when the database is behind the packaged chain", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-premigrate-"),
  );
  try {
    const binDir = path.join(temp, "bin");
    await fs.promises.mkdir(binDir);
    for (const tool of POSTGRES_TOOLS) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const runtimeRoot = path.join(temp, "runtime");
    const migrations = path.join(runtimeRoot, "db", "migrations");
    await fs.promises.mkdir(migrations, { recursive: true });
    for (const name of [
      "0001_baseline.sql",
      "0002_remove_cloud_ai.sql",
      "0002_remove_cloud_ai.down.sql",
      "0003_remove_life_scenarios.sql",
      "0009_future.down.sql",
    ]) {
      await fs.promises.writeFile(path.join(migrations, name), "SELECT 1;");
    }

    let totalSpawned = 0;
    const run = async (
      appliedHead: string,
      beforeMigrations: (pending: {
        appliedHead: string;
        packagedHead: string;
      }) => Promise<void>,
    ) => {
      let spawned = 0;
      const runtime = createNativeRuntime({
        userDataDir: path.join(temp, `user-${appliedHead || "fresh"}`),
        repoRoot,
        runtimeRoot,
        runtimeId: "vision_premigrate_test",
        appPort: 43_211,
        postgresBinDir: binDir,
        bunPath: "/bin/echo",
        isPortFree: () => Promise.resolve(true),
        runFile: fakeRunFile((executable, args) => {
          if (args[0] === "--version") {
            return {
              stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
              stderr: "",
            };
          }
          if (path.basename(executable) === "pg_isready") {
            return { stdout: "accepting connections", stderr: "" };
          }
          if (
            args.some((arg) =>
              arg.includes("SHOW server_version_num; SHOW listen_addresses;"),
            )
          ) {
            return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
          }
          if (args.includes("SHOW shared_preload_libraries;")) {
            return { stdout: "pg_stat_statements\n", stderr: "" };
          }
          if (args.some((arg) => arg.includes("to_regclass"))) {
            return { stdout: appliedHead ? "t\n" : "f\n", stderr: "" };
          }
          if (args.some((arg) => arg.includes("max(name)"))) {
            return { stdout: `${appliedHead}\n`, stderr: "" };
          }
          if (
            args.some((arg) => arg.includes("SELECT 1 FROM pg_roles")) ||
            args.some((arg) => arg.includes("SELECT 1 FROM pg_database"))
          ) {
            return { stdout: "1\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }),
        spawnProcess: () => {
          spawned += 1;
          totalSpawned += 1;
          return fakeChild({ pid: 223_344 });
        },
      });
      try {
        await runtime.start({ beforeMigrations });
      } finally {
        await fs.promises.unlink(runtime.paths.pid).catch(() => {});
      }
      return spawned;
    };

    const calls: { appliedHead: string; packagedHead: string }[] = [];
    const record = (pending: {
      appliedHead: string;
      packagedHead: string;
    }) => {
      calls.push(pending);
      return Promise.resolve();
    };
    assert.equal(await run("0002_remove_cloud_ai", record), 1);
    assert.deepEqual(calls, [
      {
        appliedHead: "0002_remove_cloud_ai",
        packagedHead: "0003_remove_life_scenarios",
      },
    ]);
    // Up to date, or a brand-new database without a ledger: no backup.
    assert.equal(await run("0003_remove_life_scenarios", record), 1);
    assert.equal(await run("", record), 1);
    assert.equal(calls.length, 1);

    // A failed backup must keep the migrating backend from starting.
    const spawnedBefore = totalSpawned;
    await assert.rejects(
      run("0001_baseline", () => Promise.reject(new Error("disk full"))),
      /disk full/,
    );
    assert.equal(totalSpawned, spawnedBefore);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
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

void test("packaged backend environment pins native data, migration, and loopback paths", () => {
  const runtimeRoot =
    "/Applications/Vision.app/Contents/Resources/native-runtime";
  const env = buildNativeBackendEnv({
    runtimeEnv: {
      DATABASE_URL: "postgresql://vision_app:redacted@127.0.0.1:5432/vision",
      DATABASE_URL_MIGRATIONS:
        "postgresql://vision_owner:redacted@127.0.0.1:5432/vision",
      OPENAI_API_KEY: "sk-synthetic-retired",
      OPENAI_API_ENABLED: "true",
      AI_REFERENCE_MAPPING_KEY: "synthetic-mapping-key",
      FRED_API_KEY: "kept",
    },
    port: 43123,
    paths: {
      env: "/Users/test/Library/Application Support/Vision/native/vision/runtime.env",
      attachments:
        "/Users/test/Library/Application Support/Vision/native/vision/attachments",
      cache:
        "/Users/test/Library/Application Support/Vision/native/vision/cache",
    },
    runtimeRoot,
  });

  assert.equal(env.SERVER_HOST, "127.0.0.1");
  assert.equal(env.PORT, "43123");
  assert.equal(env.VISION_RUNTIME_ROOT, runtimeRoot);
  assert.equal(env.VISION_DIST_DIR, path.join(runtimeRoot, "dist"));
  assert.equal(env.OLLAMA_URL, "http://127.0.0.1:11434");
  assert.equal(env.FRED_API_KEY, "kept");
  for (const retired of [
    "OPENAI_API_KEY",
    "OPENAI_API_ENABLED",
    "AI_REFERENCE_MAPPING_KEY",
  ]) {
    assert.equal(retired in env, false, retired);
  }
  assert.equal(
    env.VISION_NATIVE_ENV_FILE,
    "/Users/test/Library/Application Support/Vision/native/vision/runtime.env",
  );
});

void test("attachment replacement verifies content and atomically replaces the destination", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-attachment-swap-"),
  );
  const source = path.join(temp, "source");
  const destination = path.join(temp, "attachments");
  try {
    await fs.promises.mkdir(path.join(source, "10"), { recursive: true });
    await fs.promises.writeFile(
      path.join(source, "10", "new.pdf"),
      "new-content",
    );
    await fs.promises.mkdir(path.join(destination, "9"), { recursive: true });
    await fs.promises.writeFile(
      path.join(destination, "9", "old.pdf"),
      "old-content",
    );

    const before = await directoryFingerprint(source);
    const result = await atomicReplaceDirectory(source, destination);
    const after = await directoryFingerprint(destination);

    assert.equal(result.digest, before.digest);
    assert.equal(after.digest, before.digest);
    await assert.rejects(
      fs.promises.access(path.join(destination, "9", "old.pdf")),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
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
  assert.equal(
    isDetailedHealthReady({ database: { connected: false } }),
    false,
  );
  assert.equal(isDetailedHealthReady({ database: true }), false);
});

void test("native activation ignores retired legacy-install evidence", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-guard-"),
  );
  try {
    const embedded = path.join(temp, "embedded_compose");
    await fs.promises.mkdir(embedded, { recursive: true });
    await fs.promises.writeFile(
      path.join(embedded, ".env"),
      "redacted-test-placeholder\n",
    );
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_guard_test",
    });
    const state = await runtime.assertNativeActive();
    assert.equal(state?.activeRuntime, "native");
    assert.equal(state.activation, "fresh-install");
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("packaged native payload verification rejects modified files", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-manifest-"),
  );
  try {
    const payload = path.join(temp, "payload@18+safe.txt");
    await fs.promises.writeFile(payload, "expected");
    const digest = crypto.createHash("sha256").update("expected").digest("hex");
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
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("native custom dump validation rejects corrupt or truncated input", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-corrupt-dump-"),
  );
  const binDir = path.join(temp, "bin");
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of [
      "postgres",
      "initdb",
      "pg_ctl",
      "psql",
      "pg_dump",
      "pg_restore",
      "pg_isready",
      "createdb",
      "dropdb",
    ]) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const dumpPath = path.join(temp, "truncated.dump");
    await fs.promises.writeFile(dumpPath, "PGDMP-truncated");
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: repoRoot,
      runtimeId: "vision_corrupt_dump",
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      runFile: fakeRunFile((executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_restore" && args[0] === "--list")
          throw new Error("archive ended unexpectedly");
        return { stdout: "", stderr: "" };
      }),
    });
    await assert.rejects(
      runtime.validateCustomDump(dumpPath),
      hasCode("INVALID_POSTGRES_DUMP"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

for (const phase of ["before", "between", "after"] as const) {
  void test(`startup recovers interrupted restore at ${phase} database renames before bootstrap`, async (t) => {
    const temp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-restore-recovery-"),
    );
    t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
    const fixture = await createBundledPostgresFixture(temp);
    const databases = new Map<string, string>();
    const calls: ProcessCall[] = [];
    const fallback = postgresFixtureRunFile(calls);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user"),
      repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_recovery_test",
      bunPath: "/bin/echo",
      runFile: async (file, args, options) => {
        const sql = args[args.indexOf("--command") + 1] ?? "";
        if (sql.includes("SHOW server_version_num"))
          return {
            stdout: `180006\nlocalhost\n${runtime.paths.postgresData}\n`,
            stderr: "",
          };
        if (sql.includes("SHOW shared_preload_libraries"))
          return { stdout: "pg_stat_statements\n", stderr: "" };
        if (sql.startsWith("SELECT 1 FROM pg_database")) {
          const name = /datname = '([^']+)'/.exec(sql)?.[1] ?? "";
          return { stdout: databases.has(name) ? "1\n" : "", stderr: "" };
        }
        const rename = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(
          sql,
        );
        if (rename?.[1] && rename[2]) {
          assert.ok(databases.has(rename[1]));
          assert.equal(databases.has(rename[2]), false);
          databases.set(
            rename[2],
            must(databases.get(rename[1]), "the renamed database"),
          );
          databases.delete(rename[1]);
          return { stdout: "", stderr: "" };
        }
        if (sql.startsWith("CREATE DATABASE"))
          throw new Error("must not bootstrap a replacement database");
        return fallback(file, args, options);
      },
    });
    const config = await runtime.ensureLayout();
    await runtime.discover();
    await runtime.ensureManagedPostgresCluster(config);
    const live = config.database;
    const previous = `${live}_previous_fixture`;
    const activated = `${live}_restore_fixture`;
    if (phase === "before") {
      databases.set(live, "original");
      databases.set(activated, "candidate");
    }
    if (phase === "between") {
      databases.set(previous, "original");
      databases.set(activated, "candidate");
    }
    if (phase === "after") {
      databases.set(previous, "original");
      databases.set(live, "candidate");
    }
    await fs.promises.writeFile(
      runtime.paths.state,
      JSON.stringify({
        activeRuntime: "native",
        pendingDatabaseSwitch: {
          version: 1,
          liveDatabase: live,
          previousDatabase: previous,
          activatedDatabase: activated,
        },
      }),
    );
    await runtime.bootstrapDatabase();
    assert.equal(databases.get(live), "original");
    assert.equal((await runtime.readState())?.pendingDatabaseSwitch, undefined);
    await runtime.bootstrapDatabase();
    assert.equal(databases.get(live), "original");
  });
}
