"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  safeChildEnv,
  validateArgs,
  parsePostgresMajor,
  parsePostgresVersionNumber,
  classifyDatabaseSwitchState,
  revisionNumericPrefix,
  pickHighestRevision,
  assertPostgres18Version,
  bundledPostgresBin,
  discoverPostgres18,
  runtimeNames,
  RUNTIME_MANAGED_MATERIALIZED_VIEWS,
  nativeEnvContents,
  materializedViewOwnershipSql,
  databaseConfigFromEnv,
  validateApplicationEnv,
  buildNativeBackendEnv,
  assertNativeChromeAvailable,
  bundledChromiumPath,
  isPortFree,
  isDetailedHealthReady,
  managedPostgresArgs,
  verifyRuntimeManifest,
  directoryFingerprint,
  atomicReplaceDirectory,
  createNativeRuntime,
} = require("./native");

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

async function createBundledPostgresFixture(temp) {
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

function postgresFixtureRunFile(calls = []) {
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
    assert.doesNotMatch(env.PATH, /postgresql@18\/bin/);
  } finally {
    if (previous === undefined) delete process.env.VISION_TEST_SECRET;
    else process.env.VISION_TEST_SECRET = previous;
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
    (error) => error.code === "POSTGRES_WRONG_VERSION",
  );
});

test("schema revision selection is deterministic across legacy multi-head rows", () => {
  assert.equal(revisionNumericPrefix("0087_example"), 87);
  assert.equal(revisionNumericPrefix("hash_revision"), undefined);
  assert.equal(
    pickHighestRevision(["0099_second", "0100_first", "0098_old"]),
    "0100_first",
  );
  assert.equal(pickHighestRevision(["0100_alpha", "0100_beta"]), "0100_beta");
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
      (error) => error.code === "POSTGRES_NOT_FOUND",
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
      (error) => error.code === "POSTGRES_RUNTIME_MISMATCH",
    );

    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, binRelative: "../../bin" }),
    );
    assert.throws(
      () => bundledPostgresBin(fixture.runtimeRoot),
      (error) => error.code === "POSTGRES_RUNTIME_MISMATCH",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("managed PostgreSQL initializes a private loopback-only cluster with argument arrays", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-init-"),
  );
  const calls = [];
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeRoot: path.resolve(__dirname, "..", "..", ".."),
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_init",
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
      chromePath: "/bin/echo",
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeRoot: path.resolve(__dirname, "..", "..", ".."),
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_recovery",
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeRoot: path.resolve(__dirname, "..", "..", ".."),
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_collision",
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
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
    await assert.rejects(
      runtime.ensurePostgresReady(),
      (error) => error.code === "POSTGRES_PORT_COLLISION",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("managed PostgreSQL shutdown targets only Vision's exact data directory", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-pg-managed-stop-"),
  );
  const calls = [];
  try {
    const fixture = await createBundledPostgresFixture(temp);
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeRoot: path.resolve(__dirname, "..", "..", ".."),
      postgresRuntimeRoot: fixture.runtimeRoot,
      runtimeId: "vision_managed_stop",
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
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

test("restore ownership handoff is limited to runtime-managed materialized views", () => {
  const sql = materializedViewOwnershipSql("vision_test_app");
  for (const view of RUNTIME_MANAGED_MATERIALIZED_VIEWS) {
    assert.match(
      sql,
      new RegExp(
        `ALTER MATERIALIZED VIEW IF EXISTS "public"\\."${view}" OWNER TO "vision_test_app";`,
      ),
    );
  }
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
  const calls = [];
  try {
    await fs.promises.mkdir(binDir);
    for (const tool of POSTGRES_TOOLS) {
      await fs.promises.writeFile(path.join(binDir, tool), "test", {
        mode: 0o755,
      });
    }
    const dumpPath = path.join(temp, "source.dump");
    await fs.promises.writeFile(dumpPath, "synthetic custom dump");
    const runFile = async (executable, args) => {
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
      if (
        command.includes("SELECT 1 FROM pg_roles") ||
        command.includes("SELECT 1 FROM pg_database")
      ) {
        return { stdout: "1\n", stderr: "" };
      }
      if (command.includes("SELECT version_num FROM alembic_version")) {
        return { stdout: "0064_example\n42\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const runtime = createNativeRuntime({
      userDataDir: path.join(temp, "user-data"),
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeId: "vision_restore_owner_test",
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
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
    const restoreTarget =
      calls[restoreIndex].args[calls[restoreIndex].args.indexOf("-d") + 1];
    const ownershipCall = calls[ownershipIndex];
    assert.equal(
      ownershipCall.args[ownershipCall.args.indexOf("--dbname") + 1],
      restoreTarget,
    );
    const ownershipSql =
      ownershipCall.args[ownershipCall.args.indexOf("--command") + 1];
    assert.match(ownershipSql, /OWNER TO "vision_restore_owner_test_app"/);
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
          repoRoot: path.resolve(__dirname, "..", "..", ".."),
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
  const calls = [];
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeId: "vision_port_test",
      postgresBinDir: binDir,
      postgresPort: 55_432,
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
        throw new Error("Unexpected process call");
      },
    });

    await runtime.ensurePostgresReady({ startService: false });
    const probes = calls.filter(({ args }) => args[0] !== "--version");
    assert.equal(probes.length, 2);
    for (const { args } of probes) {
      assert.deepEqual(args.slice(0, 4), ["-h", "127.0.0.1", "-p", "55432"]);
    }
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("native application environment accepts only fixed keys and single-line values", () => {
  assert.deepEqual(
    validateApplicationEnv({
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "existing-admin-token",
      ADMIN_TOKEN: "wrong-contract",
      UNRELATED_SECRET: "drop",
    }),
    {
      FRED_API_KEY: "key",
      ADMIN_AUTH_TOKEN: "existing-admin-token",
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
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
  const child = new EventEmitter();
  child.pid = 123_456;
  let unreferenced = false;
  child.unref = () => {
    unreferenced = true;
  };
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
    let spawned;
    const runtime = createNativeRuntime({
      userDataDir: temp,
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeId: "vision_start_test",
      appPort: 43_210,
      postgresBinDir: binDir,
      bunPath: "/bin/echo",
      alembicPath: "/bin/echo",
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
    assert.equal(spawned.bin, "/bin/echo");
    assert.deepEqual(spawned.args, ["run", "apps/node-backend/src/main.js"]);
    assert.equal(spawned.options.env.SERVER_HOST, "127.0.0.1");
    assert.equal((await runtime.readState()).activeRuntime, "native");
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("packaged backend environment pins native data, migration, browser, and loopback paths", () => {
  const runtimeRoot =
    "/Applications/Vision.app/Contents/Resources/native-runtime";
  const env = buildNativeBackendEnv({
    runtimeEnv: {
      DATABASE_URL: "postgresql://vision_app:redacted@127.0.0.1:5432/vision",
      DATABASE_URL_MIGRATIONS:
        "postgresql://vision_owner:redacted@127.0.0.1:5432/vision",
    },
    port: 43123,
    paths: {
      attachments:
        "/Users/test/Library/Application Support/Vision/native/vision/attachments",
      cache:
        "/Users/test/Library/Application Support/Vision/native/vision/cache",
    },
    runtimeRoot,
    tools: {
      alembic: "/opt/homebrew/bin/alembic",
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
  });

  assert.equal(env.SERVER_HOST, "127.0.0.1");
  assert.equal(env.PORT, "43123");
  assert.equal(env.VISION_RUNTIME_ROOT, runtimeRoot);
  assert.equal(env.VISION_DIST_DIR, path.join(runtimeRoot, "dist"));
  assert.equal(
    env.ALEMBIC_CONFIG,
    path.join(runtimeRoot, "config", "alembic.ini"),
  );
  assert.equal(env.ALEMBIC_BIN, "/opt/homebrew/bin/alembic");
  assert.equal(env.VISION_SKIP_CONFIG_ENV_LOCAL, "true");
  assert.equal(env.OLLAMA_URL, "http://127.0.0.1:11434");
  assert.equal(env.ADMIN_ALLOW_TOKENLESS_NONLOOPBACK, "false");
  assert.equal(
    env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
    (error) => error.code === "NATIVE_CHROMIUM_NOT_FOUND",
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
      (error) => error.code === "CHROMIUM_RUNTIME_MISMATCH",
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
  const fakeServer = new EventEmitter();
  fakeServer.unref = () => {};
  fakeServer.listen = () => fakeServer.emit("error", { code: "EADDRINUSE" });
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

test("native activation guard blocks an existing Docker installation without a cutover marker", async () => {
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeId: "vision_guard_test",
    });
    await assert.rejects(
      runtime.assertNativeActive(),
      (error) => error.code === "NATIVE_CUTOVER_REQUIRED",
    );
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
    const digest = require("node:crypto")
      .createHash("sha256")
      .update("expected")
      .digest("hex");
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
      (error) => error.code === "NATIVE_RUNTIME_CORRUPT",
    );
    await fs.promises.rm(path.join(temp, "unlisted.txt"));
    await fs.promises.symlink(payload, path.join(temp, "payload-link.txt"));
    await assert.rejects(
      verifyRuntimeManifest(temp, { required: true }),
      (error) => error.code === "NATIVE_RUNTIME_CORRUPT",
    );
    await fs.promises.rm(path.join(temp, "payload-link.txt"));
    await fs.promises.writeFile(payload, "modified");
    await assert.rejects(
      verifyRuntimeManifest(temp, { required: true }),
      (error) => error.code === "NATIVE_RUNTIME_CORRUPT",
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
      repoRoot: path.resolve(__dirname, "..", "..", ".."),
      runtimeId: "vision_corrupt_dump",
      postgresBinDir: binDir,
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
      (error) => error.code === "INVALID_POSTGRES_DUMP",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
