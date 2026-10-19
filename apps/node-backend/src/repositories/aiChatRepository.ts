/**
 * AI chat persistence layer.
 *
 * Tables:
 *   - ai_conversations (id UUID, title, model, created_at, updated_at)
 *   - ai_messages      (id UUID, conversation_id FK, role, content,
 *                       tool_name, tool_args JSONB, tool_result JSONB,
 *                       status, created_at)
 *
 * A DB trigger bumps `ai_conversations.updated_at` after every message insert,
 * so this module never needs to touch `updated_at` manually.
 */

import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  aiConversationRowSchema,
  aiMessageRowSchema,
  intTotalRowSchema,
  uuidIdRowSchema,
} from "../database/rows/ai.ts";
import type { Json } from "../database/schema.generated.ts";
import type { AiConversationRow, AiMessageRow } from "../types/rows.ts";
import { nanToZero } from "../lib/math.ts";

const CONVERSATION_COLUMNS = [
  "id",
  "title",
  "model",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;
const MESSAGE_COLUMNS = [
  "id",
  "conversation_id as conversationId",
  "role",
  "content",
  "tool_name as toolName",
  "tool_args as toolArgs",
  "tool_result as toolResult",
  "status",
  "created_at as createdAt",
] as const;

const PG_FK_VIOLATION = "23503";

export class ConversationDeletedError extends Error {
  code: string;
  conversationId: string;

  /**
   * @param conversationId UUID of the deleted conversation.
   * @param cause The underlying pg FK-violation error.
   */
  constructor(conversationId: string, cause?: unknown) {
    super(
      `Conversation ${conversationId} was deleted while a message was being appended`,
    );
    this.name = "ConversationDeletedError";
    this.code = "CONVERSATION_DELETED";
    this.conversationId = conversationId;
    if (cause) this.cause = cause;
  }
}

/**
 * @param value Arbitrary JSON-serialisable value.
 */
function jsonb(value: unknown) {
  if (value === undefined || value === null) return null;
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

const aiChatRepository = {
  async listConversations(page: {
    limit: number;
    offset: number;
  }): Promise<{ items: AiConversationRow[]; total: number }> {
    const [items, countRows] = await Promise.all([
      checkedRows(
        aiConversationRowSchema,
        db
          .selectFrom("ai_conversations")
          .select(CONVERSATION_COLUMNS)
          .orderBy("updated_at", "desc")
          .limit(page.limit)
          .offset(page.offset),
      ),
      checkedRows(
        intTotalRowSchema,
        db
          .selectFrom("ai_conversations")
          .select(sql<number>`COUNT(*)::int`.as("total")),
      ),
    ]);
    return {
      items,
      total: nanToZero(Number(countRows[0]?.total)),
    };
  },

  /**
   * @param id UUID.
   */
  async getConversation(id: string): Promise<AiConversationRow | null> {
    const row = await checkedRow(
      aiConversationRowSchema,
      db
        .selectFrom("ai_conversations")
        .select(CONVERSATION_COLUMNS)
        .where("id", "=", id),
    );
    return row ?? null;
  },

  async createConversation({
    title,
    model,
  }: {
    title: string;
    model: string;
  }): Promise<AiConversationRow> {
    const row = await checkedRow(
      aiConversationRowSchema,
      db
        .insertInto("ai_conversations")
        .values({ title, model })
        .returning(CONVERSATION_COLUMNS),
    );
    if (!row) throw new Error("ai_conversations insert returned no row");
    return row;
  },

  /**
   * @param id UUID.
   */
  async renameConversation(
    id: string,
    title: string,
  ): Promise<AiConversationRow | null> {
    const row = await checkedRow(
      aiConversationRowSchema,
      db
        .updateTable("ai_conversations")
        .set({ title, updated_at: sql<Date>`NOW()` })
        .where("id", "=", id)
        .returning(CONVERSATION_COLUMNS),
    );
    return row ?? null;
  },

  /**
   * @param id UUID.
   */
  async updateConversationModel(
    id: string,
    model: string,
  ): Promise<AiConversationRow | null> {
    const row = await checkedRow(
      aiConversationRowSchema,
      db
        .updateTable("ai_conversations")
        .set({ model, updated_at: sql<Date>`NOW()` })
        .where("id", "=", id)
        .returning(CONVERSATION_COLUMNS),
    );
    return row ?? null;
  },

  /**
   * @param id UUID.
   * @returns true if a row was removed
   */
  async deleteConversation(id: string): Promise<boolean> {
    const rows = await checkedRows(
      uuidIdRowSchema,
      db.deleteFrom("ai_conversations").where("id", "=", id).returning("id"),
    );
    return rows.length > 0;
  },

  /**
   * @param conversationId UUID.
   */
  async getMessages(conversationId: string): Promise<AiMessageRow[]> {
    return checkedRows(
      aiMessageRowSchema,
      db
        .selectFrom("ai_messages")
        .select(MESSAGE_COLUMNS)
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc"),
    );
  },

  async appendMessage({
    conversationId,
    role,
    content = null,
    toolName = null,
    toolArgs = null,
    toolResult = null,
    status = "complete",
  }: {
    conversationId: string;
    role: string;
    content?: string | null;
    toolName?: string | null;
    toolArgs?: unknown;
    toolResult?: unknown;
    status?: string;
  }): Promise<AiMessageRow> {
    try {
      const row = await checkedRow(
        aiMessageRowSchema,
        db
          .insertInto("ai_messages")
          .values({
            conversation_id: conversationId,
            role,
            content,
            tool_name: toolName,
            tool_args: jsonb(toolArgs),
            tool_result: jsonb(toolResult),
            status,
          })
          .returning(MESSAGE_COLUMNS),
      );
      if (!row) throw new Error("ai_messages insert returned no row");
      return row;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === PG_FK_VIOLATION
      ) {
        throw new ConversationDeletedError(conversationId, err);
      }
      throw err;
    }
  },
};

export default aiChatRepository;
export { aiChatRepository };
