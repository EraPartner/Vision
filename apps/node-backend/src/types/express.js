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
 * @property {{ path?: string, filename?: string, originalname?: string, mimetype?: string, size?: number, buffer?: Buffer }} [file] Attached by multer's `.single(...)`. `buffer` is populated only under multer's memoryStorage (routes/attachments.js); `path`/`filename` only under diskStorage (routes/importRoutes.js, portfolioImportRoutes.js) — the two configurations are mutually exclusive per route, never both populated on the same request.
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
 * @property {(chunk?: any, encoding?: any, cb?: any) => boolean} write Node's `http.ServerResponse#write` (overloaded `(chunk, cb?) | (chunk, encoding, cb?)` upstream — loosely typed to cover both). Used by the streaming CSV/NDJSON export pipeline (services/transactionExport.js) and, reassigned wholesale, by main.js's gzip wrapper.
 * @property {(chunk?: any, encoding?: any, cb?: any) => ExpressResponse|void} end Same overload shape as `write` above; main.js's gzip wrapper reassigns this too.
 * @property {(path: string, callback?: (err: any) => void) => void} [sendFile] Express's `res.sendFile`, used by routes/attachments.js's download endpoint.
 * @property {(statusCode: number) => ExpressResponse} [writeHead] Node's `http.ServerResponse#writeHead`, used by main.js's CORS preflight short-circuit.
 * @property {(name: string) => any} [getHeader]
 * @property {(name: string) => void} [removeHeader]
 * @property {(contentType: string) => ExpressResponse} [type] Express's `res.type`, used by main.js's SPA fallback.
 * @property {(event: string, ...args: any[]) => boolean} [emit] Node's `EventEmitter#emit` (`ExpressResponse` is a `http.ServerResponse`, which is one) — used by main.js's gzip wrapper to re-surface `gz`'s `'drain'` event on `res`.
 * @property {(err?: Error) => void} [destroy]
 * @property {(data: any, meta?: ResponseMeta) => ExpressResponse} [ok] Attached by middleware/envelope.js's `wrapResponse`.
 * @property {Record<string, any>} [locals]
 */

/**
 * Envelope metadata as declared by the shared package. Route-specific facts
 * live beside `requestId` at the top level; pagination stays in the data body.
 * @typedef {import('@vision/types/api').ResponseMeta} ResponseMeta
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
