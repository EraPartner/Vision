import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const helperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "egress-helper.mjs",
);
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024;
let homebrewDependencyCache;

function homebrewDependencyRoots(runtimePath) {
  if (!runtimePath.startsWith("/opt/homebrew/Cellar/")) return [];
  if (homebrewDependencyCache?.runtimePath === runtimePath)
    return homebrewDependencyCache.roots;
  const pending = [runtimePath];
  const inspected = new Set();
  const roots = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (inspected.has(path)) continue;
    if (inspected.size >= 256)
      throw new Error("Homebrew Node has too many linked libraries");
    inspected.add(path);
    const linked = execFileSync("/usr/bin/otool", ["-L", path], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of linked.split("\n")) {
      const reference = line.trim().split(/\s+/)[0];
      if (reference.endsWith(":")) continue;
      if (
        !reference.startsWith("/opt/homebrew/opt/") &&
        !reference.startsWith("/opt/homebrew/Cellar/")
      ) {
        continue;
      }
      const resolved = realpathSync(reference);
      const root = resolved.match(
        /^\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+/,
      )?.[0];
      if (!root) throw new Error("Homebrew library resolved outside Cellar");
      roots.add(root);
      pending.push(resolved);
    }
  }
  const result = [...roots].sort();
  homebrewDependencyCache = { runtimePath, roots: result };
  return result;
}

function seatbeltProfile(
  runtimePath,
  helper,
  workingDirectory = "/private/tmp/vision-openai-egress-empty",
  dependencyRoots = homebrewDependencyRoots(runtimePath),
) {
  const literal = (value) => JSON.stringify(value);
  const runtimeDirectory = dirname(runtimePath);
  const runtimeRoot = dirname(runtimeDirectory);
  const helperParents = [];
  for (let parent = dirname(helper); parent !== "/"; parent = dirname(parent)) {
    helperParents.push(`(literal ${literal(parent)})`);
  }
  const homebrewReads = runtimePath.startsWith("/opt/homebrew/Cellar/")
    ? [
        '(subpath "/opt/homebrew/opt")',
        ...dependencyRoots.map((root) => `(subpath ${literal(root)})`),
        '(literal "/opt/homebrew/etc/openssl@3/openssl.cnf")',
      ].join("\n  ")
    : "";
  return `(version 1)
(deny default)
(allow process-exec (literal ${literal(runtimePath)}))
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.TrustEvaluationAgent")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.networkd"))
(allow file-write-data
  (require-not (vnode-type REGULAR-FILE DIRECTORY SYMLINK)))
(allow file-read-data file-read-metadata file-map-executable
  (literal "/")
  (literal ${literal(runtimePath)})
  (subpath ${literal(runtimeRoot)})
  ${homebrewReads}
  (literal ${literal(helper)})
  (subpath ${literal(workingDirectory)})
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/private/etc/ssl")
  (literal "/private/etc/resolv.conf"))
(allow file-read-metadata ${helperParents.join(" ")})
(allow network-outbound)`;
}

export async function callOpenAiBroker(
  /** @type {Record<string, unknown>} */
  request,
  /** @type {{spawnImpl?: typeof spawn, signal?: AbortSignal, platform?: string, sandboxExec?: string}} */
  {
    spawnImpl = spawn,
    signal,
    platform = process.platform,
    sandboxExec = "/usr/bin/sandbox-exec",
  } = {},
) {
  if (signal?.aborted)
    throw Object.assign(new Error("Cloud request was cancelled"), {
      code: "ABORTED",
    });
  if (!process.env.OPENAI_API_KEY)
    throw Object.assign(new Error("OpenAI API key is not configured"), {
      code: "OPENAI_KEY_MISSING",
    });
  const cwd = await mkdtemp(join(tmpdir(), "vision-openai-egress-"));
  try {
    if (signal?.aborted)
      throw Object.assign(new Error("Cloud request was cancelled"), {
        code: "ABORTED",
      });
    if (platform !== "darwin")
      throw Object.assign(
        new Error("OpenAI egress requires the macOS Seatbelt sandbox"),
        { code: "EGRESS_SANDBOX_UNAVAILABLE" },
      );
    const profile = seatbeltProfile(process.execPath, helperPath, cwd);
    return await new Promise((resolve, reject) => {
      const child = spawnImpl(
        sandboxExec,
        ["-p", profile, process.execPath, helperPath],
        {
          cwd,
          env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const stdout = [];
      let stdoutBytes = 0;
      const abort = () => child.kill("SIGTERM");
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          reject(
            Object.assign(
              new Error("Cloud egress helper output is too large"),
              {
                code: "BROKER_OUTPUT_TOO_LARGE",
              },
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      // A sandbox launch failure can close stdin before the request is read.
      // The close handler reports the process failure without exposing stderr.
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (exitCode, exitSignal) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) {
          reject(
            Object.assign(new Error("Cloud request was cancelled"), {
              code: "ABORTED",
            }),
          );
          return;
        }
        const output = Buffer.concat(stdout).toString("utf8");
        if (exitCode === 2 && !exitSignal) {
          try {
            const response = JSON.parse(output);
            if (
              response?.ok === false &&
              ["BROKER_INPUT_TOO_LARGE", "INVALID_BROKER_INPUT"].includes(
                response.code,
              )
            ) {
              resolve(response);
              return;
            }
          } catch {
            // A crashed helper may also exit 2. Report it as process failure.
          }
        }
        if (exitCode !== 0 || exitSignal) {
          reject(
            Object.assign(
              new Error("Cloud egress helper exited before returning a result"),
              {
                code: "BROKER_PROCESS_FAILED",
                exitCode,
                exitSignal,
              },
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(
            Object.assign(
              new Error("Cloud egress helper returned invalid output"),
              { code: "BROKER_INVALID_OUTPUT", cause: error },
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export { seatbeltProfile as __seatbeltProfile };
