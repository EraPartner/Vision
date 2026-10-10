import { z } from "zod";

import { WireTimestampSchema, wireListOf } from "./common.ts";

/**
 * `GET /api/ai/status` (routes/ai.ts). The health probe never throws: an
 * unreachable server is `ok: false` with `error`/`code` set.
 */
export const OllamaStatusSchema = z.looseObject({
  ok: z.boolean(),
  baseUrl: z.string(),
  displayUrl: z.string(),
  modelCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  code: z.string().nullable(),
  hint: z.string().nullable(),
  defaultModel: z.string(),
  enabled: z.boolean(),
});

/**
 * One installed model as `listModels` (integrations/ollama/client.ts) maps the
 * upstream `/api/tags` entry. The fields are copied from Ollama's own
 * response, so `name` is absent when Ollama omits it.
 */
export const OllamaModelSchema = z.looseObject({
  name: z.string().optional(),
  size: z.number().nullable(),
  family: z.string().nullable(),
  parameterSize: z.string().nullable(),
  quantization: z.string().nullable(),
  modifiedAt: z.string().nullable(),
});

/** `GET /api/ai/models`. */
export const OllamaModelListSchema = wireListOf(OllamaModelSchema);

/** An `ai_conversations` row (`aiConversationRowSchema`). */
export const AiConversationSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  model: z.string(),
  createdAt: WireTimestampSchema,
  updatedAt: WireTimestampSchema,
});

/** `GET /api/ai/conversations`: always paginated, no `links`. */
export const AiConversationPageSchema = wireListOf(AiConversationSchema).extend(
  {
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  },
);

/**
 * An `ai_messages` row (`aiMessageRowSchema`). `toolArgs`/`toolResult` are
 * JSONB (NULL on non-tool rows), so any JSON value passes.
 */
export const AiMessageSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.string().nullable(),
  toolName: z.string().nullable(),
  toolArgs: z.unknown().optional(),
  toolResult: z.unknown().optional(),
  status: z.enum(["complete", "streaming", "aborted", "error"]),
  createdAt: WireTimestampSchema,
});

/** `GET /api/ai/conversations/:id` and `POST /api/ai/conversations`. */
export const AiConversationDetailSchema = z.looseObject({
  conversation: AiConversationSchema,
  messages: z.array(AiMessageSchema),
});
