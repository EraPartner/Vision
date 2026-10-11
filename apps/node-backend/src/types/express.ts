/**
 * Shared structural Express types.
 *
 * Written while a legacy checkJs program still saw `express` as `any`, so
 * JavaScript callers could not use `@types/express` (retired by ADR-191).
 * This module centralizes narrow structural types for the
 * middleware/lib/controllers layer, where many files share the same
 * req/res/router surface, rather than repeating them per file.
 *
 * Each type below describes only the members some annotated backend file
 * actually reads or writes — not the full Express API. Extend deliberately:
 * adding a property here makes that member "typed" everywhere this module
 * is imported, whether or not it is ever really present.
 *
 * @module types/express
 */

import type { ResponseMeta as ApiResponseMeta } from "@vision/types/api";

export interface ExpressRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Node wire headers, before duplicate-field normalization. */
  rawHeaders?: string[];
  /** Request id stamped by middleware/requestId.ts. */
  id?: string;
  method: string;
  path: string;
  baseUrl: string;
  originalUrl: string;
  url: string;
  route?: { path?: string };
  /** Deprecated Node alias for `socket`; still read defensively. */
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  ip?: string;
  get: (name: string) => string | undefined;
  /** Attached by multer's `.single(...)`. `buffer` is populated only under multer's memoryStorage (routes/attachments.js); `path`/`filename` only under diskStorage (routes/importRoutes.js, portfolioImportRoutes.js) — the two configurations are mutually exclusive per route, never both populated on the same request. */
  file?: {
    path?: string;
    filename?: string;
    originalname?: string;
    mimetype?: string;
    size?: number;
    buffer?: Buffer;
  };
  cookies?: Record<string, string>;
}

/** A body chunk for `write`/`end`. */
export type ResponseChunk = string | Uint8Array;
/** Completion callback for `write`/`end`. */
export type ResponseCallback = (error?: Error | null) => void;

export interface ExpressResponse {
  json: (body?: unknown) => ExpressResponse;
  status: (code: number) => ExpressResponse;
  send: (body?: unknown) => ExpressResponse;
  setHeader: (name: string, value: string | number) => void;
  /** Express's `res.set` — an alias for `setHeader` that returns `this` for chaining. */
  set?: (name: string, value: string | number) => ExpressResponse;
  // Method syntax so Node's overloaded `on`/`once` stay assignable.
  on(event: string, listener: (...args: unknown[]) => void): void;
  once?(event: string, listener: (...args: unknown[]) => void): void;
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  /** Node's `http.ServerResponse#write` (overloaded `(chunk, cb?) | (chunk, encoding, cb?)` upstream — loosely typed to cover both). Used by the streaming CSV/NDJSON export pipeline (services/transactionExport.ts) and, reassigned wholesale, by middleware/compression.ts's gzip wrapper. */
  // Method syntax so Node's overloaded `write`/`end` stay assignable.
  write(
    chunk: ResponseChunk,
    encoding?: BufferEncoding | ResponseCallback,
    cb?: ResponseCallback,
  ): boolean;
  /** Same overload shape as `write` above; middleware/compression.ts's gzip wrapper reassigns this too. */
  end(
    chunk?: ResponseChunk | ResponseCallback,
    encoding?: BufferEncoding | ResponseCallback,
    cb?: ResponseCallback,
  ): ExpressResponse | void;
  /** Express's `res.sendFile`, used by routes/attachments.js's download endpoint. */
  sendFile?: (path: string, callback?: (err?: Error) => void) => void;
  /** Node's `http.ServerResponse#writeHead`, used by middleware/cors.ts's CORS preflight short-circuit. */
  writeHead?: (statusCode: number) => ExpressResponse;
  getHeader?: (name: string) => number | string | string[] | undefined;
  removeHeader?: (name: string) => void;
  /** Express's `res.type`, used by main.ts's SPA fallback. */
  type?: (contentType: string) => ExpressResponse;
  /** Node's `EventEmitter#emit` (`ExpressResponse` is a `http.ServerResponse`, which is one) — used by middleware/compression.ts's gzip wrapper to re-surface `gz`'s `'drain'` event on `res`. */
  emit?: (event: string, ...args: unknown[]) => boolean;
  destroy?: (err?: Error) => void;
  /** Attached by middleware/envelope.ts's `wrapResponse`. */
  ok?: (data: unknown, meta?: ResponseMeta) => ExpressResponse;
  locals?: Record<string, unknown>;
}

/**
 * Envelope metadata as declared by the shared package. Route-specific facts
 * live beside `requestId` at the top level; pagination stays in the data body.
 */
export type ResponseMeta = ApiResponseMeta;

export type ExpressNextFunction = (err?: unknown) => void;

export type ExpressHandler = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNextFunction,
) => unknown;

export interface ExpressRouter {
  get: (path: string, ...handlers: ExpressHandler[]) => ExpressRouter;
  post: (path: string, ...handlers: ExpressHandler[]) => ExpressRouter;
  patch: (path: string, ...handlers: ExpressHandler[]) => ExpressRouter;
  put: (path: string, ...handlers: ExpressHandler[]) => ExpressRouter;
  delete: (path: string, ...handlers: ExpressHandler[]) => ExpressRouter;
  use: (...handlers: ExpressHandler[]) => ExpressRouter;
}
