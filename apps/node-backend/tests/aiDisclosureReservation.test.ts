import { describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.ts";

const mocked = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock("../src/database/connection.ts", () => mockTxConnection(mocked.client));

import { reserveDisclosure } from "../src/repositories/aiDisclosureRepository.ts";
import { disclosureGrantRow, disclosureRecordRow } from "./helpers/aiRows.ts";

const preview = {
  payloadSha256: "a".repeat(64),
  fieldManifest: ["question"],
  disclosureUnits: ["synthetic-question"],
  inputCharacters: 100,
  payloadBytes: 100,
};

function grant(route: string, mode: string) {
  return disclosureGrantRow({
    route,
    mode,
    expires_at: new Date(Date.now() + 60_000),
    preview_payload_sha256: preview.payloadSha256,
    allowed_fields_json: ["question"],
  });
}

/** The inserted record as `RETURNING *` hands it back. */
const insertedRecord = disclosureRecordRow({ id: "synthetic-record" });

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
      // COALESCE(SUM(bigint), 0) is NUMERIC: a string.
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [insertedRecord] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(reserveDisclosure(reservation)).resolves.toEqual(
      insertedRecord,
    );
    expect(
      mocked.client.query.mock.calls.filter(([sql]) => sql.includes("INSERT")),
    ).toHaveLength(1);
  });

  it("adds BIGINT usage counters returned as strings numerically", async () => {
    mocked.client.query.mockReset();
    mocked.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...grant("openai-api", "cloud-plan-public"),
            max_requests: 3,
            used_requests: 1,
            used_input_characters: "100",
            used_output_tokens: "50",
            used_cost_micros: "10",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      // COALESCE(SUM(bigint), 0) is NUMERIC: a string.
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [insertedRecord] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(reserveDisclosure(reservation)).resolves.toEqual(
      insertedRecord,
    );
  });
});
