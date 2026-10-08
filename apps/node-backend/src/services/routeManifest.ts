/**
 * Route Manifest
 *
 * Scans the Express router stack after all routes are registered and stores
 * a flat list of { method, path } entries.  Consumed by GET /api/admin/endpoints.
 */

/**
 * The slice of an Express `Layer` this module actually reads. Deliberately
 * structural rather than `import('express').Layer`: express ships no type
 * declarations and `@types/express` is not a dependency, so referencing its
 * types resolves to an implicit `any` (TS7016) under `noImplicitAny` — same
 * reasoning as `QueryRunner` in types/rows.ts for `pg`.
 */
export interface ExpressLayer {
  regexp?: { source?: string };
  _mountPath?: string;
  /** `methods` exists at runtime on Express's `Route` but is not declared by `@types/express`. */
  route?: { path: string, methods?: Record<string, boolean> };
  /** A middleware function; mounted routers also carry `stack` (and `_mountPath` from mountRouter). */
  handle?: ((...args: never[]) => unknown) & { stack?: ExpressLayer[], _mountPath?: string };
}

/** The slice of an Express `Application` this module actually reads/calls. */
export interface ExpressApp {
  router?: { stack?: ExpressLayer[] };
  _router?: { stack?: ExpressLayer[] };
  use: (path: string, ...fns: any[]) => void;
}

/**
 * A router or middleware function handed to `mountRouter`; only routers
 * carry `stack`.
 */
export type MountableHandler = ((...args: never[]) => unknown) & {
  stack?: unknown;
  _mountPath?: string;
};

export interface RouteManifestEntry {
  method: string;
  path: string;
}

let manifest: RouteManifestEntry[] = [];

/**
 * Extract the path prefix that an Express layer was mounted at.
 * Express converts the mount path into a regexp with source like:
 *   ^\/api\/transactions\/?(?=\/|$)
 * We strip the ^ prefix and the \/?(?=\/|$) suffix, then unescape \/ → /.
 */
function extractPrefix(layer: ExpressLayer): string | null {
  const source = layer.regexp?.source ?? '';
  if (!source.startsWith('^')) return null;

  const stripped = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)\s*$/, '');

  if (!stripped || stripped === '\\/' ) return '/';
  return stripped.replace(/\\\//g, '/');
}

/** Recursively scan a Layer array and collect route definitions. */
function scanStack(stack: ExpressLayer[], prefix: string): RouteManifestEntry[] {
  const routes: RouteManifestEntry[] = [];

  for (const layer of stack) {
    const route = layer.route;
    if (route) {
      const routePath = route.path === '/' && prefix ? '' : route.path;
      const fullPath = prefix + routePath || '/';
      const routeMethods = route.methods ?? {};
      const methods = Object.keys(routeMethods)
        .filter((m) => routeMethods[m] && m !== '_all')
        .map((m) => m.toUpperCase());
      for (const method of methods) {
        routes.push({ method, path: fullPath });
      }
    } else if (layer.handle?.stack) {
      const routePrefix = layer.handle._mountPath ?? extractPrefix(layer) ?? prefix;
      routes.push(...scanStack(layer.handle.stack, routePrefix));
    }
  }

  return routes;
}

/**
 * Scan the Express app's router stack and store the manifest.
 * Call once after all routes are registered in main.ts.
 */
export function buildRouteManifest(app: ExpressApp) {
  const router = app.router ?? app._router;
  manifest = scanStack(router?.stack ?? [], '');
}

/**
 * Mount a router at a path and tag it with _mountPath so scanStack can resolve
 * the prefix in Express v5 (which no longer exposes layer.regexp).
 */
export function mountRouter(
  app: ExpressApp,
  path: string,
  ...fns: MountableHandler[]
) {
  for (const fn of fns) {
    if (fn?.stack) fn._mountPath = path;
  }
  app.use(path, ...fns);
}

/** Return the stored route manifest. */
export function getRouteManifest(): RouteManifestEntry[] {
  return manifest;
}
