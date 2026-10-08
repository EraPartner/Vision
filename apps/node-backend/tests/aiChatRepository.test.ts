import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { aiChatRepository } from "../src/repositories/aiChatRepository.ts";

const query = rawQuery as unknown as Mock<
  (
    text: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult<unknown>>>
>;

describe("aiChatRepository.listConversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a bounded page and a separate full count", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "c" }] })
      .mockResolvedValueOnce({ rows: [{ total: 101 }] });

    await expect(
      aiChatRepository.listConversations({ limit: 50, offset: 100 }),
    ).resolves.toEqual({ items: [{ id: "c" }], total: 101 });

    expect(query.mock.calls[0][0]).toContain("LIMIT $1 OFFSET $2");
    expect(query.mock.calls[0][1]).toEqual([50, 100]);
    expect(query.mock.calls[1][0]).toContain("COUNT(*)::int AS total");
  });

  it("keeps the total when an offset-past-end page has no rows", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 7 }] });

    await expect(
      aiChatRepository.listConversations({ limit: 50, offset: 100 }),
    ).resolves.toEqual({ items: [], total: 7 });
  });
});
