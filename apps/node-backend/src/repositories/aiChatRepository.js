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

const CONVERSATION_COLUMNS = 'id, title, model, created_at, updated_at';
const MESSAGE_COLUMNS =
  'id, conversation_id, role, content, tool_name, tool_args, tool_result, status, created_at';

function serializeJsonb(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

const aiChatRepository = {
  async listConversations() {
    const result = await query(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM ai_conversations
        ORDER BY updated_at DESC`,
    );
    return result.rows;
  },

  async getConversation(id) {
    const result = await query(
      `SELECT ${CONVERSATION_COLUMNS} FROM ai_conversations WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  },

  async createConversation({ title, model }) {
    const result = await query(
      `INSERT INTO ai_conversations (title, model)
       VALUES ($1, $2)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [title, model],
    );
    return result.rows[0];
  },

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

  async deleteConversation(id) {
    const result = await query(
      `DELETE FROM ai_conversations WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  },

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

  async appendMessage({
    conversationId,
    role,
    content = null,
    toolName = null,
    toolArgs = null,
    toolResult = null,
    status = 'complete',
  }) {
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
  },

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
