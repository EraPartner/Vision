import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExperimentalCodexSession,
  __limitsPermitSyntheticTurn,
} from "../src/integrations/codex/experimentalSession.js";

const cleanup = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture({
  authenticated = true,
  limits = { rateLimits: { primary: { usedPercent: 3 }, secondary: null } },
  onTurn,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "vision-codex-session-test-"));
  cleanup.push(root);
  const calls = {
    proxyClosed: 0,
    serverClosed: 0,
    logout: 0,
    sentText: undefined,
  };
  let notify;
  let signedIn = authenticated;
  const session = createExperimentalCodexSession({
    binary: "/synthetic/codex",
    prepare: async () => ({ root, homeDir: root, workspaceDir: root }),
    startProxy: async () => ({
      port: 12345,
      close: async () => {
        calls.proxyClosed++;
      },
    }),
    startServer: async ({ onNotification }) => {
      notify = onNotification;
      return {
        accountRead: async () => ({
          account: signedIn ? { type: "chatgpt", planType: "plus" } : null,
        }),
        rateLimitsRead: async () => limits,
        startDeviceLogin: async () => ({
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        }),
        startThread: async () => ({
          thread: { id: "12345678-1234-1234-1234-123456789abc" },
        }),
        startTurn: async (_threadId, text) => {
          calls.sentText = text;
          onTurn?.(notify);
        },
        logout: async () => {
          calls.logout++;
          signedIn = false;
        },
        close: () => {
          calls.serverClosed++;
        },
      };
    },
  });
  return { session, calls, notify: () => notify };
}

describe("experimental Codex session", () => {
  it("blocks missing or exhausted subscription windows", () => {
    expect(
      __limitsPermitSyntheticTurn({
        rateLimits: { primary: { usedPercent: 100 } },
      }),
    ).toBe(false);
    expect(
      __limitsPermitSyntheticTurn({
        rateLimits: { primary: { usedPercent: 4 } },
        ordinaryUsageAllowed: false,
      }),
    ).toBe(false);
    expect(
      __limitsPermitSyntheticTurn({
        rateLimits: { primary: { usedPercent: 4 } },
      }),
    ).toBe(true);
  });
  it("sends only the built-in synthetic question and closes isolated resources", async () => {
    const { session, calls } = await fixture({
      onTurn: (notify) => {
        notify({
          method: "item/completed",
          params: { item: { type: "agentMessage", text: "Synthetic answer" } },
        });
        notify({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      },
    });
    await session.start();
    expect(await session.status()).toMatchObject({
      authenticated: true,
      accountType: "chatgpt",
    });
    expect(await session.login()).toMatchObject({ userCode: "ABCD-1234" });
    expect(await session.runSynthetic()).toEqual({
      question: calls.sentText,
      answer: "Synthetic answer",
    });
    expect(calls.sentText).toContain("fictional household");
    await session.logout();
    expect(calls).toMatchObject({ proxyClosed: 1, serverClosed: 1, logout: 1 });
  });

  it("blocks use without a ChatGPT account before starting a thread", async () => {
    const { session, calls } = await fixture({ authenticated: false });
    await session.start();
    await expect(session.runSynthetic()).rejects.toMatchObject({
      code: "CODEX_SUBSCRIPTION_REQUIRED",
    });
    expect(calls.sentText).toBeUndefined();
    await session.stop();
  });

  it("fails closed on tool activity and disposes the session", async () => {
    const { session, calls } = await fixture({
      onTurn: (notify) =>
        notify({
          method: "item/started",
          params: { item: { type: "commandExecution" } },
        }),
    });
    await session.start();
    await expect(session.runSynthetic()).rejects.toMatchObject({
      code: "CODEX_TOOL_ACTIVITY_DENIED",
    });
    expect(calls).toMatchObject({ proxyClosed: 1, serverClosed: 1 });
  });
});
