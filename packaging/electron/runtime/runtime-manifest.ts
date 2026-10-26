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
function corrupt(message: string): NativeRuntimeError {
  const error: NativeRuntimeError = new Error(message);
  error.code = "NATIVE_RUNTIME_CORRUPT";
  return error;
}

export type RuntimeManifestVerification =
  { status: "not-present" } | { status: "verified"; entries: number };

/** How a launch verified the payload: a full hash or the recorded size check. */
export type LaunchManifestVerification =
  | { status: "not-present" }
  | { status: "verified"; entries: number; mode: "full" | "cached" };

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface ParsedManifest {
  appVersion: string | undefined;
  entries: ManifestEntry[];
}

/** Full SHA-256 verification of every payload file, in a worker thread. */
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

// The marker that records a completed full verification. It lives in the
// application data directory, never inside the signed application bundle.
const MARKER_VERSION = 1;

interface VerificationMarker {
  version: number;
  appVersion: string | null;
  manifestSha256: string;
  runtimeRoot: string;
  entries: number;
  verifiedAt: string;
}

/**
 * Launch-time verification (ADR-235). The first launch of an installed payload
 * hashes every file. It then records the manifest's SHA-256 (which covers the
 * app version and every file's size and hash) in `markerPath`. Later launches
 * with the same manifest and payload location only check that exactly the
 * listed regular files exist with their recorded sizes. Any mismatch, or a
 * missing or different marker, falls back to the full hash check.
 */
export async function verifyRuntimeManifestOnLaunch(
  runtimeRoot: string,
  options: { required?: boolean; markerPath: string },
): Promise<LaunchManifestVerification> {
  const root = path.resolve(runtimeRoot);
  const manifestBytes = await readManifestBytes(root, options.required === true);
  if (!manifestBytes) return { status: "not-present" };
  const manifestSha256 = crypto
    .createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const manifest = parseManifest(manifestBytes);

  const marker = await readMarker(options.markerPath);
  if (
    marker &&
    marker.manifestSha256 === manifestSha256 &&
    marker.runtimeRoot === root &&
    marker.appVersion === (manifest.appVersion ?? null) &&
    (await payloadMatchesSizes(root, manifest.entries))
  ) {
    return { status: "verified", entries: manifest.entries.length, mode: "cached" };
  }

  const verified = await verifyRuntimeManifest(root, { required: true });
  if (verified.status !== "verified") return verified;
  // The marker only saves time on the next launch; failing to write it must
  // never block startup.
  await writeMarker(options.markerPath, {
    version: MARKER_VERSION,
    appVersion: manifest.appVersion ?? null,
    manifestSha256,
    runtimeRoot: root,
    entries: verified.entries,
    verifiedAt: new Date().toISOString(),
  }).catch(() => undefined);
  return { ...verified, mode: "full" };
}

async function readManifestBytes(
  runtimeRoot: string,
  required: boolean,
): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(path.join(runtimeRoot, "manifest.json"));
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT") return undefined;
    throw corrupt("Native runtime manifest is missing or invalid");
  }
}

function parseManifest(bytes: Buffer): ParsedManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw corrupt("Native runtime manifest is missing or invalid");
  }
  if (
    !isRecord(manifest) ||
    manifest.version !== 1 ||
    !isUnknownArray(manifest.entries)
  ) {
    throw corrupt("Native runtime manifest has an unsupported format");
  }
  const seen = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const entry of manifest.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._@+/-]+$/.test(entry.path) ||
      path.isAbsolute(entry.path) ||
      entry.path.split("/").includes("..") ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      throw corrupt("Native runtime manifest contains an invalid entry");
    }
    seen.add(entry.path);
    entries.push({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  return {
    appVersion:
      typeof manifest.appVersion === "string" ? manifest.appVersion : undefined,
    entries,
  };
}

/** The marker fields a later launch compares; `entries` and `verifiedAt` are informational. */
type StoredMarker = Pick<
  VerificationMarker,
  "version" | "appVersion" | "manifestSha256" | "runtimeRoot"
>;

async function readMarker(
  markerPath: string,
): Promise<StoredMarker | undefined> {
  try {
    const marker: unknown = JSON.parse(
      await fs.promises.readFile(markerPath, "utf8"),
    );
    if (
      isRecord(marker) &&
      marker.version === MARKER_VERSION &&
      typeof marker.manifestSha256 === "string" &&
      typeof marker.runtimeRoot === "string" &&
      (marker.appVersion === null || typeof marker.appVersion === "string")
    ) {
      return {
        version: marker.version,
        appVersion: marker.appVersion,
        manifestSha256: marker.manifestSha256,
        runtimeRoot: marker.runtimeRoot,
      };
    }
  } catch {
    // A missing or unreadable marker means "not verified yet".
  }
  return undefined;
}

async function writeMarker(
  markerPath: string,
  marker: VerificationMarker,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(markerPath), {
    recursive: true,
    mode: 0o700,
  });
  const temp = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.promises.rename(temp, markerPath);
  } catch (error) {
    await fs.promises.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Every payload file except manifest.json; symlinks and special files throw. */
async function listPayloadFiles(runtimeRoot: string): Promise<Set<string>> {
  const files = new Set<string>();
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
        throw corrupt(
          `Native runtime payload contains an unsupported entry: ${relative}`,
        );
      }
      if (child.isDirectory()) await visit(absolute);
      else if (relative !== "manifest.json") files.add(relative);
    }
  }
  await visit(runtimeRoot);
  return files;
}

function sameFileSet(actual: Set<string>, entries: ManifestEntry[]): boolean {
  return (
    actual.size === entries.length &&
    entries.every((entry) => actual.has(entry.path))
  );
}

// The cheap launch check: exactly the listed regular files, each with its
// recorded size. Any failure answers false so the caller re-hashes.
async function payloadMatchesSizes(
  runtimeRoot: string,
  entries: ManifestEntry[],
): Promise<boolean> {
  try {
    if (!sameFileSet(await listPayloadFiles(runtimeRoot), entries)) return false;
    for (const entry of entries) {
      const stat = await fs.promises.lstat(
        path.join(runtimeRoot, ...entry.path.split("/")),
      );
      if (!stat.isFile() || stat.size !== entry.bytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyManifestInWorker(
  runtimeRoot: string,
  { required = false }: { required?: boolean } = {},
): Promise<RuntimeManifestVerification> {
  const bytes = await readManifestBytes(runtimeRoot, required);
  if (!bytes) return { status: "not-present" };
  const { entries } = parseManifest(bytes);
  for (const entry of entries) {
    const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
    let size = 0;
    const hash = crypto.createHash("sha256");
    try {
      const stream: AsyncIterable<Buffer> = fs.createReadStream(absolute, {
        highWaterMark: 64 * 1024,
      });
      for await (const chunk of stream) {
        size += chunk.length;
        hash.update(chunk);
      }
    } catch {
      throw corrupt(`Native runtime payload is missing ${entry.path}`);
    }
    if (size !== entry.bytes || hash.digest("hex") !== entry.sha256) {
      throw corrupt(
        `Native runtime payload failed checksum verification: ${entry.path}`,
      );
    }
  }
  if (!sameFileSet(await listPayloadFiles(runtimeRoot), entries)) {
    throw corrupt(
      "Native runtime payload contains files not covered by its manifest",
    );
  }
  return { status: "verified", entries: entries.length };
}

if (!isMainThread) {
  const data: unknown = workerData;
  if (!isRecord(data) || typeof data.runtimeRoot !== "string") {
    throw new TypeError("Invalid runtime verification worker data");
  }
  void verifyManifestInWorker(data.runtimeRoot, {
    required: data.required === true,
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
