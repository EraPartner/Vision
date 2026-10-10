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

import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  aiConversationRowSchema,
  aiMessageRowSchema,
  intTotalRowSchema,
  uuidIdRowSchema,
} from "../database/rows/ai.ts";
import type { AiConversationRow, AiMessageRow } from "../types/rows.ts";

export type { AiConversationRow, AiMessageRow };

const CONVERSATION_COLUMNS =
  'id, title, model, created_at AS "createdAt", updated_at AS "updatedAt"';
const MESSAGE_COLUMNS =
  'id, conversation_id AS "conversationId", role, content, ' +
  'tool_name AS "toolName", tool_args AS "toolArgs", tool_result AS "toolResult", ' +
  'status, created_at AS "createdAt"';

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
function serializeJsonb(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

const aiChatRepository = {
  async listConversations(page: {
    limit: number;
    offset: number;
  }): Promise<{ items: AiConversationRow[]; total: number }> {
    const [items, countRows] = await Promise.all([
      queryRows(
        aiConversationRowSchema,
        `SELECT ${CONVERSATION_COLUMNS}
           FROM ai_conversations
          ORDER BY updated_at DESC
          LIMIT $1 OFFSET $2`,
        [page.limit, page.offset],
      ),
      queryRows(
        intTotalRowSchema,
        `SELECT COUNT(*)::int AS total FROM ai_conversations`,
      ),
    ]);
    return {
      items,
      total: Number(countRows[0]?.total) || 0,
    };
  },

  /**
   * @param id UUID.
   */
  async getConversation(id: string): Promise<AiConversationRow | null> {
    const row = await queryOne(
      aiConversationRowSchema,
      `SELECT ${CONVERSATION_COLUMNS} FROM ai_conversations WHERE id = $1`,
      [id],
    );
    return row || null;
  },

  async createConversation({
    title,
    model,
  }: {
    title: string;
    model: string;
  }): Promise<AiConversationRow> {
    const row = await queryOne(
      aiConversationRowSchema,
      `INSERT INTO ai_conversations (title, model)
       VALUES ($1, $2)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [title, model],
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
    const row = await queryOne(
      aiConversationRowSchema,
      `UPDATE ai_conversations
          SET title = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, title],
    );
    return row || null;
  },

  /**
   * @param id UUID.
   */
  async updateConversationModel(
    id: string,
    model: string,
  ): Promise<AiConversationRow | null> {
    const row = await queryOne(
      aiConversationRowSchema,
      `UPDATE ai_conversations
          SET model = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, model],
    );
    return row || null;
  },

  /**
   * @param id UUID.
   * @returns true if a row was removed
   */
  async deleteConversation(id: string): Promise<boolean> {
    const rows = await queryRows(
      uuidIdRowSchema,
      `DELETE FROM ai_conversations WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  },

  /**
   * @param conversationId UUID.
   */
  async getMessages(conversationId: string): Promise<AiMessageRow[]> {
    return queryRows(
      aiMessageRowSchema,
      `SELECT ${MESSAGE_COLUMNS}
         FROM ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId],
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
      const row = await queryOne(
        aiMessageRowSchema,
        `INSERT INTO ai_messages
           (conversation_id, role, content, tool_name, tool_args, tool_result, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          conversationId,
          role,
          content,
          toolName,
          serializeJsonb(toolArgs),
          serializeJsonb(toolResult),
          status,
        ],
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
