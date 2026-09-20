"use strict";

const { spawn } = require("node:child_process");

function createKeychainWitness({ executable, runtimeId, keychainPath } = {}) {
  if (typeof executable !== "string" || !executable.startsWith("/")) {
    throw new TypeError("Absolute Keychain helper path required");
  }
  if (runtimeId !== "vision" && runtimeId !== "vision_demo") {
    throw new TypeError("Invalid audit Keychain runtime");
  }
  const service = `com.vaultvoyager.${runtimeId.replace("_", "-")}.audit-witness`;

  function run(operation, value) {
    return new Promise((resolve, reject) => {
      const args = [operation, service];
      if (keychainPath) args.push(keychainPath);
      const child = spawn(executable, args, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks = [];
      let size = 0;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8192) child.kill();
        else chunks.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 2 && operation === "read") return resolve(undefined);
        if (code === 3 && operation === "create") {
          return reject(new Error("audit_witness_already_exists"));
        }
        if (code !== 0 || size > 8192) {
          return reject(new Error("audit_witness_unavailable"));
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }

  return {
    async read() {
      const value = await run("read");
      if (value === undefined) return undefined;
      try {
        return JSON.parse(value);
      } catch {
        throw new Error("audit_witness_invalid");
      }
    },
    create: (value) => run("create", value),
    replace: (value) => run("replace", value),
  };
}

module.exports = { createKeychainWitness };
