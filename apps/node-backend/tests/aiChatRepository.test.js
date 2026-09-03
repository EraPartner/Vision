import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () => mockConnection());

import { query } from "../src/database/connection.js";
import { aiChatRepository } from "../src/repositories/aiChatRepository.js";

describe("aiChatRepository.listConversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the historical unbounded query when pagination is omitted", async () => {
    query.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }] });

    await expect(aiChatRepository.listConversations()).resolves.toEqual({
      items: [{ id: "a" }, { id: "b" }],
      total: 2,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).not.toContain("LIMIT");
  });

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
