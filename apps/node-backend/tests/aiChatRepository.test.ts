import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { aiChatRepository } from "../src/repositories/aiChatRepository.ts";
import { conversationRow } from "./helpers/aiRows.ts";

const query = rawQuery as unknown as Mock<
  (
    text: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult<unknown>>>
>;

describe("aiChatRepository.listConversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the requested page with the full total", async () => {
    const conversation = conversationRow({ id: "c" });
    query
      .mockResolvedValueOnce({ rows: [conversation] })
      .mockResolvedValueOnce({ rows: [{ total: 101 }] });

    await expect(
      aiChatRepository.listConversations({ limit: 50, offset: 100 }),
    ).resolves.toEqual({ items: [conversation], total: 101 });

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
