#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");
const { requestNativeDemoReset } = require("../runtime/native-demo");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "reset" || argv[1] !== "--execute") {
    throw new Error("Usage: native-demo-cli.js reset --execute");
  }
  return { command: "reset" };
}

async function main(options = {}) {
  parseArgs(options.argv || process.argv.slice(2));
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
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
