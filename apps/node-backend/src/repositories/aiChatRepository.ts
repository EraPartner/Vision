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

import { query } from "../database/connection.ts";
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
    const [itemsResult, countResult] = await Promise.all([
      query<AiConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS}
           FROM ai_conversations
          ORDER BY updated_at DESC
          LIMIT $1 OFFSET $2`,
        [page.limit, page.offset],
      ),
      query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM ai_conversations`,
      ),
    ]);
    return {
      items: itemsResult.rows,
      total: Number(countResult.rows[0]?.total) || 0,
    };
  },

  /**
   * @param id UUID.
   */
  async getConversation(id: string): Promise<AiConversationRow | null> {
    const result = await query<AiConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM ai_conversations WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  },

  async createConversation({
    title,
    model,
  }: {
    title: string;
    model: string;
  }): Promise<AiConversationRow> {
    const result = await query<AiConversationRow>(
      `INSERT INTO ai_conversations (title, model)
       VALUES ($1, $2)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [title, model],
    );
    return result.rows[0];
  },

  /**
   * @param id UUID.
   */
  async renameConversation(
    id: string,
    title: string,
  ): Promise<AiConversationRow | null> {
    const result = await query<AiConversationRow>(
      `UPDATE ai_conversations
          SET title = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, title],
    );
    return result.rows[0] || null;
  },

  /**
   * @param id UUID.
   */
  async updateConversationModel(
    id: string,
    model: string,
  ): Promise<AiConversationRow | null> {
    const result = await query<AiConversationRow>(
      `UPDATE ai_conversations
          SET model = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, model],
    );
    return result.rows[0] || null;
  },

  /**
   * @param id UUID.
   * @returns true if a row was removed
   */
  async deleteConversation(id: string): Promise<boolean> {
    const result = await query<{ id: string }>(
      `DELETE FROM ai_conversations WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  },

  /**
   * @param conversationId UUID.
   */
  async getMessages(conversationId: string): Promise<AiMessageRow[]> {
    const result = await query<AiMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return result.rows;
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
      const result = await query<AiMessageRow>(
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
      return result.rows[0];
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
