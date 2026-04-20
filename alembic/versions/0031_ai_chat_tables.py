"""AI chat persistence tables — Phase 10 of the AI chat feature.

Revision ID: 0031_ai_chat_tables
Revises: 0030_import_pipeline_staging
Create Date: 2026-04-19

Introduces two tables backing the local Ollama chat feature (ADR-024):

  * `ai_conversations` — one row per chat thread. Stores the user-chosen
    model, a display title, and timestamps. Deleting a conversation
    cascades to its messages.

  * `ai_messages` — ordered messages for each conversation. Role is one
    of `user`, `assistant`, `tool`, `system`. Tool calls persist the
    tool name, invocation args (JSONB), and result payload (JSONB) for
    audit. Index on (conversation_id, created_at) supports ordered
    retrieval.

All data is local — no external LLM providers. See
[[docs/security/ai-data-access]] for the full security posture.

Rollback: drop tables. No dependencies on other domain tables.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0031_ai_chat_tables'
down_revision: Union[str, Sequence[str], None] = '0030_import_pipeline_staging'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # ai_conversations — one row per chat thread
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated_at
        ON ai_conversations (updated_at DESC);
    """)

    # ------------------------------------------------------------------
    # ai_messages — ordered messages bound to a conversation
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS ai_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID NOT NULL
                REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL
                CHECK (role IN ('user', 'assistant', 'tool', 'system')),
            content TEXT,
            tool_name TEXT,
            tool_args JSONB,
            tool_result JSONB,
            status TEXT NOT NULL DEFAULT 'complete'
                CHECK (status IN ('complete', 'streaming', 'aborted', 'error')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conv_created
        ON ai_messages (conversation_id, created_at);
    """)

    # ------------------------------------------------------------------
    # updated_at trigger on ai_conversations — bumped whenever a new
    # message is inserted so the conversation list can sort by recency.
    # ------------------------------------------------------------------
    op.execute("""
        CREATE OR REPLACE FUNCTION touch_ai_conversation_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            UPDATE ai_conversations
            SET updated_at = NOW()
            WHERE id = NEW.conversation_id;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_ai_messages_touch_conversation
        ON ai_messages;
    """)

    op.execute("""
        CREATE TRIGGER trg_ai_messages_touch_conversation
        AFTER INSERT ON ai_messages
        FOR EACH ROW
        EXECUTE FUNCTION touch_ai_conversation_updated_at();
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_ai_messages_touch_conversation ON ai_messages;")
    op.execute("DROP FUNCTION IF EXISTS touch_ai_conversation_updated_at();")
    op.execute("DROP TABLE IF EXISTS ai_messages CASCADE;")
    op.execute("DROP TABLE IF EXISTS ai_conversations CASCADE;")
