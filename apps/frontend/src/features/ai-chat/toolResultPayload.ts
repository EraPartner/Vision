import { isRecord } from "@/lib/isRecord";
import type { ToolResultPayload } from "@/types/aiChat";

/**
 * `ai_messages.tool_result` is JSONB, so the wire type is `unknown`. The
 * backend stores the `{ ok, data?, meta?, error? }` tool envelope; anything
 * else (NULL, a bare scalar, an array, an object without a boolean `ok`) is
 * not renderable as a tool card.
 */
export function isToolResultPayload(
    value: unknown,
): value is ToolResultPayload {
    return isRecord(value) && typeof value.ok === "boolean";
}
