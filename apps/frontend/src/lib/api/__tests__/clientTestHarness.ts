import { HttpResponse } from "msw";

export const API_BASE = "http://localhost:3002";

/** ADR-026 success envelope used by API client contract tests. */
export function ok<T>(data: T, init?: ResponseInit) {
  return HttpResponse.json({ ok: true, data }, init);
}
