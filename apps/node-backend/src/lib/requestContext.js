import { AsyncLocalStorage } from "node:async_hooks";

/** @typedef {{ requestId: string }} RequestContext */

/** @type {AsyncLocalStorage<RequestContext>} */
const requestContext = new AsyncLocalStorage();

/**
 * Run request work inside its correlation context. Async resources created by
 * the callback retain the store without passing `req` through service layers.
 *
 * @template T
 * @param {string} requestId
 * @param {() => T} callback
 * @returns {T}
 */
export function runWithRequestContext(requestId, callback) {
  return requestContext.run({ requestId }, callback);
}

/** @returns {RequestContext|undefined} */
export function getRequestContext() {
  return requestContext.getStore();
}
