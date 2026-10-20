/**
 * Synthetic AI, analysis and audit rows shaped exactly like node-postgres
 * returns them (BIGINT as strings, TIMESTAMPTZ as `Date`, JSONB parsed), for
 * tests that mock `query()` under the checked reads of those repositories and
 * services. Pass `overrides` for the columns a test cares about.
 */
import type { AiConversationRow } from "../../src/database/rows/ai.ts";

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const UUID = "00000000-0000-4000-8000-000000000001";

export function conversationRow(
  overrides: Partial<AiConversationRow> = {},
): AiConversationRow {
  return {
    id: UUID,
    title: "Synthetic conversation",
    model: "synthetic-model",
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}
