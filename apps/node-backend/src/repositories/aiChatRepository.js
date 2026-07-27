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

import { query } from '../database/connection.js';

/** @typedef {import('../types/rows.js').AiConversationRow} AiConversationRow */
/** @typedef {import('../types/rows.js').AiMessageRow} AiMessageRow */

const CONVERSATION_COLUMNS =
  'id, title, model, created_at AS "createdAt", updated_at AS "updatedAt"';
const MESSAGE_COLUMNS =
  'id, conversation_id AS "conversationId", role, content, '
  + 'tool_name AS "toolName", tool_args AS "toolArgs", tool_result AS "toolResult", '
  + 'status, created_at AS "createdAt"';

const PG_FK_VIOLATION = '23503';

export class ConversationDeletedError extends Error {
  /**
   * @param {string} conversationId UUID of the deleted conversation.
   * @param {unknown} [cause] The underlying pg FK-violation error.
   */
  constructor(conversationId, cause) {
    super(`Conversation ${conversationId} was deleted while a message was being appended`);
    this.name = 'ConversationDeletedError';
    this.code = 'CONVERSATION_DELETED';
    this.conversationId = conversationId;
    if (cause) this.cause = cause;
  }
}

/**
 * @param {any} value Arbitrary JSON-serialisable value.
 * @returns {string|null}
 */
function serializeJsonb(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

const aiChatRepository = {
  /** @returns {Promise<AiConversationRow[]>} */
  async listConversations() {
    const result = await query(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM ai_conversations
        ORDER BY updated_at DESC`,
    );
    return result.rows;
  },

  /**
   * @param {string} id UUID.
   * @returns {Promise<AiConversationRow|null>}
   */
  async getConversation(id) {
    const result = await query(
      `SELECT ${CONVERSATION_COLUMNS} FROM ai_conversations WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  },

  /**
   * @param {{ title: string, model: string }} input
   * @returns {Promise<AiConversationRow>}
   */
  async createConversation({ title, model }) {
    const result = await query(
      `INSERT INTO ai_conversations (title, model)
       VALUES ($1, $2)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [title, model],
    );
    return result.rows[0];
  },

  /**
   * @param {string} id UUID.
   * @param {string} title
   * @returns {Promise<AiConversationRow|null>}
   */
  async renameConversation(id, title) {
    const result = await query(
      `UPDATE ai_conversations
          SET title = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, title],
    );
    return result.rows[0] || null;
  },

  /**
   * @param {string} id UUID.
   * @param {string} model
   * @returns {Promise<AiConversationRow|null>}
   */
  async updateConversationModel(id, model) {
    const result = await query(
      `UPDATE ai_conversations
          SET model = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS}`,
      [id, model],
    );
    return result.rows[0] || null;
  },

  /**
   * @param {string} id UUID.
   * @returns {Promise<boolean>} true if a row was removed
   */
  async deleteConversation(id) {
    const result = await query(
      `DELETE FROM ai_conversations WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  },

  /**
   * @param {string} conversationId UUID.
   * @returns {Promise<AiMessageRow[]>}
   */
  async getMessages(conversationId) {
    const result = await query(
      `SELECT ${MESSAGE_COLUMNS}
         FROM ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return result.rows;
  },

  /**
   * @param {{
   *   conversationId: string,
   *   role: string,
   *   content?: string|null,
   *   toolName?: string|null,
   *   toolArgs?: any,
   *   toolResult?: any,
   *   status?: string,
   * }} input
   * @returns {Promise<AiMessageRow>}
   */
  async appendMessage({
    conversationId,
    role,
    content = null,
    toolName = null,
    toolArgs = null,
    toolResult = null,
    status = 'complete',
  }) {
    try {
      const result = await query(
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
    } catch (/** @type {any} */ err) {
      if (err && err.code === PG_FK_VIOLATION) {
        throw new ConversationDeletedError(conversationId, err);
      }
      throw err;
    }
  },

  /**
   * @param {string} id UUID.
   * @param {string} status
   * @returns {Promise<AiMessageRow|null>}
   */
  async updateMessageStatus(id, status) {
    const result = await query(
      `UPDATE ai_messages
          SET status = $2
        WHERE id = $1
        RETURNING ${MESSAGE_COLUMNS}`,
      [id, status],
    );
    return result.rows[0] || null;
  },
};

export default aiChatRepository;
export { aiChatRepository };
