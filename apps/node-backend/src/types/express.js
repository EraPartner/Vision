/**
 * Shared structural Express types.
 *
 * `express` ships no type declarations and `@types/express` is not a
 * workspace dependency, so referencing its types in TYPE position
 * (`import('express').Request`) resolves to an implicit `any` (TS7016)
 * under `noImplicitAny` — same reasoning as `ExpressResponse` in
 * services/transactionExport.js and services/reports/index.js, and
 * `ExpressApp`/`ExpressLayer` in services/routeManifest.js. Those files each
 * defined a narrow local structural type; this module centralizes the
 * equivalent for the middleware/lib/controllers layer, where many files share
 * the same req/res/router surface, rather than repeating it per file.
 *
 * Each typedef below describes only the members some annotated backend file
 * actually reads or writes — not the full Express API. Extend deliberately:
 * adding a `@property` here makes that member "typed" everywhere this module
 * is imported, whether or not it is ever really present.
 *
 * @module types/express
 */

/**
 * @typedef {object} ExpressRequest
 * @property {Record<string, string>} params
 * @property {Record<string, any>} query
 * @property {any} body
 * @property {Record<string, string|string[]|undefined>} headers
 * @property {string} [id] Request id stamped by middleware/requestId.js.
 * @property {string} method
 * @property {string} path
 * @property {string} baseUrl
 * @property {string} originalUrl
 * @property {string} url
 * @property {{ path?: string }} [route]
 * @property {{ remoteAddress?: string }} [connection] Deprecated Node alias for `socket`; still read defensively.
 * @property {{ remoteAddress?: string }} [socket]
 * @property {string} [ip]
 * @property {(name: string) => string|undefined} get
 * @property {{ path?: string, filename?: string, originalname?: string, mimetype?: string, size?: number }} [file] Attached by multer's `.single(...)`.
 * @property {Record<string, string>} [cookies]
 */

/**
 * @typedef {object} ExpressResponse
 * @property {(body?: any) => ExpressResponse} json
 * @property {(code: number) => ExpressResponse} status
 * @property {(body?: any) => ExpressResponse} send
 * @property {(name: string, value: string|number) => void} setHeader
 * @property {(name: string, value: string|number) => ExpressResponse} [set] Express's `res.set` — an alias for `setHeader` that returns `this` for chaining.
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 * @property {(event: string, listener: (...args: any[]) => void) => void} [once]
 * @property {number} statusCode
 * @property {boolean} headersSent
 * @property {boolean} writableEnded
 * @property {(chunk?: any) => boolean} write Node's `http.ServerResponse#write`, used by the streaming CSV/NDJSON export pipeline (services/transactionExport.js).
 * @property {(chunk?: any) => void} end
 * @property {(data: any, meta?: ResponseMetaLoose) => ExpressResponse} [ok] Attached by middleware/envelope.js's `wrapResponse`.
 * @property {Record<string, any>} [locals]
 */

/**
 * `meta` as `res.ok(data, meta)` callers actually pass it, not as
 * `@vision/types/api`'s `ResponseMeta` declares it. `wrapResponse` (see
 * middleware/envelope.js) spreads whatever object `meta` is onto the response
 * body directly (`{ requestId, ...meta }`) — there is no runtime nesting under
 * `extra`. `ResponseMeta` documents `requestId`/`extra` as the ONLY sanctioned
 * members and says arbitrary facts belong under `extra`, but existing call
 * sites (e.g. routes/research.js's `provider`/`source` provenance meta)
 * predate that convention and pass extra top-level keys straight through — a
 * real drift between the documented contract and actual usage, left as-is
 * here (zero behavior change) rather than silently "fixed" by a type change.
 * A bare `ResponseMeta` reference also trips TS's weak-type check (TS2559) at
 * every one of those call sites, since such a literal shares no property with
 * `{requestId?, extra?}` — the `Record<string, any>` intersection below both
 * documents reality and satisfies the checker.
 * @typedef {import('@vision/types/api').ResponseMeta & Record<string, any>} ResponseMetaLoose
 */

/**
 * @typedef {(err?: unknown) => void} ExpressNextFunction
 */

/**
 * @typedef {(req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => any} ExpressHandler
 */

/**
 * @typedef {object} ExpressRouter
 * @property {(path: string, ...handlers: ExpressHandler[]) => ExpressRouter} get
 * @property {(path: string, ...handlers: ExpressHandler[]) => ExpressRouter} post
 * @property {(path: string, ...handlers: ExpressHandler[]) => ExpressRouter} patch
 * @property {(path: string, ...handlers: ExpressHandler[]) => ExpressRouter} put
 * @property {(path: string, ...handlers: ExpressHandler[]) => ExpressRouter} delete
 * @property {(...handlers: ExpressHandler[]) => ExpressRouter} use
 */

export {};
