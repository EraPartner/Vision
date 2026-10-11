#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  __prepareSyntheticCodexProbe as prepareSyntheticCodexProbe,
  __validateEffectiveProbeConfig as validateEffectiveProbeConfig,
  type ProbeAssessment,
} from "../src/integrations/codex/syntheticProbe.ts";
import {
  codexOfflineSeatbeltProfile,
  codexProxySeatbeltProfile,
} from "../src/integrations/codex/seatbelt.ts";

interface AppServerResult {
  passed: boolean;
  initialized: boolean;
  config: ProbeAssessment;
  failure: string | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  profileNetworkAccess: "denied";
}

/** The TCP port a server listening on 127.0.0.1 is bound to, as a string. */
function listeningPort(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic server has no TCP address");
  }
  return String(address.port);
}

const binary = await realpath(
  process.env.VISION_CODEX_PROBE_BIN || "/opt/homebrew/bin/codex",
);
const probe = await prepareSyntheticCodexProbe(tmpdir());
const outside = await mkdtemp(join(tmpdir(), "vision-codex-outside-"));

try {
  const profile = codexOfflineSeatbeltProfile(binary, probe.root);
  const executableRule = `(allow process-exec (literal ${JSON.stringify(binary)}))`;
  if (!profile.includes(executableRule))
    throw new Error("Codex execution rule absent");
  const catProfile = profile.replace(
    executableRule,
    '(allow process-exec (literal "/bin/cat"))(allow file-read* (literal "/bin/cat"))',
  );
  const outsideFile = join(outside, "private-synthetic.txt");
  await writeFile(outsideFile, "synthetic-private-sentinel\n", { mode: 0o600 });
  const allowedRead = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", catProfile, "/bin/cat", join(probe.workspaceDir, "question.txt")],
    { encoding: "utf8", env: probe.environment },
  );
  const deniedRead = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", catProfile, "/bin/cat", outsideFile],
    { encoding: "utf8", env: probe.environment },
  );
  const networkProfile = profile.replace(
    executableRule,
    '(allow process-exec (literal "/usr/bin/nc"))',
  );
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = listeningPort(server);
  const tryConnect = (
    sandboxed: boolean,
    targetPort: string = port,
    policy: string = networkProfile,
    onDiagnostic: (diagnostic: string) => void = () => {},
  ) =>
    new Promise<boolean>((resolve) => {
      const args = ["-G", "1", "127.0.0.1", String(targetPort)];
      const child = spawn(
        sandboxed ? "/usr/bin/sandbox-exec" : "/usr/bin/nc",
        sandboxed ? ["-p", policy, "/usr/bin/nc", ...args] : args,
        { env: probe.environment, stdio: ["ignore", "ignore", "pipe"] },
      );
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic += chunk.toString("utf8");
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => {
        onDiagnostic(diagnostic.slice(0, 180));
        resolve(code === 0);
      });
    });
  const controlConnected = await tryConnect(false);
  const beforeDenied = connections;
  const sandboxConnected = await tryConnect(true);
  const networkDenied =
    controlConnected && !sandboxConnected && connections === beforeDenied;
  const proxyPolicy = codexProxySeatbeltProfile(
    binary,
    probe.root,
    Number(port),
  ).replace(executableRule, '(allow process-exec (literal "/usr/bin/nc"))');
  let proxyDiagnostic = "";
  const proxyAllowed = await tryConnect(true, port, proxyPolicy, (value) => {
    proxyDiagnostic = value;
  });
  let otherConnections = 0;
  const otherServer = createServer((socket) => {
    otherConnections += 1;
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    otherServer.once("error", reject);
    otherServer.listen(0, "127.0.0.1", () => resolve());
  });
  const wrongPort = listeningPort(otherServer);
  const wrongPortAllowed = await tryConnect(true, wrongPort, proxyPolicy);
  await new Promise<void>((resolve) => otherServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await new Promise<AppServerResult>((resolve) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        binary,
        "app-server",
        "--strict-config",
        "--listen",
        "stdio://",
      ],
      {
        cwd: probe.workspaceDir,
        env: probe.environment,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let buffered = "";
    let bytes = 0;
    let initialized = false;
    let config: ProbeAssessment | undefined;
    let failure: string | undefined;
    let finished = false;
    const timer = setTimeout(() => {
      failure = failure || "TIMEOUT";
      child.kill("SIGKILL");
    }, 6000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failure = "OUTPUT_TOO_LARGE";
        child.kill("SIGKILL");
        return;
      }
      buffered += chunk.toString("utf8");
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          // A JSON `null` line is invalid output, as reading a field of it throws.
          if (message === null) throw new TypeError("null app-server message");
          const record = typeof message === "object" ? message : {};
          const id = "id" in record ? record.id : undefined;
          if (id === 1) {
            initialized = Boolean(
              "result" in record ? record.result : undefined,
            );
          }
          if (id === 2) {
            config = validateEffectiveProbeConfig(message);
            child.kill("SIGTERM");
          }
          if ("error" in record && record.error) failure = "APP_SERVER_ERROR";
        } catch {
          failure = "INVALID_APP_SERVER_OUTPUT";
          child.kill("SIGKILL");
        }
      }
    });
    child.on("error", () => {
      failure = "LAUNCH_FAILED";
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        passed: initialized && config?.ok === true && !failure,
        initialized,
        config: config || { ok: false, reasons: ["CONFIG_NOT_READ"] },
        failure,
        exitCode: code,
        signal,
        profileNetworkAccess: "denied",
      });
    });
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("error", () => {});
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "vision_synthetic",
          title: "Vision Synthetic",
          version: "0.1.0",
        },
      },
    });
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "config/read", params: {} });
  });
  const passed =
    result.passed &&
    allowedRead.status === 0 &&
    deniedRead.status !== 0 &&
    networkDenied &&
    proxyAllowed &&
    !wrongPortAllowed &&
    otherConnections === 0 &&
    /Operation not permitted/i.test(deniedRead.stderr || "");
  console.log(
    JSON.stringify({
      ...result,
      passed,
      allowedSyntheticRead: allowedRead.status === 0,
      allowedReadDiagnostic: (allowedRead.stderr || "").slice(0, 180),
      outsideFileDenied: deniedRead.status !== 0,
      outsideReadDiagnostic: (deniedRead.stderr || "").slice(0, 180),
      networkControlConnected: controlConnected,
      networkDenied,
      proxyAllowed,
      proxyDiagnostic,
      otherPortDenied: !wrongPortAllowed && otherConnections === 0,
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await rm(probe.root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
