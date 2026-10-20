import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.ts";

const { client } = vi.hoisted(() => ({ client: { query: vi.fn() } }));

vi.mock("../src/database/connection.ts", () => mockTxConnection(client));

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { clearProviderResult } from "../src/repositories/aiInvestigationRepository.ts";
import { partial } from "./helpers/partial.ts";

const query = vi.mocked(rawQuery);

describe("aiInvestigationRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears a stale provider checkpoint before an explicit retry", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({ rows: [{ id: "job-1" }] }),
    );

    await expect(clearProviderResult("job-1")).resolves.toEqual({
      id: "job-1",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
