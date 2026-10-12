#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { requestNativeDemoReset } from "../runtime/native-demo";

export interface NativeDemoCliOptions {
  argv?: readonly string[];
  homeDir?: string;
}

/** The apps whose synthetic Demo dataset the reset request restores. */
export const DEMO_RESET_TARGETS = {
  // Electron Vision Demo (the default, `bun run demo:reset-native`).
  "vision-demo": "Vision Demo",
  // Vision Native Demo, the default install-native.sh build (`bun run demo:reset-vision-native`).
  "vision-native-demo": "Vision Native Demo",
  // The standard Vision Native build, which also runs on Demo data until phase 4.
  "vision-native": "Vision Native",
} as const;

export type DemoResetTarget = keyof typeof DEMO_RESET_TARGETS;

const USAGE =
  "Usage: native-demo-cli.js reset --execute [--target vision-demo|vision-native-demo|vision-native]";

function isTarget(value: string | undefined): value is DemoResetTarget {
  return value !== undefined && Object.hasOwn(DEMO_RESET_TARGETS, value);
}

export function parseArgs(argv: readonly string[]): {
  command: "reset";
  target: DemoResetTarget;
} {
  if (argv[0] !== "reset" || argv[1] !== "--execute") throw new Error(USAGE);
  if (argv.length === 2) return { command: "reset", target: "vision-demo" };
  const target = argv[3];
  if (argv.length !== 4 || argv[2] !== "--target" || !isTarget(target)) {
    throw new Error(USAGE);
  }
  return { command: "reset", target };
}

export async function main(options: NativeDemoCliOptions = {}): Promise<void> {
  const { target } = parseArgs(options.argv || process.argv.slice(2));
  const appName = DEMO_RESET_TARGETS[target];
  const userDataDir = path.join(
    options.homeDir || os.homedir(),
    "Library",
    "Application Support",
    appName,
  );
  await requestNativeDemoReset(userDataDir);
  console.log(
    `Native Demo reset requested. Quit and reopen ${appName} to restore the canonical synthetic dataset.`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

function errorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    error.message
    ? String(error.message)
    : String(error);
}
