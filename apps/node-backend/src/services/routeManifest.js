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
 * reasoning as `QueryRunner` in types/rows.js for `pg`.
 *
 * @typedef {object} ExpressLayer
 * @property {{ source?: string }} [regexp]
 * @property {string} [_mountPath]
 * @property {{ path: string, methods: Record<string, boolean> }} [route]
 * @property {{ stack?: ExpressLayer[], _mountPath?: string }} [handle]
 */

/**
 * The slice of an Express `Application` this module actually reads/calls.
 * @typedef {object} ExpressApp
 * @property {{ stack?: ExpressLayer[] }} [router]
 * @property {{ stack?: ExpressLayer[] }} [_router]
 * @property {(path: string, ...fns: any[]) => void} use
 */

/** @type {{ method: string, path: string }[]} */
let manifest = [];

/**
 * Extract the path prefix that an Express layer was mounted at.
 * Express converts the mount path into a regexp with source like:
 *   ^\/api\/transactions\/?(?=\/|$)
 * We strip the ^ prefix and the \/?(?=\/|$) suffix, then unescape \/ → /.
 * @param {ExpressLayer} layer
 * @returns {string|null}
 */
function extractPrefix(layer) {
  const source = layer.regexp?.source ?? '';
  if (!source.startsWith('^')) return null;

  const stripped = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)\s*$/, '');

  if (!stripped || stripped === '\\/' ) return '/';
  return stripped.replace(/\\\//g, '/');
}

/**
 * Recursively scan a Layer array and collect route definitions.
 * @param {ExpressLayer[]} stack
 * @param {string} prefix
 * @returns {{ method: string, path: string }[]}
 */
function scanStack(stack, prefix) {
  /** @type {{ method: string, path: string }[]} */
  const routes = [];

  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path === '/' && prefix ? '' : layer.route.path;
      const fullPath = prefix + routePath || '/';
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m] && m !== '_all')
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
 * Call once after all routes are registered in main.js.
 * @param {ExpressApp} app
 */
export function buildRouteManifest(app) {
  const router = app.router ?? app._router;
  manifest = scanStack(router?.stack ?? [], '');
}

/**
 * Mount a router at a path and tag it with _mountPath so scanStack can resolve
 * the prefix in Express v5 (which no longer exposes layer.regexp).
 * @param {ExpressApp} app
 * @param {string} path
 * @param {...any} fns
 */
export function mountRouter(app, path, ...fns) {
  for (const fn of fns) {
    if (fn?.stack) fn._mountPath = path;
  }
  app.use(path, ...fns);
}

/**
 * Return the stored route manifest.
 * @returns {{ method: string, path: string }[]}
 */
export function getRouteManifest() {
  return manifest;
}
