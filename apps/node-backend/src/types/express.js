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
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 * @property {number} statusCode
 * @property {boolean} headersSent
 * @property {boolean} writableEnded
 * @property {(chunk?: any) => void} end
 * @property {(data: any, meta?: import('@vision/types/api').ResponseMeta) => ExpressResponse} [ok] Attached by middleware/envelope.js's `wrapResponse`.
 * @property {Record<string, any>} [locals]
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
