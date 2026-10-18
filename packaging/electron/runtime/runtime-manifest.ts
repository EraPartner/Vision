import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

interface NativeRuntimeError extends Error {
  code?: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function errorCode(value: unknown): unknown {
  return isRecord(value) ? value.code : undefined;
}

export async function verifyRuntimeManifest(
  runtimeRoot: string,
  options: { required?: boolean } = {},
): Promise<RuntimeManifestVerification> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { runtimeRoot, required: options.required === true },
    });
    let received = false;
    worker.once(
      "message",
      (message: { result?: RuntimeManifestVerification; error?: string }) => {
        received = true;
        if (message.result) resolve(message.result);
        else
          reject(
            Object.assign(
              new Error(message.error ?? "Runtime verification failed"),
              { code: "NATIVE_RUNTIME_CORRUPT" },
            ),
          );
      },
    );
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received)
        reject(
          Object.assign(
            new Error(
              `Runtime verification worker exited before completion (${code})`,
            ),
            { code: "NATIVE_RUNTIME_CORRUPT" },
          ),
        );
    });
  });
}

export type RuntimeManifestVerification =
  { status: "not-present" } | { status: "verified"; entries: number };

async function verifyManifestInWorker(
  runtimeRoot: string,
  { required = false }: { required?: boolean } = {},
): Promise<RuntimeManifestVerification> {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT")
      return { status: "not-present" };
    const wrapped: NativeRuntimeError = new Error(
      "Native runtime manifest is missing or invalid",
    );
    wrapped.code = "NATIVE_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (
    !isRecord(manifest) ||
    manifest.version !== 1 ||
    !isUnknownArray(manifest.entries)
  ) {
    const error: NativeRuntimeError = new Error(
      "Native runtime manifest has an unsupported format",
    );
    error.code = "NATIVE_RUNTIME_CORRUPT";
    throw error;
  }
  const expectedPaths = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._@+/-]+$/.test(entry.path) ||
      path.isAbsolute(entry.path) ||
      entry.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || "")) ||
      expectedPaths.has(entry.path)
    ) {
      const error: NativeRuntimeError = new Error(
        "Native runtime manifest contains an invalid entry",
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
    expectedPaths.add(entry.path);
    const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
    let bytes = 0;
    const hash = crypto.createHash("sha256");
    try {
      for await (const chunk of fs.createReadStream(absolute, {
        highWaterMark: 64 * 1024,
      })) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    } catch {
      const error: NativeRuntimeError = new Error(
        `Native runtime payload is missing ${entry.path}`,
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
    const digest = hash.digest("hex");
    if (bytes !== entry.bytes || digest !== entry.sha256) {
      const error: NativeRuntimeError = new Error(
        `Native runtime payload failed checksum verification: ${entry.path}`,
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
  }
  const actualPaths = new Set<string>();
  async function visit(current: string): Promise<void> {
    const children = await fs.promises.readdir(current, {
      withFileTypes: true,
    });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path
        .relative(runtimeRoot, absolute)
        .split(path.sep)
        .join("/");
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        const error: NativeRuntimeError = new Error(
          `Native runtime payload contains an unsupported entry: ${relative}`,
        );
        error.code = "NATIVE_RUNTIME_CORRUPT";
        throw error;
      }
      if (child.isDirectory()) await visit(absolute);
      else if (relative !== "manifest.json") actualPaths.add(relative);
    }
  }
  await visit(runtimeRoot);
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((entry) => !expectedPaths.has(entry))
  ) {
    const error: NativeRuntimeError = new Error(
      "Native runtime payload contains files not covered by its manifest",
    );
    error.code = "NATIVE_RUNTIME_CORRUPT";
    throw error;
  }
  return { status: "verified", entries: manifest.entries.length };
}

if (!isMainThread) {
  void verifyManifestInWorker(workerData.runtimeRoot, {
    required: workerData.required,
  }).then(
    (result) => {
      parentPort?.postMessage({ result });
      parentPort?.close();
    },
    (error: unknown) => {
      parentPort?.postMessage({
        error:
          error instanceof Error
            ? error.message
            : "Runtime verification failed",
      });
      parentPort?.close();
    },
  );
}
