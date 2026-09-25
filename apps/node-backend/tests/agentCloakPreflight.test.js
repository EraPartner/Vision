import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/config.js", () => ({
  default: { aiResearch: { agentCloak: { enabled: false } } },
}));

import { checkAgentCloakPreflight } from "../src/services/agentCloakPreflight.js";

const config = {
  enabled: true,
  url: "http://127.0.0.1:8765/mcp",
  apiKey: "synthetic-agentcloak-key",
  timeoutMs: 1000,
};

function cloakResponse(result) {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: { structuredContent: { result, id: "synthetic-cloak-id" } },
  });
}

describe("AgentCloak cloud disclosure preflight", () => {
  it("does nothing when disabled", async () => {
    const fetchImpl = vi.fn();
    await expect(
      checkAgentCloakPreflight(
        { selectedEvidence: "Private data" },
        {
          config: { enabled: false },
          fetchImpl,
        },
      ),
    ).resolves.toEqual({ enabled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks only selected outbound text and strips local reference tokens", async () => {
    const token = "[[VR1:recipient:AAAAAAAAAAAAAAAAAAAAAAAA]]";
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return cloakResponse(body.params.arguments.message);
    });
    await expect(
      checkAgentCloakPreflight(
        { selectedEvidence: `Pay ${token} tomorrow`, publicSchema: "schema" },
        { config, fetchImpl },
      ),
    ).resolves.toEqual({ enabled: true, status: "passed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(config.url);
    expect(init.redirect).toBe("error");
    expect(init.body).toContain("Pay REFERENCE tomorrow");
    expect(init.body).not.toContain(token);
    expect(init.body).not.toContain("schema");
    expect(init.headers["x-inc-agentcloak-api-key"]).toBe(config.apiKey);
    expect(init.headers.Accept).toBe("application/json, text/event-stream");
  });

  it("accepts a bounded MCP event stream response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          ': keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"result":"Synthetic question","id":"synthetic-cloak-id"}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(
      checkAgentCloakPreflight(
        { question: "Synthetic question" },
        { config, fetchImpl },
      ),
    ).resolves.toEqual({ enabled: true, status: "passed" });
  });

  it("blocks a disclosure when AgentCloak would cloak an unmarked value", async () => {
    const fetchImpl = vi.fn(async () =>
      cloakResponse("Pay [NamePlaceholder1]"),
    );
    await expect(
      checkAgentCloakPreflight(
        { selectedEvidence: "Pay Alice Johnson" },
        { config, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "AGENTCLOAK_SENSITIVE_TEXT" });
  });

  it.each([
    ["remote host", "https://agentcloak.example/mcp"],
    ["redirectable path", "http://127.0.0.1:8765/other"],
    ["URL credentials", "http://user:pass@127.0.0.1:8765/mcp"],
  ])("rejects a %s before sending text", async (_label, url) => {
    const fetchImpl = vi.fn();
    await expect(
      checkAgentCloakPreflight(
        { selectedSummary: "Synthetic summary" },
        { config: { ...config, url }, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "AGENTCLOAK_CONFIGURATION_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid or unavailable service response", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: -32603 } }),
    );
    await expect(
      checkAgentCloakPreflight(
        { question: "Public question" },
        { config, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "AGENTCLOAK_PREFLIGHT_FAILED" });
  });
});
