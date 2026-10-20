import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createAuditAnchor } from "../audit-anchor";
import { appRoot } from "../paths";
import {
  safeChildEnv,
  recordUpdateDecisionThroughNativeRuntime,
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
  assertNativeChromeAvailable,
  bundledChromiumPath,
  isPortFree,
  isDetailedHealthReady,
  lastStartupError,
  managedPostgresArgs,
  verifyRuntimeManifest,
  directoryFingerprint,
  atomicReplaceDirectory,
  createNativeRuntime,
  type AuditWitness,
  type PortProbeServer,
  type RunFile,
  type SpawnedChild,
  type UpdateDecisionPayload,
} from "./native";

const repoRoot = path.resolve(appRoot, "..", "..");

interface ProcessCall {
  executable: string;
  args: string[];
}

interface AuditCall {
  endpoint: string;
  payload: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isRecord(error) && error.code === code;
}

const syntheticSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};

const syntheticWitnesses = new Map<string, AuditWitness>();
function fakeWitness(userDataDir: string): AuditWitness {
  const key = path.resolve(userDataDir);
  let witness = syntheticWitnesses.get(key);
  if (!witness) {
    let value: unknown;
    witness = {
      read: async () => value && structuredClone(value),
      create: async (next: unknown) => {
        if (value) throw new Error("witness exists");
        value = structuredClone(next);
      },
      replace: async (next: unknown) => {
        if (!value) throw new Error("witness missing");
        value = structuredClone(next);
      },
    };
    syntheticWitnesses.set(key, witness);
  }
  return witness;
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

test("safeChildEnv carries only the declared host environment plus explicit overrides", () => {
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

test("managed PostgreSQL uses a portable locale instead of the host locale", () => {
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
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("process execution arguments must remain an array of strings", () => {
  assert.deepEqual(validateArgs(["-h", "127.0.0.1"]), ["-h", "127.0.0.1"]);
  assert.throws(() => validateArgs("psql -h 127.0.0.1"), /string array/);
  assert.throws(() => validateArgs(["-h", 42]), /string array/);
});

test("managed PostgreSQL disables Unix sockets and binds only loopback TCP", () => {
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

test("PostgreSQL discovery accepts major 18 and rejects older tools", () => {
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

test("database switch recovery classifies every atomic rename interruption point", () => {
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

test("PostgreSQL discovery fails when a required version-18 tool is absent", async () => {
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
        runFile: async () => ({ stdout: "PostgreSQL 18.6", stderr: "" }),
      }),
      hasCode("POSTGRES_NOT_FOUND"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("bundled PostgreSQL metadata is pinned and cannot traverse the payload", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-metadata-"),
  );
  try {
    const fixture = await createBundledPostgresFixture(temp);
    assert.equal(bundledPostgresBin(fixture.runtimeRoot), fixture.binDir);

    const metadataPath = path.join(fixture.postgresRoot, "runtime.json");
    const metadata = JSON.parse(
      await fs.promises.readFile(metadataPath, "utf8"),
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

test("managed PostgreSQL initializes a private loopback-only cluster with argument arrays", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-init-"),
  );
  const calls: ProcessCall[] = [];
  const auditCalls: AuditCall[] = [];
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeRoot: repoRoot,
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_init",
      bunPath: "/bin/echo",
      chromePath: "/bin/echo",
      runFile: postgresFixtureRunFile(calls),
      auditBridgeToken: "a".repeat(64),
      auditSafeStorage: syntheticSafeStorage,
      auditWitness: fakeWitness(path.join(temp, "user-data")),
      auditPlatform: "darwin",
      auditRequest: async (endpoint, payload) => {
        auditCalls.push({ endpoint, payload });
        return endpoint === "verify"
          ? {
              status: "unavailable",
              sequence: 1,
              hash: "b".repeat(64),
              legacyCutover: {
                dbEditorMaxId: 0,
                splitMaxId: 0,
                retagMaxId: 0,
              },
              legacyUnverified: {
                dbEditor: "0",
                split: "0",
                portfolioRetag: "0",
              },
            }
          : { id: 1 };
      },
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
    assert.equal(
      (await runtime.verifyAuditHistory({ establishSession: true })).status,
      "verified",
    );
    assert.equal(auditCalls[1]?.endpoint, "checkpoint");
    assert.equal(auditCalls[1]?.payload.sequence, 1);
    assert.equal(runtime.auditClosureEnabled(), true);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("native PostgreSQL bootstraps query-statistics observability", () => {
  assert.deepEqual(REQUIRED_POSTGRES_EXTENSIONS, [
    "pg_trgm",
    "pgcrypto",
    "pg_stat_statements",
  ]);
});

test("managed PostgreSQL provisions roles, database and extensions in one session", async () => {
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
      chromePath: "/bin/echo",
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

test("managed PostgreSQL upgrades observability config for an existing cluster", async () => {
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
      chromePath: "/bin/echo",
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

test("managed PostgreSQL restarts a warm cluster after observability config changes", async () => {
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
      chromePath: "/bin/echo",
      isPortFree: async () => true,
      spawnPostgresProcess: () => {
        spawned = true;
        return child;
      },
      runFile: async (executable, args) => {
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
      },
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

test("managed PostgreSQL quarantines an interrupted first initialization before retrying", async () => {
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
      chromePath: "/bin/echo",
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

test("managed PostgreSQL fails closed when its private port is occupied", async () => {
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
      chromePath: "/bin/echo",
      isPortFree: async () => false,
      runFile: async (executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_isready")
          throw new Error("not ready");
        return { stdout: "", stderr: "" };
      },
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

test("managed PostgreSQL shutdown targets only Vision's exact data directory", async () => {
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
      chromePath: "/bin/echo",
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

test("generated native environment is loopback-only and separates owner/application roles", () => {
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

test("native analysis credentials follow the configured executor and reject foreign targets", () => {
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

test("restore ownership handoff is limited to runtime-managed materialized views", () => {
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

test("database activation applies materialized-view ownership inside the staging database", async () => {
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
    const runFile: RunFile = async (executable, args) => {
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
    };
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: repoRoot,
      runtimeId: "vision_restore_owner_test",
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      chromePath: "/bin/echo",
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

test("native seed SQL is applied transactionally with an argument array", async () => {
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
      chromePath: "/bin/echo",
      runFile: async (executable, args) => {
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
      },
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

test("native runtime rejects invalid PostgreSQL ports before creating state", () => {
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

test("native PostgreSQL readiness pins every probe to one loopback TCP port", async () => {
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
      chromePath: "/bin/echo",
      runFile: async (executable, args) => {
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
            arg.includes?.("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "pg_stat_statements\n", stderr: "" };
        }
        throw new Error("Unexpected process call");
      },
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

test("external PostgreSQL fails with an actionable observability prerequisite", async () => {
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
      chromePath: "/bin/echo",
      runFile: async (executable, args) => {
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
            arg.includes?.("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "auto_explain\n", stderr: "" };
        }
        throw new Error("Unexpected process call");
      },
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

test("native application environment accepts only fixed keys and single-line values", () => {
  assert.deepEqual(
    validateApplicationEnv({
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "existing-admin-token",
      OPENAI_API_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-openai-key",
      ADMIN_TOKEN: "wrong-contract",
      UNRELATED_SECRET: "drop",
    }),
    {
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "existing-admin-token",
      OPENAI_API_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-openai-key",
    },
  );
  assert.throws(
    () => validateApplicationEnv({ FRED_API_KEY: "bad\nvalue" }),
    /Invalid value/,
  );
});

test("native first-start layout is restrictive and safely resumable", async () => {
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

test("native first start persists and unreferences an argument-array backend child", async () => {
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
      chromePath: "/bin/echo",
      isPortFree: async () => true,
      runFile: async (executable, args) => {
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
            arg.includes?.("SHOW server_version_num; SHOW listen_addresses;"),
          )
        ) {
          return { stdout: "180006\nlocalhost\n/test/data\n", stderr: "" };
        }
        if (args.includes("SHOW shared_preload_libraries;")) {
          return { stdout: "pg_stat_statements\n", stderr: "" };
        }
        if (
          args.some((arg) => arg.includes?.("SELECT 1 FROM pg_roles")) ||
          args.some((arg) => arg.includes?.("SELECT 1 FROM pg_database"))
        ) {
          return { stdout: "1\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
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

test("startup error is read from the last failed backend start in the log", () => {
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

test("packaged backend environment pins native data, migration, browser, and loopback paths", () => {
  const runtimeRoot =
    "/Applications/Vision.app/Contents/Resources/native-runtime";
  const env = buildNativeBackendEnv({
    runtimeEnv: {
      DATABASE_URL: "postgresql://vision_app:redacted@127.0.0.1:5432/vision",
      DATABASE_URL_MIGRATIONS:
        "postgresql://vision_owner:redacted@127.0.0.1:5432/vision",
      OPENAI_API_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-key",
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
    auditBridgeToken: "a".repeat(64),
    tools: {
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
  });

  assert.equal(env.SERVER_HOST, "127.0.0.1");
  assert.equal(env.PORT, "43123");
  assert.equal(env.VISION_RUNTIME_ROOT, runtimeRoot);
  assert.equal(env.VISION_DIST_DIR, path.join(runtimeRoot, "dist"));
  assert.equal(env.OLLAMA_URL, "http://127.0.0.1:11434");
  assert.equal(env.ADMIN_ALLOW_TOKENLESS_NONLOOPBACK, "false");
  assert.equal(env.OPENAI_API_ENABLED, "true");
  assert.equal(env.OPENAI_API_KEY, "synthetic-key");
  assert.equal(
    env.VISION_NATIVE_ENV_FILE,
    "/Users/test/Library/Application Support/Vision/native/vision/runtime.env",
  );
  assert.equal(env.VISION_AUDIT_BRIDGE_TOKEN, "a".repeat(64));
  assert.equal(
    env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("packaged OpenAI drops its key unless explicitly enabled", () => {
  const common = {
    port: 43123,
    paths: {
      env: "/tmp/vision-runtime.env",
      attachments: "/tmp/attachments",
      cache: "/tmp/cache",
    },
    runtimeRoot: "/tmp/native-runtime",
    tools: { chrome: "/tmp/chrome" },
  };
  for (const runtimeEnv of [
    { OPENAI_API_ENABLED: "false", OPENAI_API_KEY: "synthetic-key" },
    { OPENAI_API_ENABLED: "true" },
  ]) {
    const env = buildNativeBackendEnv({ ...common, runtimeEnv });
    assert.equal(env.OPENAI_API_ENABLED, "false");
    assert.equal(env.OPENAI_API_KEY, undefined);
  }
});

test("native audit verification rejects a changed legacy cutover even with the same chain head", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  });
  await anchor.initializeGenesis(cutover);
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async (endpoint) => {
      assert.equal(endpoint, "verify");
      return {
        status: "verified",
        sequence: 0,
        hash: "0".repeat(64),
        legacyCutover: { ...cutover, splitMaxId: 1 },
      };
    },
  });
  assert.equal(await runtime.auditRequiresAnchoredClosure(), true);
  assert.deepEqual(await runtime.verifyAuditHistory(), {
    status: "failed",
    reason: "legacy_cutover_changed",
  });
  await assert.rejects(runtime.assertRestoredAuditHistory(), {
    code: "RESTORED_AUDIT_INTEGRITY_FAILED",
  });
});

test("native audit read supplies the external receipt and rejects mismatched cutover", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-read-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  });
  await anchor.initializeGenesis(cutover);
  let changed = false;
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async (endpoint, payload) => {
      assert.equal(endpoint, "read");
      assert.deepEqual(payload.trustedCheckpoint, {
        sequence: 0,
        hash: "0".repeat(64),
      });
      return {
        verification: {
          status: "verified",
          sequence: 0,
          hash: "0".repeat(64),
          anchoredThrough: 0,
          legacyCutover: { ...cutover, splitMaxId: changed ? 1 : 0 },
        },
        entries: [],
        hasMore: false,
      };
    },
  });
  assert.equal(
    (await runtime.readVerifiedAuditEntries()).verification.status,
    "verified",
  );
  changed = true;
  assert.deepEqual(await runtime.readVerifiedAuditEntries(), {
    verification: {
      status: "failed",
      reason: "audit_read_verification_failed",
    },
    entries: [],
    hasMore: false,
  });
});

test("native restore rejects an absent anchor without creating one", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditRequest: async () => ({
      status: "unavailable",
      sequence: 0,
      hash: "0".repeat(64),
      legacyUnverified: { dbEditor: "0", split: "0", portfolioRetag: "0" },
      legacyCutover: { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 },
    }),
  });
  assert.equal((await runtime.verifyAuditHistory()).status, "unavailable");
  assert.equal(await runtime.auditRequiresAnchoredClosure(), false);
  await assert.rejects(runtime.assertRestoredAuditHistory(), {
    code: "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
  });
  assert.equal(fs.existsSync(path.join(userDataDir, "audit-anchor")), false);
});

test("explicit enrollment of an existing chain records a forward-looking baseline", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const witness = fakeWitness(userDataDir);
  const cutover = { dbEditorMaxId: 2, splitMaxId: 1, retagMaxId: 0 };
  const head = { sequence: 3, hash: "b".repeat(64) };
  const recorded = [];
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: witness,
    auditPlatform: "darwin",
    auditRequest: async (endpoint, payload) => {
      if (endpoint === "checkpoint") {
        recorded.push(payload);
        return { id: 1 };
      }
      return {
        status: payload.trustedCheckpoint ? "verified" : "unavailable",
        ...head,
        legacyCutover: cutover,
        legacyUnverified: { dbEditor: "2", split: "1", portfolioRetag: "0" },
      };
    },
  });
  assert.equal(
    (await runtime.verifyAuditHistory()).reason,
    "no_trusted_anchor",
  );
  assert.deepEqual(await runtime.enrollExistingAuditHistory(), {
    status: "verified",
    enrollmentSequence: 3,
  });
  assert.equal(runtime.auditClosureEnabled(), true);
  assert.equal(recorded.length, 1);
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness,
    platform: "darwin",
  });
  assert.equal(
    (await anchor.readTrustedCheckpoint()).metadata.enrollmentSequence,
    3,
  );
  assert.equal(
    (await runtime.enrollExistingAuditHistory()).reason,
    "already_enrolled",
  );
});

test("native startup leaves a verified but unanchored tail unpromoted", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  });
  await anchor.initializeGenesis(cutover);
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async () => ({
      status: "partially_verified",
      sequence: 1,
      hash: "b".repeat(64),
      legacyCutover: cutover,
    }),
  });
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "partially_verified",
  );
  assert.equal(runtime.auditClosureEnabled(), false);
  assert.equal((await anchor.readTrustedCheckpoint()).sequence, 0);
  await assert.rejects(runtime.assertRestoredAuditHistory(), {
    code: "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
  });
});

test("verified live session closes an honest write before same-device restore", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  });
  await anchor.initializeGenesis(cutover);
  let head = { sequence: 0, hash: "0".repeat(64) };
  const recorded = [];
  let bridgeUnavailable = false;
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async (endpoint, payload) => {
      if (bridgeUnavailable) throw new Error("temporary bridge failure");
      if (endpoint === "checkpoint") {
        recorded.push(payload);
        return { id: recorded.length };
      }
      const trusted = payload.trustedCheckpoint;
      assert.ok(isRecord(trusted));
      return {
        status:
          trusted.sequence === head.sequence
            ? "verified"
            : "partially_verified",
        ...head,
        legacyCutover: cutover,
      };
    },
  });
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "verified",
  );
  assert.equal(runtime.auditClosureEnabled(), true);
  assert.equal(await runtime.auditRequiresAnchoredClosure(), true);
  head = { sequence: 1, hash: "b".repeat(64) };
  assert.equal((await runtime.closeAuditCheckpoint()).status, "verified");
  assert.equal((await anchor.readTrustedCheckpoint()).sequence, 1);
  assert.equal(recorded.length, 2);
  await runtime.pauseAuditClosure();
  assert.equal((await runtime.assertRestoredAuditHistory()).status, "verified");
  runtime.resumeAuditClosure();
  runtime.endAuditSession();
  assert.equal(runtime.auditSessionPending(), true);
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "verified",
  );
  assert.equal(runtime.auditClosureEnabled(), true);
  bridgeUnavailable = true;
  await assert.rejects(
    runtime.closeAuditCheckpoint(),
    /temporary bridge failure/,
  );
  assert.equal(runtime.auditClosureEnabled(), false);
  assert.equal(runtime.auditSessionPending(), true);
  bridgeUnavailable = false;
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "verified",
  );
  assert.equal(runtime.auditClosureEnabled(), true);
  runtime.endAuditSession();
  assert.equal(await runtime.auditRequiresAnchoredClosure(), true);
  head = { sequence: 2, hash: "c".repeat(64) };
  assert.equal(
    (await runtime.closeAuditCheckpoint()).reason,
    "live_closure_not_active",
  );
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "partially_verified",
  );
  assert.equal(runtime.auditClosureEnabled(), false);
  assert.equal((await anchor.readTrustedCheckpoint()).sequence, 1);
});

test("transient first audit request can retry and establish the live session", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  await createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  }).initializeGenesis(cutover);
  let attempts = 0;
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary bridge failure");
      return {
        status: "verified",
        sequence: 0,
        hash: "0".repeat(64),
        legacyCutover: cutover,
      };
    },
  });
  await assert.rejects(
    runtime.verifyAuditHistory({ establishSession: true }),
    /temporary bridge failure/,
  );
  assert.equal(runtime.auditSessionPending(), true);
  assert.equal(
    (await runtime.verifyAuditHistory({ establishSession: true })).status,
    "verified",
  );
  assert.equal(runtime.auditSessionPending(), false);
  assert.equal(runtime.auditClosureEnabled(), true);
});

test("native updater sends only the decision payload through the private audit bridge", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const requests: AuditCall[] = [];
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditRequest: async (endpoint, payload) => {
      requests.push({ endpoint, payload });
      return { id: 1 };
    },
  });
  await runtime.recordAuditUpdateDecision({
    decision: "checksum_verified",
    mode: "native",
    version: "v1.2.3",
  });
  assert.deepEqual(requests, [
    {
      endpoint: "update-decision",
      payload: {
        decision: "checksum_verified",
        mode: "native",
        version: "v1.2.3",
      },
    },
  ]);
});

test("source development updates skip an absent native bridge while native updates fail closed", async () => {
  const decision = {
    decision: "checksum_verified",
    mode: "dev",
    version: "v1.2.3",
  };
  assert.equal(
    await recordUpdateDecisionThroughNativeRuntime(undefined, decision),
    undefined,
  );
  await assert.rejects(
    recordUpdateDecisionThroughNativeRuntime(undefined, {
      ...decision,
      mode: "native",
    }),
    /Native update audit bridge is unavailable/,
  );
  const calls: Array<[string, UpdateDecisionPayload?]> = [];
  await recordUpdateDecisionThroughNativeRuntime(
    {
      mode: "native",
      recordAuditUpdateDecision: async (payload) =>
        calls.push(["record", payload]),
      auditRequiresAnchoredClosure: async () => true,
      closeAuditCheckpoint: async () => {
        calls.push(["checkpoint"]);
        return { status: "verified" };
      },
    },
    decision,
  );
  assert.deepEqual(calls, [["record", decision], ["checkpoint"]]);
});

test("native update decisions close the live audit checkpoint before installation continues", async () => {
  const calls: string[] = [];
  const runtime = {
    mode: "native",
    auditRequiresAnchoredClosure: () => true,
    recordAuditUpdateDecision: async (payload: UpdateDecisionPayload) => {
      calls.push(`record:${payload.decision}`);
    },
    closeAuditCheckpoint: async () => {
      calls.push("checkpoint");
      return { status: "verified" };
    },
  };
  for (const decision of [
    "checksum_verified",
    "checksum_failed",
    "install_requested",
  ]) {
    await recordUpdateDecisionThroughNativeRuntime(runtime, {
      decision,
      mode: "native",
      version: "v1.2.3",
    });
  }
  assert.deepEqual(calls, [
    "record:checksum_verified",
    "checkpoint",
    "record:checksum_failed",
    "checkpoint",
    "record:install_requested",
    "checkpoint",
  ]);
});

test("native installation is blocked when its update decision cannot be anchored", async () => {
  const calls: string[] = [];
  await assert.rejects(
    recordUpdateDecisionThroughNativeRuntime(
      {
        mode: "native",
        auditRequiresAnchoredClosure: () => true,
        recordAuditUpdateDecision: async () => calls.push("record"),
        closeAuditCheckpoint: async () => {
          calls.push("checkpoint");
          return { status: "unavailable" };
        },
      },
      {
        decision: "install_requested",
        mode: "native",
        version: "v1.2.3",
      },
    ),
    { code: "AUDIT_UPDATE_CHECKPOINT_UNAVAILABLE" },
  );
  assert.deepEqual(calls, ["record", "checkpoint"]);
});

test("native update remains available on an existing install without an external anchor", async () => {
  const calls: string[] = [];
  const result = await recordUpdateDecisionThroughNativeRuntime(
    {
      mode: "native",
      auditRequiresAnchoredClosure: () => false,
      recordAuditUpdateDecision: async () => {
        calls.push("record");
        return { id: 7 };
      },
      closeAuditCheckpoint: async () => {
        calls.push("checkpoint");
        return { status: "verified" };
      },
    },
    {
      decision: "install_requested",
      mode: "native",
      version: "v1.2.3",
    },
  );
  assert.deepEqual(calls, ["record"]);
  assert.deepEqual(result, { auditStatus: "unavailable", recorded: { id: 7 } });
});

test("explicit restore recovery accepts a checked older or inter-tick chain without lowering the anchor", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const cutover = { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 };
  const anchor = createAuditAnchor({
    userDataDir,
    safeStorage,
    witness: fakeWitness(userDataDir),
    platform: "darwin",
  });
  await anchor.initializeFirstCheckpoint(
    { sequence: 2, hash: "a".repeat(64) },
    cutover,
  );
  let candidate = "older";
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditPlatform: "darwin",
    auditRequest: async (endpoint, payload) => {
      assert.equal(endpoint, "verify");
      if (payload.trustedCheckpoint) {
        return candidate === "older"
          ? { status: "failed", reason: "rollback" }
          : {
              status: "partially_verified",
              sequence: 3,
              hash: "b".repeat(64),
              legacyCutover: cutover,
            };
      }
      return {
        status: "unavailable",
        sequence: candidate === "older" ? 1 : 3,
        hash: candidate === "older" ? "c".repeat(64) : "b".repeat(64),
        legacyCutover: cutover,
      };
    },
  });
  await assert.rejects(runtime.assertRestoredAuditHistory(), {
    code: "RESTORED_AUDIT_INTEGRITY_FAILED",
  });
  assert.equal(
    (await runtime.assertRestoredAuditHistory({ allowUnverifiedAudit: true }))
      .status,
    "unavailable",
  );
  assert.equal((await anchor.readTrustedCheckpoint()).sequence, 2);
  candidate = "inter-tick";
  await assert.rejects(runtime.assertRestoredAuditHistory(), {
    code: "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
  });
  assert.equal(
    (await runtime.assertRestoredAuditHistory({ allowUnverifiedAudit: true }))
      .status,
    "unavailable",
  );
  assert.equal((await anchor.readTrustedCheckpoint()).sequence, 2);
});

test("explicit recovery rejects a tampered audit chain", async (t) => {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-audit-"),
  );
  t.after(() => fs.promises.rm(userDataDir, { recursive: true, force: true }));
  const safeStorage = syntheticSafeStorage;
  const runtime = createNativeRuntime({
    userDataDir,
    auditBridgeToken: "a".repeat(64),
    auditSafeStorage: safeStorage,
    auditWitness: fakeWitness(userDataDir),
    auditRequest: async () => ({ status: "failed", reason: "head_mismatch" }),
  });
  await assert.rejects(
    runtime.assertRestoredAuditHistory({ allowUnverifiedAudit: true }),
    {
      code: "RESTORED_AUDIT_RECOVERY_INVALID",
    },
  );
});

test("native backend startup requires a supported browser for PDF reports", () => {
  assert.equal(
    assertNativeChromeAvailable(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  assert.throws(
    () => assertNativeChromeAvailable(undefined),
    hasCode("NATIVE_CHROMIUM_NOT_FOUND"),
  );
});

test("packaged Chromium discovery is pinned and rejects metadata traversal", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-chromium-metadata-"),
  );
  const chromiumRoot = path.join(temp, "chromium");
  const executable = path.join(chromiumRoot, "root", "chrome-headless-shell");
  const metadataPath = path.join(chromiumRoot, "runtime.json");
  try {
    await fs.promises.mkdir(path.dirname(executable), { recursive: true });
    await fs.promises.writeFile(executable, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const metadata = {
      version: 1,
      browser: "chrome-headless-shell",
      browserVersion: "150.0.7871.24",
      platform: process.platform,
      architecture: process.arch,
      executableRelative: "root/chrome-headless-shell",
    };
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata));
    assert.equal(bundledChromiumPath(temp), executable);

    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, executableRelative: "../../Chrome" }),
    );
    assert.throws(
      () => bundledChromiumPath(temp),
      hasCode("CHROMIUM_RUNTIME_MISMATCH"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("attachment replacement verifies content and atomically replaces the destination", async () => {
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

test("native port discovery rejects a foreign listener", async () => {
  const emitter = new EventEmitter();
  const fakeServer: PortProbeServer = Object.assign(emitter, {
    unref: () => {},
    listen: () => emitter.emit("error", { code: "EADDRINUSE" }),
    // A foreign listener fails before the probe would close its server.
    close: () => {},
  });
  assert.equal(await isPortFree(3002, "127.0.0.1", () => fakeServer), false);
});

test("detailed readiness requires the backend database connection", () => {
  assert.equal(isDetailedHealthReady({ database: { connected: true } }), true);
  assert.equal(
    isDetailedHealthReady({ database: { connected: false } }),
    false,
  );
  assert.equal(isDetailedHealthReady({ database: true }), false);
});

test("native activation ignores retired legacy-install evidence", async () => {
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
    assert.equal(state?.activation, "fresh-install");
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("packaged native payload verification rejects modified files", async () => {
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

test("native custom dump validation rejects corrupt or truncated input", async () => {
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
      chromePath: "/bin/echo",
      runFile: async (executable, args) => {
        if (args[0] === "--version") {
          return {
            stdout: `${path.basename(executable)} (PostgreSQL) 18.6`,
            stderr: "",
          };
        }
        if (path.basename(executable) === "pg_restore" && args[0] === "--list")
          throw new Error("archive ended unexpectedly");
        return { stdout: "", stderr: "" };
      },
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
  test(`startup recovers interrupted restore at ${phase} database renames before bootstrap`, async (t) => {
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
      chromePath: "/bin/echo",
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
          databases.set(rename[2], databases.get(rename[1])!);
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
