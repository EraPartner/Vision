import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn() },
  poolQuery: vi.fn(),
}));

vi.mock("../src/database/connection.js", () =>
  mockTxConnection(mocks.client, { query: mocks.poolQuery }),
);

import { upsertExposureBundle } from "../src/repositories/portfolioExposureRepository.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.query.mockResolvedValue({ rows: [] });
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

describe("portfolio exposure source persistence", () => {
  it("upserts matching sources without deleting omitted sources", async () => {
    await upsertExposureBundle({
      classifications: [
        {
          investmentId: 7,
          issuerId: "issuer-7",
          issuerName: "Issuer Seven",
          sourceLabel: "User mapping",
        },
      ],
      fundDocuments: [
        {
          investmentId: 8,
          shareClassIdentifier: { type: "isin", value: "IE00B4L5Y983" },
          document: { source: { asOfDate: "2026-09-01" } },
          sourceSha256: "a".repeat(64),
        },
      ],
    });

    const sql = mocks.client.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).toContain(
      "ON CONFLICT (investment_id) WHERE investment_id IS NOT NULL",
    );
    expect(sql).toContain("ON CONFLICT (investment_id) DO UPDATE");
  });
});
