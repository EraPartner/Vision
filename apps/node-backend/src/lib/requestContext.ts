import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = { requestId: string };

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run request work inside its correlation context. Async resources created by
 * the callback retain the store without passing `req` through service layers.
 */
export function runWithRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContext.run({ requestId }, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
