#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepareAlembicRuntime } = require("./prepare-alembic-runtime");
const {
  CHROMIUM_VERSION,
  findSourceExecutable,
  prepareChromiumRuntime,
} = require("./prepare-chromium-runtime");
const { preparePostgresRuntime } = require("./prepare-postgres-runtime");
const { assertSafeNativeDestination } = require("./prepare-native-runtime");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const outputRoot = assertSafeNativeDestination(
  process.env.VISION_NATIVE_RUNTIME_DESTINATION ||
    path.resolve(__dirname, "..", "native-runtime"),
);

function ensureChromiumSource(options = {}) {
  const findSource = options.findSource || findSourceExecutable;
  try {
    return findSource(process.env.VISION_CHROMIUM_SOURCE);
  } catch (error) {
    const puppeteer = path.join(
      repoRoot,
      "apps",
      "node-backend",
      "node_modules",
      ".bin",
      "puppeteer",
    );
    const hasPuppeteer = options.hasPuppeteer || fs.existsSync;
    if (!hasPuppeteer(puppeteer)) throw error;
    const spawn = options.spawn || spawnSync;
    const result = spawn(
      puppeteer,
      ["browsers", "install", `chrome-headless-shell@${CHROMIUM_VERSION}`],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Pinned Chrome Headless Shell installation exited ${result.status}`,
      );
    }
    return findSource(process.env.VISION_CHROMIUM_SOURCE);
  }
}

function run() {
  const postgres = preparePostgresRuntime({
    sourceBin: process.env.VISION_POSTGRES_SOURCE_BIN,
    destination: path.join(outputRoot, "postgres"),
  });
  const alembic = prepareAlembicRuntime({
    python: process.env.VISION_PYTHON_BIN,
    prebuilt: process.env.VISION_ALEMBIC_RUNTIME_BIN,
    destination: path.join(outputRoot, "vision-alembic"),
  });
  const chromium = prepareChromiumRuntime({
    source: ensureChromiumSource(),
    destination: path.join(outputRoot, "chromium"),
  });
  console.log(
    `Prepared native development services: PostgreSQL ${postgres.postgresVersion}, ${alembic.version}, Chrome Headless Shell ${chromium.browserVersion}`,
  );
}

if (require.main === module) run();

module.exports = { ensureChromiumSource, run };
