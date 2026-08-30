"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { parsePostgresMajor, parsePostgresVersionNumber } = require("./native");
const { NATIVE_APPLICATION_ENV_KEYS } = require("./native");
const { DATABASE_STATS_SQL, parseDatabaseStats } = require("./database-stats");

const DOCKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
];

function dockerChildEnv() {
  const env = {};
  for (const key of DOCKER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":");
  return env;
}

function resolveDockerBinary(explicitPath) {
  const candidates = [
    explicitPath,
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed location.
    }
  }
  const error = new Error("Docker CLI was not found in a supported location");
  error.code = "DOCKER_NOT_FOUND";
  throw error;
}

function runDocker(args, { cwd, timeout = 60_000, dockerBin } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new TypeError("Docker arguments must be a string array");
  return new Promise((resolve, reject) => {
    execFile(
      dockerBin || resolveDockerBinary(),
      args,
      {
        cwd,
        timeout,
        env: dockerChildEnv(),
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            String(stderr || error.message || "Docker command failed")
              .replace(
                /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
                "$1***$2",
              )
              .trim(),
          );
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}

function parseSourceEnv(contents) {
  const values = {};
  for (const line of String(contents || "").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  let user = values.POSTGRES_USER || "ftm_user";
  let database = values.POSTGRES_DB || "financial_transactions";
  const rawUrl = values.DATABASE_URL_MIGRATIONS || values.DATABASE_URL;
  if (rawUrl) {
    const parsed = new URL(rawUrl);
    user = decodeURIComponent(parsed.username) || user;
    database =
      decodeURIComponent(parsed.pathname.replace(/^\//, "")) || database;
  }
  if (!/^[A-Za-z0-9_]{1,63}$/.test(user))
    throw new Error("Docker source database user is invalid");
  if (!/^[A-Za-z0-9_]{1,63}$/.test(database))
    throw new Error("Docker source database name is invalid");
  return { user, database };
}

function createDockerSource(options) {
  const workDir = path.resolve(options.workDir);
  const composeFiles = [
    path.join(workDir, "docker-compose.yml"),
    ...(options.overrideFiles || []).map((file) => path.resolve(file)),
  ];
  for (const file of composeFiles) {
    if (!fs.existsSync(file))
      throw new Error(`Compose file not found: ${file}`);
  }
  const composeArgs = composeFiles.flatMap((file) => ["-f", file]);
  const runner = options.runDocker || runDocker;
  const spawnProcess = options.spawnProcess || spawn;
  const dockerBin =
    options.dockerBin || resolveDockerBinary(options.dockerPath);

  async function databaseIdentity() {
    const contents = await fs.promises.readFile(
      path.join(workDir, ".env"),
      "utf8",
    );
    return parseSourceEnv(contents);
  }

  async function readApplicationEnv() {
    const contents = await fs.promises.readFile(
      path.join(workDir, ".env"),
      "utf8",
    );
    const values = {};
    for (const line of contents.split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && NATIVE_APPLICATION_ENV_KEYS.includes(match[1]))
        values[match[1]] = match[2];
    }
    return values;
  }

  async function compose(extra, runOptions = {}) {
    return runner(["compose", ...composeArgs, ...extra], {
      cwd: workDir,
      dockerBin,
      ...runOptions,
    });
  }

  async function assertAvailable() {
    await runner(["info"], { cwd: workDir, timeout: 10_000, dockerBin });
    const dbContainer = (
      await compose(["ps", "-q", "db"], {
        timeout: 10_000,
      })
    ).trim();
    if (!dbContainer) {
      const error = new Error(
        "The Docker PostgreSQL service is not running. Start only the existing db service with `docker compose up -d --no-deps db`, then rerun preflight.",
      );
      error.code = "DOCKER_DB_NOT_RUNNING";
      throw error;
    }
    const version = await compose(
      ["exec", "-T", "db", "postgres", "--version"],
      { timeout: 10_000 },
    );
    if (parsePostgresMajor(version) !== 18) {
      const error = new Error("Docker source must run PostgreSQL 18");
      error.code = "POSTGRES_WRONG_VERSION";
      throw error;
    }
    return {
      postgresMajor: 18,
      serverVersionNum: parsePostgresVersionNumber(version),
    };
  }

  async function stopWriter() {
    await compose(["stop", "app"], { timeout: 60_000 });
  }

  async function assertWriterStopped() {
    const running = await compose(["ps", "--status", "running", "-q", "app"], {
      timeout: 10_000,
    });
    if (running.trim()) {
      const error = new Error("Docker application writer is still running");
      error.code = "SPLIT_BRAIN_SOURCE_WRITER_RUNNING";
      throw error;
    }
  }

  async function captureStats() {
    const { user, database } = await databaseIdentity();
    const output = await compose(
      [
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        user,
        "-d",
        database,
        "--tuples-only",
        "--no-align",
        "--field-separator",
        "\t",
        "--quiet",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        DATABASE_STATS_SQL,
      ],
      { timeout: 60_000 },
    );
    return parseDatabaseStats(output);
  }

  async function dumpCustom(destination) {
    const { user, database } = await databaseIdentity();
    const finalPath = path.resolve(destination);
    const partialPath = `${finalPath}.partial`;
    await fs.promises.mkdir(path.dirname(finalPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.promises.unlink(partialPath).catch(() => {});
    await new Promise((resolve, reject) => {
      const args = [
        "compose",
        ...composeArgs,
        "exec",
        "-T",
        "db",
        "pg_dump",
        "-U",
        user,
        "-d",
        database,
        "--format=custom",
        "--no-owner",
        "--no-acl",
      ];
      const child = spawnProcess(dockerBin, args, {
        cwd: workDir,
        env: dockerChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = fs.createWriteStream(partialPath, { mode: 0o600 });
      const stderr = [];
      let stderrBytes = 0;
      child.stdout.pipe(output);
      child.stderr.on("data", (chunk) => {
        if (stderrBytes < 1024 * 1024) stderr.push(chunk);
        stderrBytes += chunk.length;
      });
      child.once("error", (error) => {
        output.destroy();
        reject(error);
      });
      child.once("close", (code) => {
        if (code !== 0) {
          output.destroy();
          reject(
            new Error(
              Buffer.concat(stderr).toString().trim() ||
                `Docker pg_dump exited ${code}`,
            ),
          );
          return;
        }
        output.end(resolve);
      });
    });
    const stat = await fs.promises.stat(partialPath);
    if (stat.size <= 0) {
      await fs.promises.unlink(partialPath).catch(() => {});
      throw new Error("Docker PostgreSQL dump is empty");
    }
    await fs.promises.rename(partialPath, finalPath);
    return { path: finalPath, bytes: stat.size };
  }

  async function exportAttachments(destination) {
    const target = path.resolve(destination);
    await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
    await compose(["cp", "app:/app/data/attachments/.", target], {
      timeout: 10 * 60_000,
    });
  }

  async function stopStack() {
    await compose(["stop"], { timeout: 120_000 });
  }

  async function startWriter() {
    await compose(["start", "db", "app"], { timeout: 120_000 });
  }

  return Object.freeze({
    workDir,
    assertAvailable,
    stopWriter,
    assertWriterStopped,
    captureStats,
    dumpCustom,
    exportAttachments,
    stopStack,
    startWriter,
    readApplicationEnv,
  });
}

module.exports = {
  dockerChildEnv,
  resolveDockerBinary,
  runDocker,
  parseSourceEnv,
  createDockerSource,
};
