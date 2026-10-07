import { rm } from "node:fs/promises";
import { startCodexAppServerSession } from "./appServerTransport.ts";
import type {
  AppServerMessage,
  CodexRateLimitWindow,
  CodexRateLimitsRead,
} from "./appServerTransport.ts";
import { startCodexConnectProxy } from "./connectProxy.ts";
import type { CodexConnectTrace } from "./connectProxy.ts";
import {
  __prepareSyntheticCodexProbe,
  cleanupStaleSyntheticCodexProbes,
} from "./syntheticProbe.ts";

const QUESTION =
  "For a fictional household, list general questions to consider before changing a savings goal. Do not use tools or personal data.";
const MAX_ANSWER = 16_384;
const ALLOWED_ITEM_TYPES: readonly unknown[] = [
  "userMessage",
  "agentMessage",
  "reasoning",
];

/** Notification params the session inspects; every field is untrusted. */
interface CodexNotification {
  method?: string;
  params?: {
    item?: { type?: unknown; text?: unknown } | null;
    turn?: { status?: unknown } | null;
  } | null;
}

interface ActiveTurn {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  answer: string;
}

export interface CodexProtocolEvent {
  method: string | undefined;
  itemType?: unknown;
}

export interface ExperimentalCodexSessionOptions {
  binary?: string;
  tempParent?: string;
  prepare?: typeof __prepareSyntheticCodexProbe;
  startProxy?: typeof startCodexConnectProxy;
  startServer?: typeof startCodexAppServerSession;
  onTrace?: (trace: CodexConnectTrace) => void;
  onProtocolEvent?: (event: CodexProtocolEvent) => void;
}

type SyntheticProbe = Awaited<ReturnType<typeof __prepareSyntheticCodexProbe>>;
type ConnectProxy = Awaited<ReturnType<typeof startCodexConnectProxy>>;
type AppServerSession = Awaited<ReturnType<typeof startCodexAppServerSession>>;

interface SessionResources {
  probe: SyntheticProbe;
  proxy: ConnectProxy;
  server: AppServerSession;
}

function fail(code: string) {
  return Object.assign(new Error(code), { code });
}

function limitsPermitSyntheticTurn(
  result: CodexRateLimitsRead | null | undefined,
) {
  if (!result || result.ordinaryUsageAllowed === false) return false;
  const snapshots = [result.rateLimits];
  if (
    result.rateLimitsByLimitId &&
    typeof result.rateLimitsByLimitId === "object"
  )
    snapshots.push(...Object.values(result.rateLimitsByLimitId));
  return snapshots.every((snapshot) => {
    if (
      !snapshot ||
      snapshot.rateLimitReachedType ||
      snapshot.spendControlReached === true
    )
      return false;
    const windows = [snapshot.primary, snapshot.secondary].filter(
      (window): window is CodexRateLimitWindow => Boolean(window),
    );
    return (
      windows.length > 0 &&
      windows.every(
        (window) =>
          typeof window.usedPercent === "number" &&
          Number.isInteger(window.usedPercent) &&
          window.usedPercent < 100,
      )
    );
  });
}

/** A single disposable, synthetic-only App Server session. */
export function createExperimentalCodexSession({
  binary,
  tempParent = "/tmp",
  prepare = __prepareSyntheticCodexProbe,
  startProxy = startCodexConnectProxy,
  startServer = startCodexAppServerSession,
  onTrace = () => {},
  onProtocolEvent = () => {},
}: ExperimentalCodexSessionOptions = {}) {
  let resources: SessionResources | undefined;
  let starting: Promise<void> | undefined;
  let activeTurn: ActiveTurn | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let poisoned = false;
  const onNotification = (message: AppServerMessage) => {
    if (!activeTurn) return;
    const { method, params } = message as CodexNotification;
    try {
      onProtocolEvent({ method, itemType: params?.item?.type });
    } catch {
      // Diagnostic callbacks cannot widen the runtime boundary.
    }
    if (method === "item/started" || method === "item/completed") {
      const type = params?.item?.type;
      if (!ALLOWED_ITEM_TYPES.includes(type)) {
        poisoned = true;
        throw fail("CODEX_TOOL_ACTIVITY_DENIED");
      }
      if (method === "item/completed" && type === "agentMessage") {
        const text = params?.item?.text;
        if (typeof text !== "string" || text.length > MAX_ANSWER) {
          poisoned = true;
          throw fail("CODEX_OUTPUT_INVALID");
        }
        activeTurn.answer = text;
      }
    } else if (method === "turn/completed") {
      const completed = activeTurn;
      activeTurn = undefined;
      if (params?.turn?.status === "completed" && completed.answer) {
        completed.resolve(completed.answer);
      } else {
        completed.reject(fail("CODEX_TURN_FAILED"));
      }
    } else if (
      method?.startsWith("item/") &&
      !method.startsWith("item/agentMessage/") &&
      !method.startsWith("item/reasoning/")
    ) {
      poisoned = true;
      throw fail("CODEX_UNEXPECTED_ACTIVITY");
    } else if (method === "turn/diff/updated") {
      poisoned = true;
      throw fail("CODEX_FILE_ACTIVITY_DENIED");
    }
  };

  async function start() {
    if (resources) return;
    if (starting) return starting;
    starting = (async () => {
      await cleanupStaleSyntheticCodexProbes(tempParent);
      const probe = await prepare(tempParent);
      let proxy: ConnectProxy | undefined;
      let server: AppServerSession | undefined;
      try {
        proxy = await startProxy({ onTrace });
        server = await startServer({
          // The route enables this session only for an absolute binary path;
          // an unset binary still fails inside realpath as before.
          binary: binary as string,
          ...probe,
          proxyPort: proxy.port,
          onNotification,
        });
        resources = { probe, proxy, server };
        expiry = setTimeout(() => void stop(), 10 * 60_000);
        expiry.unref();
      } catch (error) {
        await server?.close();
        await proxy?.close();
        await rm(probe.root, { recursive: true, force: true });
        throw error;
      }
    })();
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  }

  async function stop({ requireLogout = false } = {}) {
    if (starting) await starting.catch(() => {});
    const current = resources;
    resources = undefined;
    clearTimeout(expiry);
    activeTurn?.reject(fail("CODEX_SESSION_CLOSED"));
    activeTurn = undefined;
    if (!current) return { localDisposed: true, logoutVerified: false };
    let logoutVerified = false;
    try {
      await current.server.logout();
      const after = await current.server.accountRead();
      logoutVerified = after?.account == null;
    } catch {
      // Process failure can make remote logout unobservable; local disposal
      // still runs and the caller receives an explicit unverified result.
    } finally {
      await current.server.close();
      await current.proxy.close();
      await rm(current.probe.root, { recursive: true, force: true });
    }
    if (requireLogout && !logoutVerified) throw fail("CODEX_LOGOUT_UNVERIFIED");
    return { localDisposed: true, logoutVerified };
  }

  return {
    async status() {
      if (!resources) return { running: false, authenticated: false };
      const account = await resources.server.accountRead();
      return {
        running: true,
        authenticated: account?.account?.type === "chatgpt",
        accountType: account?.account?.type || undefined,
        planType: account?.account?.planType || undefined,
      };
    },
    start,
    async login() {
      if (!resources) throw fail("CODEX_SESSION_NOT_STARTED");
      const result = await resources.server.startDeviceLogin();
      if (
        typeof result?.verificationUrl !== "string" ||
        !/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(
          result.verificationUrl,
        ) ||
        typeof result?.userCode !== "string" ||
        !/^[A-Z0-9-]{4,32}$/.test(result.userCode)
      ) {
        throw fail("CODEX_LOGIN_RESPONSE_INVALID");
      }
      return {
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      };
    },
    async runSynthetic() {
      if (!resources || poisoned) throw fail("CODEX_SESSION_UNAVAILABLE");
      if (activeTurn) throw fail("CODEX_TURN_BUSY");
      const account = await resources.server.accountRead();
      if (account?.account?.type !== "chatgpt")
        throw fail("CODEX_SUBSCRIPTION_REQUIRED");
      // A missing or failed rate-limit read blocks the turn. Never fall back to API billing.
      const limits = await resources.server.rateLimitsRead();
      if (!limitsPermitSyntheticTurn(limits))
        throw fail("CODEX_LIMITS_UNAVAILABLE_OR_EXHAUSTED");
      const thread = await resources.server.startThread();
      const threadId = thread?.thread?.id;
      if (typeof threadId !== "string") throw fail("CODEX_THREAD_INVALID");
      const answerPromise = new Promise<string>((resolve, reject) => {
        activeTurn = { resolve, reject, answer: "" };
      });
      void answerPromise.catch(() => {});
      let timeout: NodeJS.Timeout | undefined;
      try {
        await resources.server.startTurn(threadId, QUESTION);
        const answer = await Promise.race([
          answerPromise,
          new Promise<never>(
            (_, reject) =>
              (timeout = setTimeout(
                () => reject(fail("CODEX_TURN_TIMEOUT")),
                60_000,
              )),
          ),
        ]);
        return { question: QUESTION, answer };
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      } finally {
        clearTimeout(timeout);
        activeTurn = undefined;
      }
    },
    logout: () => stop({ requireLogout: true }),
    stop,
  };
}

export { limitsPermitSyntheticTurn as __limitsPermitSyntheticTurn };
