import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  codexOfflineSeatbeltProfile,
  codexProxySeatbeltProfile,
} from "./seatbelt.js";
import {
  syntheticProbeEnvironment,
  __validateEffectiveProbeConfig as validateEffectiveProbeConfig,
} from "./syntheticProbe.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function contained(root, candidate) {
  const base = `${resolve(root)}/`;
  if (!resolve(candidate).startsWith(base))
    throw new TypeError("Codex path escapes its private root");
}

/** @param {{binary: string, root: string, homeDir: string, workspaceDir: string, proxyPort?: number, spawnImpl?: typeof spawn, onNotification?: (message: any) => void}} options */
export async function startCodexAppServerSession({
  binary,
  root,
  homeDir,
  workspaceDir,
  proxyPort,
  spawnImpl = spawn,
  onNotification = () => {},
}) {
  const executable = await realpath(binary);
  const privateRoot = await realpath(root);
  const home = await realpath(homeDir);
  const workspace = await realpath(workspaceDir);
  contained(privateRoot, home);
  contained(privateRoot, workspace);
  if (process.platform !== "darwin") throw failure("CODEX_SANDBOX_UNAVAILABLE");
  const profile =
    proxyPort === undefined
      ? codexOfflineSeatbeltProfile(executable, privateRoot)
      : codexProxySeatbeltProfile(executable, privateRoot, proxyPort);
  /** @type {Record<string, string>} */
  const env = {
    ...syntheticProbeEnvironment({
      homeDir: home,
      workspaceDir: workspace,
    }),
  };
  if (proxyPort !== undefined) {
    const proxy = `http://127.0.0.1:${proxyPort}`;
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = "";
  }
  const child = spawnImpl(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      profile,
      executable,
      "app-server",
      "--strict-config",
      "--listen",
      "stdio://",
    ],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let totalBytes = 0;
  let closed = false;
  let unsafe = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const stop = (code) => {
    if (closed) return;
    closed = true;
    unsafe = true;
    child.kill("SIGTERM");
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(failure(code));
    }
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    if (closed) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_TOTAL_BYTES) return stop("CODEX_OUTPUT_TOO_LARGE");
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES)
      return stop("CODEX_FRAME_TOO_LARGE");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return stop("CODEX_INVALID_FRAME");
      }
      if (!message || typeof message !== "object")
        return stop("CODEX_INVALID_FRAME");
      if (message.id !== undefined && message.method)
        return stop("CODEX_SERVER_REQUEST_DENIED");
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return stop("CODEX_UNEXPECTED_RESPONSE");
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(failure("CODEX_REQUEST_FAILED"));
        else waiter.resolve(message);
      } else if (typeof message.method === "string") {
        try {
          onNotification(message);
        } catch (error) {
          stop(
            typeof error?.code === "string" &&
              /^CODEX_[A-Z_]+$/.test(error.code)
              ? error.code
              : "CODEX_NOTIFICATION_REJECTED",
          );
        }
      } else {
        stop("CODEX_INVALID_FRAME");
      }
    }
  });
  child.stdin.on("error", () => {});
  child.on("error", () => stop("CODEX_LAUNCH_FAILED"));
  child.on("close", () => {
    stop("CODEX_PROCESS_CLOSED");
    resolveExit();
  });

  const request = (method, params, timeoutMs = 5000) => {
    if (closed || unsafe)
      return Promise.reject(failure("CODEX_PROCESS_CLOSED"));
    const id = nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        stop("CODEX_REQUEST_TIMEOUT");
      }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      const line = `${JSON.stringify({ id, method, params })}\n`;
      if (Buffer.byteLength(line) > 16 * 1024)
        return stop("CODEX_REQUEST_TOO_LARGE");
      child.stdin.write(line);
    });
  };
  try {
    await request("initialize", {
      clientInfo: {
        name: "vision_experimental",
        title: "Vision Experimental",
        version: "0.1.0",
      },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    const config = await request("config/read", {});
    const assessed = validateEffectiveProbeConfig(config);
    if (!assessed.ok) throw failure("CODEX_EFFECTIVE_CONFIG_UNSAFE");
  } catch (error) {
    stop(error.code || "CODEX_STARTUP_FAILED");
    throw error;
  }
  return {
    accountRead: async () =>
      (await request("account/read", { refreshToken: false })).result,
    rateLimitsRead: async () =>
      (await request("account/rateLimits/read", {})).result,
    startDeviceLogin: async () =>
      (
        await request(
          "account/login/start",
          { type: "chatgptDeviceCode" },
          15000,
        )
      ).result,
    logout: async () => (await request("account/logout", {})).result,
    async startThread() {
      return (
        await request("thread/start", {
          cwd: workspace,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
        })
      ).result;
    },
    async startTurn(threadId, text) {
      if (
        typeof threadId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(threadId) ||
        typeof text !== "string" ||
        text.length > 4000 ||
        !text.trim()
      ) {
        throw new TypeError("Invalid synthetic Codex turn");
      }
      return (
        await request(
          "turn/start",
          {
            threadId,
            input: [{ type: "text", text }],
            cwd: workspace,
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            approvalPolicy: "never",
          },
          15000,
        )
      ).result;
    },
    async close() {
      stop("CODEX_SESSION_CLOSED");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    },
  };
}
