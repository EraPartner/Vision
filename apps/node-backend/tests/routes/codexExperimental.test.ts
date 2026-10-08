/**
 * Experimental Codex routes: the mutating endpoints accept no payload
 * (ADR-193 request validation). The access gate is enabled for loopback with
 * a configured admin token; the Codex session itself is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

const session = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  login: vi.fn(),
  runSynthetic: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../../src/integrations/codex/experimentalSession.ts", () => ({
  createExperimentalCodexSession: () => session,
}));

vi.mock("../../src/config/config.ts", () => ({
  default: { admin: { authToken: "synthetic-admin-token" } },
}));

const { default: codexRouter } =
  await import("../../src/routes/codexExperimental.ts");

const api = routeAgent(codexRouter, { mountPath: "/api/codex-experimental" });
const BASE = "/api/codex-experimental";
const ENV_KEYS = [
  "VISION_EXPERIMENTAL_CODEX",
  "VISION_EXPERIMENTAL_CODEX_BINARY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

describe("experimental Codex payload-free routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.VISION_EXPERIMENTAL_CODEX = "1";
    process.env.VISION_EXPERIMENTAL_CODEX_BINARY = "/opt/codex/bin/codex";
    session.login.mockResolvedValue({ loggedIn: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("accepts a request without a body or with an empty object", async () => {
    await api.post(`${BASE}/login`).expect(200);
    await api.post(`${BASE}/login`).send({}).expect(200);
    expect(session.login).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a populated object", { prompt: "hi" }],
    ["an array", []],
  ])("rejects %s with the no-payload message", async (_label, body) => {
    const res = await api.post(`${BASE}/login`).send(body).expect(400);
    expect(res.body).toEqual(
      errEnvelope({
        code: "VALIDATION_ERROR",
        message: "This route accepts no data payload",
      }),
    );
    expect(session.login).not.toHaveBeenCalled();
  });
});
