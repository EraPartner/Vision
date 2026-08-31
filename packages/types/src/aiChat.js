/** Canonical Server-Sent Event names for the AI chat stream. */
export const AI_CHAT_STREAM_EVENT = Object.freeze({
  USER_MESSAGE: "user_message",
  TOKEN: "token",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  COMPLETE: "complete",
  /** @deprecated Compatibility alias for AI clients predating the shared terminal event name. */
  DONE: "done",
  ERROR: "error",
});

export const AI_CHAT_STREAM_EVENT_NAMES = Object.freeze(
  Object.values(AI_CHAT_STREAM_EVENT),
);
