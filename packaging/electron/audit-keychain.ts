import { spawn } from "node:child_process";

export interface KeychainWitnessOptions {
  executable?: string | undefined;
  runtimeId?: string;
  keychainPath?: string;
}

export interface KeychainWitness {
  read(): Promise<unknown>;
  create(value: unknown): Promise<string | undefined>;
  replace(value: unknown): Promise<string | undefined>;
}

type WitnessOperation = "read" | "create" | "replace";

export function createKeychainWitness({
  executable,
  runtimeId,
  keychainPath,
}: KeychainWitnessOptions = {}): KeychainWitness {
  if (typeof executable !== "string" || !executable.startsWith("/")) {
    throw new TypeError("Absolute Keychain helper path required");
  }
  if (runtimeId !== "vision" && runtimeId !== "vision_demo") {
    throw new TypeError("Invalid audit Keychain runtime");
  }
  const helper = executable;
  const service = `com.vaultvoyager.${runtimeId.replace("_", "-")}.audit-witness`;

  function run(
    operation: WitnessOperation,
    value?: unknown,
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const args = [operation, service];
      if (keychainPath) args.push(keychainPath);
      const child = spawn(helper, args, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => {
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
        const parsed: unknown = JSON.parse(value);
        return parsed;
      } catch {
        throw new Error("audit_witness_invalid");
      }
    },
    create: (value) => run("create", value),
    replace: (value) => run("replace", value),
  };
}
