import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  detect: vi.fn(),
  getConfig: vi.fn(),
  setEnabled: vi.fn(),
  ensureKey: vi.fn(),
}));

vi.mock("../src/config/config.js", () => ({
  default: {
    aiResearch: {
      openai: { enabled: false },
      agentCloak: {
        enabled: false,
        mode: "mcp",
        desktopUrl: "http://127.0.0.1:8787/detect",
        timeoutMs: 10000,
      },
    },
  },
}));
vi.mock("../src/services/agentCloakPreflight.js", () => ({
  detectAgentCloakDesktopSpans: calls.detect,
}));
vi.mock("../src/services/agentCloakRuntimeConfig.js", () => ({
  getAgentCloakConfig: calls.getConfig,
  setAgentCloakDesktopEnabled: calls.setEnabled,
}));
vi.mock("../src/services/aiReferenceKeySetup.js", () => ({
  ensureReferenceMappingKey: calls.ensureKey,
}));
vi.mock("../src/services/aiReferenceService.js", () => ({
  mappingKey: vi.fn(() => Buffer.alloc(32)),
}));

import {
  agentCloakDesktopStatus,
  configureAgentCloakDesktop,
  __probeAgentCloakDesktop,
} from "../src/services/agentCloakDesktopSetupService.js";

beforeEach(() => {
  vi.clearAllMocks();
  calls.detect.mockResolvedValue([]);
  calls.getConfig.mockResolvedValue({ enabled: true, mode: "desktop" });
});

describe("AgentCloak Desktop setup", () => {
  it("probes with synthetic text and a bounded timeout", async () => {
    expect(await __probeAgentCloakDesktop()).toBe(true);
    expect(calls.detect).toHaveBeenCalledWith(
      "Vision privacy connection check",
      expect.objectContaining({
        config: expect.objectContaining({
          enabled: true,
          mode: "desktop",
          timeoutMs: 1500,
        }),
      }),
    );
  });

  it("returns only connection and configuration booleans", async () => {
    expect(await agentCloakDesktopStatus()).toEqual({
      enabled: true,
      available: true,
      mappingKeyConfigured: true,
      openAiEnabled: false,
    });
  });

  it("creates the key and enables protection even before OpenAI is configured", async () => {
    await configureAgentCloakDesktop(true);
    expect(calls.ensureKey).toHaveBeenCalledOnce();
    expect(calls.setEnabled).toHaveBeenCalledWith(true);
  });

  it("fails closed without persisting enablement when Desktop cannot be reached", async () => {
    calls.detect.mockRejectedValue(new Error("unavailable"));
    await expect(configureAgentCloakDesktop(true)).rejects.toMatchObject({
      code: "AGENTCLOAK_DESKTOP_UNAVAILABLE",
    });
    expect(calls.ensureKey).not.toHaveBeenCalled();
    expect(calls.setEnabled).not.toHaveBeenCalled();
  });

  it("disables without deleting the installation key", async () => {
    await configureAgentCloakDesktop(false);
    expect(calls.setEnabled).toHaveBeenCalledWith(false);
    expect(calls.ensureKey).not.toHaveBeenCalled();
  });

  it("returns a stable conflict when a previous mapping key is invalid", async () => {
    calls.ensureKey.mockImplementation(() => {
      throw Object.assign(new Error("invalid"), {
        code: "REFERENCE_KEY_INVALID",
      });
    });
    await expect(configureAgentCloakDesktop(true)).rejects.toMatchObject({
      code: "REFERENCE_KEY_INVALID",
      status: 409,
    });
    expect(calls.setEnabled).not.toHaveBeenCalled();
  });
});
