#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { requestNativeDemoReset } from "../runtime/native-demo";

export interface NativeDemoCliOptions {
  argv?: readonly string[];
  homeDir?: string;
}

export function parseArgs(argv: readonly string[]): { command: "reset" } {
  if (argv.length !== 2 || argv[0] !== "reset" || argv[1] !== "--execute") {
    throw new Error("Usage: native-demo-cli.js reset --execute");
  }
  return { command: "reset" };
}

export async function main(options: NativeDemoCliOptions = {}): Promise<void> {
  parseArgs(options.argv ?? process.argv.slice(2));
  const userDataDir = path.join(
    options.homeDir || os.homedir(),
    "Library",
    "Application Support",
    "Vision Demo",
  );
  await requestNativeDemoReset(userDataDir);
  console.log(
    "Native Demo reset requested. Quit and reopen Vision Demo to restore the canonical synthetic dataset.",
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message !== ""
    ? error.message
    : String(error);
}
