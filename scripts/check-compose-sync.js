#!/usr/bin/env node
/**
 * Guards packaging/electron/resources/docker-compose.yml against drifting from
 * the root docker-compose.yml on the properties that decide which volumes a
 * user's data lives in and which PostgreSQL runtime starts against them:
 *
 *   1. the top-level `name:` (the compose project name) — every named volume is
 *      created as `<project>_<volume>`, so a project-name change silently points
 *      the packaged app at a different, empty database
 *   2. the top-level `volumes:` key set — omitting the attachments volume here
 *      is exactly the v1.0.2 data-loss bug
 *   3. the `db` service image and platform — a platform mismatch can select the
 *      broken ARM64 Postgres entrypoint instead of the validated amd64 image
 *   4. the port, database name, and role identity recorded in
 *      `config/stack-identity.json` — both Compose copies, Electron-generated
 *      URLs, and backend development defaults must match this canonical record
 *
 * This replaces two byte-identical copies of an inline awk one-liner (ci.yml's
 * verify-compose-sync job and release.yml's verify job) that could drift from
 * each other and had no local equivalent. Both workflows and .githooks/pre-push
 * now call this file instead.
 *
 * Why the hand-rolled parser: the two callers that matter most run with nothing
 * but a checkout — CI's verify-compose-sync job installs no toolchain, and the
 * git hook must work before `bun install` — so this stays stdlib-only, like
 * scripts/check-destructive-migrations.py. It reads exactly the two top-level
 * keys named above and understands indentation, block scalars and comments,
 * which is what the awk version got wrong: `awk '/^volumes:/{found=1}'` never
 * stopped at the next top-level block, so any key added after `volumes:` would
 * have been counted as a volume name.
 *
 * Usage (from anywhere):
 *   node scripts/check-compose-sync.js
 *   node scripts/check-compose-sync.js --self-test
 */
const { readFileSync } = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ROOT_COMPOSE = "docker-compose.yml";
const ELECTRON_COMPOSE = "packaging/electron/resources/docker-compose.yml";
const STACK_IDENTITY_FILE = "config/stack-identity.json";
const ELECTRON_MAIN = "packaging/electron/main.js";
const ELECTRON_COMPOSE_MODULE = "packaging/electron/compose.js";
const NATIVE_RUNTIME = "packaging/electron/runtime/native.js";
const NATIVE_DEVELOPMENT = "packaging/electron/scripts/native-development.js";
const NATIVE_DB_SMOKE = "packaging/electron/scripts/native-db-smoke.js";
const NATIVE_RUNTIME_CLI = "packaging/electron/scripts/native-runtime-cli.js";
const BACKEND_ENV = "apps/node-backend/src/config/env.js";
const POSTGRES_INIT = "docker/postgres-init/01-app-role.sh";

const KEY_RE = /^(\s*)([A-Za-z0-9_.-]+):(\s.*|)$/;
// `key: |`, `key: >-`, `key: |+2` … everything after the indicator is a block
// scalar whose *content* must never be read as YAML structure.
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** Strip a trailing `# comment`, but only when it is not inside a quoted value. */
function stripInlineComment(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const hash = trimmed.search(/(^|\s)#/);
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
}

function unquote(value) {
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value[value.length - 1] === value[0]
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readStackIdentity(text, label = STACK_IDENTITY_FILE) {
  let identity;
  try {
    identity = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }

  const integerKeys = ["defaultHostPort", "containerPort"];
  const stringKeys = [
    "bootstrapDatabaseUser",
    "applicationDatabaseUser",
    "databaseName",
  ];
  for (const key of integerKeys) {
    if (
      !Number.isInteger(identity[key]) ||
      identity[key] < 1 ||
      identity[key] > 65535
    ) {
      throw new Error(
        `${label}: '${key}' must be an integer port from 1 to 65535`,
      );
    }
  }
  for (const key of stringKeys) {
    if (
      typeof identity[key] !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(identity[key])
    ) {
      throw new Error(`${label}: '${key}' must be a lowercase SQL identifier`);
    }
  }
  if (identity.bootstrapDatabaseUser === identity.applicationDatabaseUser) {
    throw new Error(
      `${label}: bootstrapDatabaseUser and applicationDatabaseUser must differ`,
    );
  }
  return identity;
}

function oneMatch(text, regex, label) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one match, found ${matches.length}`,
    );
  }
  return matches[0].slice(1);
}

function composeServiceBlock(text, serviceName, label) {
  const lines = String(text).split(/\r?\n/);
  const servicesIndex = lines.findIndex((line) =>
    /^services:\s*(?:#.*)?$/.test(line),
  );
  if (servicesIndex === -1)
    throw new Error(`${label}: no top-level services block`);

  let serviceIndent;
  let start = -1;
  for (let index = servicesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    const match = KEY_RE.exec(line);
    if (!match) continue;
    if (serviceIndent === undefined) serviceIndent = indent;
    if (indent === serviceIndent && match[2] === serviceName) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) throw new Error(`${label}: no '${serviceName}' service`);

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= serviceIndent) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function extractComposeIdentity(text, label) {
  const db = composeServiceBlock(text, "db", label);
  const appService = composeServiceBlock(text, "app", label);
  const [bootstrapDatabaseUser] = oneMatch(
    db,
    /^\s+POSTGRES_USER:\s*["']?([a-z][a-z0-9_]*)["']?\s*$/gm,
    `${label} POSTGRES_USER`,
  );
  const [databaseName] = oneMatch(
    db,
    /^\s+POSTGRES_DB:\s*["']?([a-z][a-z0-9_]*)["']?\s*$/gm,
    `${label} POSTGRES_DB`,
  );
  const [healthUser, healthDatabase] = oneMatch(
    db,
    /pg_isready -U ([a-z][a-z0-9_]*) -d ([a-z][a-z0-9_]*)/g,
    `${label} database healthcheck`,
  );
  const [defaultHostPort, containerPort] = oneMatch(
    appService,
    /127\.0\.0\.1:\$\{PORT:-([0-9]+)\}:([0-9]+)/g,
    `${label} app port mapping`,
  );
  const [corsDefaultHostPort] = oneMatch(
    appService,
    /CORS_ORIGINS:\s*["']http:\/\/localhost:\$\{PORT:-([0-9]+)\}["']/g,
    `${label} CORS port`,
  );
  return {
    bootstrapDatabaseUser,
    databaseName,
    healthUser,
    healthDatabase,
    defaultHostPort: Number(defaultHostPort),
    containerPort: Number(containerPort),
    corsDefaultHostPort: Number(corsDefaultHostPort),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactCodeLine(value) {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, "gm");
}

function diffStackIdentity(identity, source) {
  const problems = [];
  for (const [label, text] of [
    [ROOT_COMPOSE, source[ROOT_COMPOSE]],
    [ELECTRON_COMPOSE, source[ELECTRON_COMPOSE]],
  ]) {
    let actual;
    try {
      actual = extractComposeIdentity(text, label);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    for (const [actualKey, identityKey] of [
      ["bootstrapDatabaseUser", "bootstrapDatabaseUser"],
      ["databaseName", "databaseName"],
      ["healthUser", "bootstrapDatabaseUser"],
      ["healthDatabase", "databaseName"],
      ["defaultHostPort", "defaultHostPort"],
      ["containerPort", "containerPort"],
      ["corsDefaultHostPort", "defaultHostPort"],
    ]) {
      if (actual[actualKey] !== identity[identityKey]) {
        problems.push(
          `${label} ${actualKey} '${actual[actualKey]}' does not match ` +
            `${STACK_IDENTITY_FILE} ${identityKey} '${identity[identityKey]}'`,
        );
      }
    }
  }

  const requiredSourceLines = [
    [
      ELECTRON_MAIN,
      exactCodeLine(`const DEFAULT_APP_PORT = ${identity.defaultHostPort};`),
      "default host port",
    ],
    [
      ELECTRON_MAIN,
      exactCodeLine(
        `\`DATABASE_URL=postgresql://${identity.applicationDatabaseUser}:\${appPass}@db:5432/${identity.databaseName}\`,`,
      ),
      "application database URL",
    ],
    [
      ELECTRON_MAIN,
      exactCodeLine(
        `\`DATABASE_URL_MIGRATIONS=postgresql://${identity.bootstrapDatabaseUser}:\${pgPass}@db:5432/${identity.databaseName}\`,`,
      ),
      "migration database URL",
    ],
    [
      BACKEND_ENV,
      exactCodeLine(
        `"postgresql://${identity.bootstrapDatabaseUser}:ftm_password@localhost:5432/${identity.databaseName}";`,
      ),
      "development database URL",
    ],
    [
      BACKEND_ENV,
      exactCodeLine(`PORT: intEnv(${identity.containerPort}),`),
      "container port default",
    ],
    [
      ELECTRON_COMPOSE_MODULE,
      exactCodeLine(
        `if (target === ${identity.containerPort} && Number.isInteger(published) && published > 0)`,
      ),
      "published container port",
    ],
    [
      NATIVE_RUNTIME,
      exactCodeLine(`const DEFAULT_APP_PORT = ${identity.defaultHostPort};`),
      "native runtime default port",
    ],
    [
      NATIVE_DEVELOPMENT,
      exactCodeLine(
        `const appPort = parsePort(process.env.VISION_APP_PORT, ${identity.defaultHostPort});`,
      ),
      "native development default port",
    ],
    [
      NATIVE_DB_SMOKE,
      exactCodeLine(`appPort: ${identity.defaultHostPort},`),
      "native database smoke port",
    ],
    [
      NATIVE_RUNTIME_CLI,
      exactCodeLine(
        `let appPort = Number(args.port || ${identity.defaultHostPort});`,
      ),
      "native runtime CLI default port",
    ],
    [
      POSTGRES_INIT,
      exactCodeLine(
        `CREATE ROLE ${identity.applicationDatabaseUser} LOGIN PASSWORD '\${POSTGRES_APP_PASSWORD}'`,
      ),
      "application role creation",
    ],
    [
      POSTGRES_INIT,
      exactCodeLine(`-v app_role=${identity.applicationDatabaseUser} \\`),
      "application-role grants",
    ],
  ];
  for (const [file, regex, description] of requiredSourceLines) {
    try {
      oneMatch(source[file], regex, `${file} ${description}`);
    } catch (error) {
      problems.push(`${error.message}; expected ${STACK_IDENTITY_FILE}`);
    }
  }
  return problems;
}

/**
 * Walk a compose file and return the structural bits this guard compares.
 *
 * Returns `{ name, volumes, dbImage, dbPlatform }`. `name` is the top-level
 * project name (undefined when absent), `volumes` is the list of keys in the
 * top-level `volumes:` mapping (undefined when there is no such block — distinct
 * from an empty block), and the db fields are direct scalar properties of the
 * `services.db` mapping.
 */
function parseCompose(text, label) {
  const lines = String(text).split(/\r?\n/);
  let name;
  let volumes;
  let inVolumes = false;
  let volumeIndent; // indent of the first child key; deeper lines are that key's value
  let blockScalarIndent; // when set, skip every line indented deeper than this
  let inServices = false;
  let serviceIndent;
  let currentService;
  let servicePropertyIndent;
  let dbImage;
  let dbPlatform;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (blockScalarIndent !== undefined) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }

    const match = KEY_RE.exec(line);

    if (indent === 0) {
      // Any top-level construct ends the volumes block — including a `---`
      // document break or a sequence item, not just another key.
      inVolumes = false;
      inServices = false;
      if (!match) continue;
      const key = match[2];
      const value = stripInlineComment(match[3]);
      if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
      if (key === "name" && value !== "") name = unquote(value);
      if (key === "services") {
        inServices = true;
        serviceIndent = undefined;
        currentService = undefined;
        servicePropertyIndent = undefined;
      }
      if (key === "volumes") {
        if (volumes !== undefined) {
          throw new Error(
            `${label}: two top-level 'volumes:' blocks — invalid compose file`,
          );
        }
        volumes = [];
        inVolumes = true;
        volumeIndent = undefined;
      }
      continue;
    }

    if (inServices) {
      if (!match) continue;
      const key = match[2];
      const value = stripInlineComment(match[3]);
      if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;

      if (serviceIndent === undefined) serviceIndent = indent;
      if (indent === serviceIndent) {
        currentService = key;
        servicePropertyIndent = undefined;
        continue;
      }
      if (currentService !== "db") continue;
      if (servicePropertyIndent === undefined) servicePropertyIndent = indent;
      if (indent !== servicePropertyIndent || value === "") continue;
      if (key === "image") dbImage = unquote(value);
      if (key === "platform") dbPlatform = unquote(value);
      continue;
    }

    if (!inVolumes) {
      if (match && BLOCK_SCALAR_RE.test(stripInlineComment(match[3])))
        blockScalarIndent = indent;
      continue;
    }

    // Inside the top-level volumes mapping. Its direct children are the volume
    // names; anything indented deeper belongs to one of them (driver:, labels: …).
    if (volumeIndent === undefined) volumeIndent = indent;
    if (indent > volumeIndent) continue;
    if (!match) {
      throw new Error(
        `${label}: unexpected line ${i + 1} in the top-level 'volumes:' block: ${line.trim()}`,
      );
    }
    const value = stripInlineComment(match[3]);
    if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
    volumes.push(match[2]);
  }

  return { name, volumes, dbImage, dbPlatform };
}

/**
 * Compare two parsed compose files. Returns an array of human-readable problems;
 * empty means in sync.
 */
function diffCompose(root, electron) {
  const problems = [];

  if (!root.name || !electron.name) {
    problems.push(
      "compose 'name:' missing — both files must pin the same project name " +
        `(root: ${root.name || "(none)"}, electron: ${electron.name || "(none)"})`,
    );
  } else if (root.name !== electron.name) {
    problems.push(
      `compose 'name:' out of sync — root '${root.name}' vs electron '${electron.name}'. ` +
        "Both files must pin the same project name (the shared vision_postgres_data " +
        "volume depends on it).",
    );
  }

  for (const [label, key] of [
    ["database image", "dbImage"],
    ["database platform", "dbPlatform"],
  ]) {
    if (!root[key] || !electron[key]) {
      problems.push(
        `${label} missing — root: ${root[key] || "(none)"}, ` +
          `electron: ${electron[key] || "(none)"}`,
      );
    } else if (root[key] !== electron[key]) {
      problems.push(
        `${label} out of sync — root '${root[key]}' vs electron '${electron[key]}'.`,
      );
    }
  }

  for (const [label, image] of [
    ["root", root.dbImage],
    ["electron", electron.dbImage],
  ]) {
    if (image && !/@sha256:[a-f0-9]{64}$/.test(image)) {
      problems.push(
        `${label} database image is not digest-pinned — got '${image}'.`,
      );
    }
  }

  if (root.volumes === undefined || electron.volumes === undefined) {
    problems.push(
      "no top-level 'volumes:' block found — " +
        `root: ${root.volumes === undefined ? "missing" : "present"}, ` +
        `electron: ${electron.volumes === undefined ? "missing" : "present"}`,
    );
    return problems;
  }

  const rootVols = [...root.volumes].sort();
  const electronVols = [...electron.volumes].sort();
  const missing = rootVols.filter((v) => !electronVols.includes(v));
  const extra = electronVols.filter((v) => !rootVols.includes(v));

  if (missing.length > 0) {
    problems.push(
      `named volumes missing from ${ELECTRON_COMPOSE}: ${missing.join(", ")} — ` +
        "add them before releasing (omitting one is what caused the v1.0.2 data loss).",
    );
  }
  if (extra.length > 0) {
    problems.push(
      `named volumes present only in ${ELECTRON_COMPOSE}: ${extra.join(", ")} — ` +
        `add them to ${ROOT_COMPOSE} or drop them from the packaged file.`,
    );
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test — proves the checker discriminates, so a green CI run means the
// files agree rather than that the parser silently found nothing. Mirrors
// scripts/check-destructive-migrations.py --self-test.
// ─────────────────────────────────────────────────────────────────────────────
const SELF_TEST_ROOT = `# comment
name: vision
services:
  db:
    image: postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2
    platform: linux/amd64
    environment:
      POSTGRES_USER: ftm_user
      POSTGRES_DB: financial_transactions
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ftm_user -d financial_transactions"]
  app:
    image: x
    ports:
      - "127.0.0.1:\${PORT:-3002}:3002"
    environment:
      CORS_ORIGINS: "http://localhost:\${PORT:-3002}"
    volumes:
      - attachments_data:/app/data/attachments
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    command: |
      volumes:
        not_a_volume:
volumes:
  postgres_data:
  attachments_data:
  vision_cache_data:
`;

function selfTest() {
  const cases = [];
  const check = (label, ok, detail) => cases.push({ label, ok, detail });

  const root = parseCompose(SELF_TEST_ROOT, "self-test root");
  check(
    "parses project name",
    root.name === "vision",
    `got ${JSON.stringify(root.name)}`,
  );
  check(
    "reads only the top-level volumes mapping (service mounts and block scalars ignored)",
    JSON.stringify(root.volumes) ===
      JSON.stringify([
        "postgres_data",
        "attachments_data",
        "vision_cache_data",
      ]),
    `got ${JSON.stringify(root.volumes)}`,
  );
  check(
    "parses the database image and platform",
    root.dbImage ===
      "postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2" &&
      root.dbPlatform === "linux/amd64",
    `got image=${JSON.stringify(root.dbImage)} platform=${JSON.stringify(root.dbPlatform)}`,
  );

  // The awk version's real bug: it never stopped at the next top-level block,
  // so keys under anything following `volumes:` were counted as volume names.
  const withTrailingBlock = parseCompose(
    `${SELF_TEST_ROOT}networks:\n  frontend:\n  backend:\n`,
    "self-test trailing block",
  );
  check(
    "stops at the next top-level block",
    JSON.stringify(withTrailingBlock.volumes) === JSON.stringify(root.volumes),
    `got ${JSON.stringify(withTrailingBlock.volumes)}`,
  );

  const nested = parseCompose(
    "name: vision\nvolumes:\n  postgres_data:\n    driver: local\n    driver_opts:\n      type: none\n  attachments_data:\n",
    "self-test nested",
  );
  check(
    "volume options are not mistaken for volume names",
    JSON.stringify(nested.volumes) ===
      JSON.stringify(["postgres_data", "attachments_data"]),
    `got ${JSON.stringify(nested.volumes)}`,
  );

  check(
    "identical files pass",
    diffCompose(root, parseCompose(SELF_TEST_ROOT, "x")).length === 0,
    "expected no problems",
  );
  check(
    "a shared floating database tag is caught",
    diffCompose(
      parseCompose(
        SELF_TEST_ROOT.replace(/@sha256:[a-f0-9]{64}/g, ""),
        "floating root",
      ),
      parseCompose(
        SELF_TEST_ROOT.replace(/@sha256:[a-f0-9]{64}/g, ""),
        "floating electron",
      ),
    ).some((problem) => problem.includes("not digest-pinned")),
  );

  const missingVolume = parseCompose(
    SELF_TEST_ROOT.replace(
      "  attachments_data:\n  vision_cache_data:\n",
      "  vision_cache_data:\n",
    ),
    "self-test missing volume",
  );
  check(
    "a volume missing from the packaged file is caught",
    diffCompose(root, missingVolume).some((p) =>
      p.includes("attachments_data"),
    ),
    JSON.stringify(diffCompose(root, missingVolume)),
  );

  const extraVolume = parseCompose(
    `${SELF_TEST_ROOT}  stray_data:\n`,
    "self-test extra volume",
  );
  check(
    "a volume only in the packaged file is caught",
    diffCompose(root, extraVolume).some((p) => p.includes("stray_data")),
    JSON.stringify(diffCompose(root, extraVolume)),
  );

  const renamed = parseCompose(
    SELF_TEST_ROOT.replace("name: vision", "name: vision2"),
    "self-test rename",
  );
  check(
    "a project-name change is caught",
    diffCompose(root, renamed).some((p) => p.includes("'name:' out of sync")),
    JSON.stringify(diffCompose(root, renamed)),
  );

  const unnamed = parseCompose(
    SELF_TEST_ROOT.replace("name: vision\n", ""),
    "self-test unnamed",
  );
  check(
    "a missing project name is caught",
    diffCompose(root, unnamed).some((p) => p.includes("'name:' missing")),
    JSON.stringify(diffCompose(root, unnamed)),
  );

  const wrongPlatform = parseCompose(
    SELF_TEST_ROOT.replace("platform: linux/amd64", "platform: linux/arm64"),
    "self-test platform mismatch",
  );
  check(
    "a database platform mismatch is caught",
    diffCompose(root, wrongPlatform).some((p) =>
      p.includes("database platform out of sync"),
    ),
    JSON.stringify(diffCompose(root, wrongPlatform)),
  );

  const noVolumes = parseCompose(
    "name: vision\nservices:\n  app:\n    image: x\n",
    "self-test no volumes",
  );
  check(
    "a missing volumes block is caught",
    diffCompose(root, noVolumes).some((p) =>
      p.includes("no top-level 'volumes:' block"),
    ),
    JSON.stringify(diffCompose(root, noVolumes)),
  );

  const identity = readStackIdentity(
    JSON.stringify({
      defaultHostPort: 3002,
      containerPort: 3002,
      bootstrapDatabaseUser: "ftm_user",
      applicationDatabaseUser: "ftm_app",
      databaseName: "financial_transactions",
    }),
    "self-test identity",
  );
  check(
    "identical bootstrap and application roles are rejected",
    (() => {
      try {
        readStackIdentity(
          JSON.stringify({ ...identity, applicationDatabaseUser: "ftm_user" }),
          "self-test equal roles",
        );
        return false;
      } catch (error) {
        return error.message.includes("must differ");
      }
    })(),
  );
  const electronMain = [
    "const DEFAULT_APP_PORT = 3002;",
    "`DATABASE_URL=postgresql://ftm_app:${appPass}@db:5432/financial_transactions`,",
    "`DATABASE_URL_MIGRATIONS=postgresql://ftm_user:${pgPass}@db:5432/financial_transactions`,",
  ].join("\n");
  const backendEnv = [
    '"postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions";',
    "PORT: intEnv(3002),",
  ].join("\n");
  const stackProblems = (rootText, electronText, mainText, envText) =>
    diffStackIdentity(identity, {
      [ROOT_COMPOSE]: rootText,
      [ELECTRON_COMPOSE]: electronText,
      [ELECTRON_MAIN]: mainText,
      [BACKEND_ENV]: envText,
      [ELECTRON_COMPOSE_MODULE]:
        "if (target === 3002 && Number.isInteger(published) && published > 0)",
      [NATIVE_RUNTIME]: "const DEFAULT_APP_PORT = 3002;",
      [NATIVE_DEVELOPMENT]:
        "const appPort = parsePort(process.env.VISION_APP_PORT, 3002);",
      [NATIVE_DB_SMOKE]: "appPort: 3002,",
      [NATIVE_RUNTIME_CLI]: "let appPort = Number(args.port || 3002);",
      [POSTGRES_INIT]: [
        "CREATE ROLE ftm_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'",
        "-v app_role=ftm_app \\",
      ].join("\n"),
    });
  check(
    "canonical stack identity passes",
    stackProblems(SELF_TEST_ROOT, SELF_TEST_ROOT, electronMain, backendEnv)
      .length === 0,
  );
  for (const [label, target, replacement] of [
    [
      "database name drift is caught",
      "financial_transactions",
      "other_database",
    ],
    ["bootstrap user drift is caught", "ftm_user", "other_user"],
    ["host-port drift is caught", "${PORT:-3002}:3002", "${PORT:-3999}:3002"],
    [
      "container-port drift is caught",
      "${PORT:-3002}:3002",
      "${PORT:-3002}:3999",
    ],
  ]) {
    const changed = SELF_TEST_ROOT.replace(target, replacement);
    check(
      label,
      stackProblems(changed, SELF_TEST_ROOT, electronMain, backendEnv).length >
        0,
    );
  }
  check(
    "Electron default-port drift is caught",
    stackProblems(
      SELF_TEST_ROOT,
      SELF_TEST_ROOT,
      electronMain.replace(
        "DEFAULT_APP_PORT = 3002",
        "DEFAULT_APP_PORT = 3999",
      ),
      backendEnv,
    ).length > 0,
  );
  check(
    "Electron database URL drift is caught",
    stackProblems(
      SELF_TEST_ROOT,
      SELF_TEST_ROOT,
      electronMain.replace("postgresql://ftm_app", "postgresql://other_app"),
      backendEnv,
    ).length > 0,
  );
  check(
    "backend defaults drift is caught",
    stackProblems(
      SELF_TEST_ROOT,
      SELF_TEST_ROOT,
      electronMain,
      backendEnv.replace("PORT: intEnv(3002)", "PORT: intEnv(3999)"),
    ).length > 0,
  );
  const misleadingOtherService = SELF_TEST_ROOT.replace(
    "      POSTGRES_USER: ftm_user",
    "      POSTGRES_USER_REMOVED: ftm_user",
  ).replace(
    "  app:\n",
    "  unrelated:\n    environment:\n      POSTGRES_USER: ftm_user\n  app:\n",
  );
  check(
    "an unrelated service cannot satisfy the database identity",
    stackProblems(
      misleadingOtherService,
      SELF_TEST_ROOT,
      electronMain,
      backendEnv,
    ).length > 0,
  );
  const misleadingComment = electronMain
    .replace("const DEFAULT_APP_PORT = 3002;", "const DEFAULT_APP_PORT = 3999;")
    .concat("\n// const DEFAULT_APP_PORT = 3002;\n");
  check(
    "a comment cannot satisfy an Electron source check",
    stackProblems(SELF_TEST_ROOT, SELF_TEST_ROOT, misleadingComment, backendEnv)
      .length > 0,
  );

  let failed = 0;
  for (const c of cases) {
    if (c.ok) {
      console.log(`  ok   ${c.label}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${c.label} — ${c.detail}`);
    }
  }
  if (failed > 0) {
    console.error(
      `[check-compose-sync] self-test: ${failed}/${cases.length} case(s) failed.`,
    );
    process.exit(1);
  }
  console.log(`[check-compose-sync] self-test passed (${cases.length} cases).`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const files = [ROOT_COMPOSE, ELECTRON_COMPOSE];
  let parsed;
  let sources;
  let identity;
  try {
    sources = Object.fromEntries(
      [
        ...files,
        ELECTRON_MAIN,
        ELECTRON_COMPOSE_MODULE,
        NATIVE_RUNTIME,
        NATIVE_DEVELOPMENT,
        NATIVE_DB_SMOKE,
        NATIVE_RUNTIME_CLI,
        BACKEND_ENV,
        POSTGRES_INIT,
      ].map((rel) => [rel, readFileSync(path.join(REPO_ROOT, rel), "utf8")]),
    );
    parsed = files.map((rel) => parseCompose(sources[rel], rel));
    identity = readStackIdentity(
      readFileSync(path.join(REPO_ROOT, STACK_IDENTITY_FILE), "utf8"),
    );
  } catch (err) {
    console.error(`[check-compose-sync] ${err.message}`);
    process.exit(1);
  }

  const [root, electron] = parsed;
  console.log(
    `[check-compose-sync] ${ROOT_COMPOSE}    : name=${root.name} ` +
      `db=${root.dbImage} platform=${root.dbPlatform} volumes=${(root.volumes || []).join(" ")}`,
  );
  console.log(
    `[check-compose-sync] ${ELECTRON_COMPOSE}: name=${electron.name} ` +
      `db=${electron.dbImage} platform=${electron.dbPlatform} ` +
      `volumes=${(electron.volumes || []).join(" ")}`,
  );

  const problems = [
    ...diffCompose(root, electron),
    ...diffStackIdentity(identity, sources),
  ];
  if (problems.length > 0) {
    console.error(
      "[check-compose-sync] ERROR: the packaged compose file is out of sync with the root one:",
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    "[check-compose-sync] in sync: project name, database runtime, stack identity, and named volumes match.",
  );
}

main();
