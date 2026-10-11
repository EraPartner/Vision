#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";

import { appRoot } from "../paths";
import { prepareAlembicRuntime } from "./prepare-alembic-runtime";
import {
  CHROMIUM_VERSION,
  findSourceExecutable,
  prepareChromiumRuntime,
} from "./prepare-chromium-runtime";
import { preparePostgresRuntime } from "./prepare-postgres-runtime";
import { assertSafeNativeDestination } from "./prepare-native-runtime";

export interface EnsureChromiumSourceOptions {
  findSource?: (explicitSource?: string) => string;
  hasPuppeteer?: (candidate: string) => boolean;
  spawn?: (
    executable: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => { status: number | null; error?: Error | undefined };
}

const repoRoot = path.resolve(appRoot, "..", "..");
const outputRoot = assertSafeNativeDestination(
  process.env.VISION_NATIVE_RUNTIME_DESTINATION ||
    path.resolve(appRoot, "native-runtime"),
);

export function ensureChromiumSource(
  options: EnsureChromiumSourceOptions = {},
): string {
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

export function run(): void {
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
