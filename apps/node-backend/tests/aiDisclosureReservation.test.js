import { describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const mocked = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock("../src/database/connection.js", () => mockTxConnection(mocked.client));

import { reserveDisclosure } from "../src/repositories/aiDisclosureRepository.js";

const preview = {
  payloadSha256: "a".repeat(64),
  fieldManifest: ["question"],
  disclosureUnits: ["synthetic-question"],
  inputCharacters: 100,
  payloadBytes: 100,
};

function grant(route, mode) {
  return {
    route,
    mode,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview_payload_sha256: preview.payloadSha256,
    allowed_fields_json: ["question"],
    used_requests: 0,
    max_requests: 1,
    used_input_characters: 0,
    max_input_characters: 1000,
    used_output_tokens: 0,
    max_output_tokens: 1000,
    used_cost_micros: 0,
    max_cost_micros: 1000,
    max_disclosure_units: 10,
    purpose: "Synthetic test",
    policy_version: 1,
  };
}

const reservation = {
  grantId: "synthetic-grant",
  jobId: "synthetic-job",
  expectedMode: "cloud-plan-public",
  preview,
  outputTokens: 50,
  costMicros: 10,
  monthlyBudgetMicros: 1000,
};

describe("disclosure grant reservation", () => {
  it.each([
    ["openai-api", "selected-summary"],
    ["codex-subscription", "cloud-plan-public"],
  ])(
    "rejects a matching payload hash with wrong route or mode",
    async (route, mode) => {
      mocked.client.query.mockReset();
      mocked.client.query.mockResolvedValueOnce({ rows: [] });
      mocked.client.query.mockResolvedValueOnce({ rows: [grant(route, mode)] });

      await expect(reserveDisclosure(reservation)).rejects.toMatchObject({
        code: "GRANT_MODE_MISMATCH",
      });
      expect(mocked.client.query).toHaveBeenCalledTimes(2);
      expect(
        mocked.client.query.mock.calls.some(([sql]) => sql.includes("INSERT")),
      ).toBe(false);
    },
  );

  it("reserves an exact matching public grant", async () => {
    mocked.client.query.mockReset();
    mocked.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [grant("openai-api", "cloud-plan-public")],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "synthetic-record" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(reserveDisclosure(reservation)).resolves.toEqual({
      id: "synthetic-record",
    });
    expect(
      mocked.client.query.mock.calls.filter(([sql]) => sql.includes("INSERT")),
    ).toHaveLength(1);
  });
});
