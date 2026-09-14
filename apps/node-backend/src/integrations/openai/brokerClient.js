import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const helperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "egress-helper.mjs",
);
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024;

function seatbeltProfile(
  runtimePath,
  helper,
  workingDirectory = "/private/tmp/vision-openai-egress-empty",
) {
  const literal = (value) => JSON.stringify(value);
  const runtimeDirectory = dirname(runtimePath);
  const runtimeRoot = dirname(runtimeDirectory);
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
(allow file-read-data file-read-metadata
  (literal ${literal(runtimePath)})
  (subpath ${literal(runtimeRoot)})
  (subpath "/opt/homebrew/opt")
  (literal ${literal(helper)})
  (subpath ${literal(workingDirectory)})
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/private/etc/ssl")
  (literal "/private/etc/resolv.conf"))
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
  if (!process.env.OPENAI_API_KEY)
    throw Object.assign(new Error("OpenAI API key is not configured"), {
      code: "OPENAI_KEY_MISSING",
    });
  const cwd = await mkdtemp(join(tmpdir(), "vision-openai-egress-"));
  try {
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
      child.on("error", reject);
      child.on("close", () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) {
          reject(
            Object.assign(new Error("Cloud request was cancelled"), {
              code: "ABORTED",
            }),
          );
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
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
