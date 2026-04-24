/**
 * Route Manifest
 *
 * Scans the Express router stack after all routes are registered and stores
 * a flat list of { method, path } entries.  Consumed by GET /api/admin/endpoints.
 */

/** @type {{ method: string, path: string }[]} */
let manifest = [];

/**
 * Extract the path prefix that an Express layer was mounted at.
 * Express converts the mount path into a regexp with source like:
 *   ^\/api\/transactions\/?(?=\/|$)
 * We strip the ^ prefix and the \/?(?=\/|$) suffix, then unescape \/ → /.
 * @param {import('express').IRouterMatcher} layer
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
 * @param {any[]} stack
 * @param {string} prefix
 * @returns {{ method: string, path: string }[]}
 */
function scanStack(stack, prefix) {
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
      const routePrefix = extractPrefix(layer) ?? prefix;
      routes.push(...scanStack(layer.handle.stack, routePrefix));
    }
  }

  return routes;
}

/**
 * Scan the Express app's router stack and store the manifest.
 * Call once after all routes are registered in main.js.
 * @param {import('express').Application} app
 */
export function buildRouteManifest(app) {
  manifest = scanStack(app._router?.stack ?? [], '');
}

/**
 * Return the stored route manifest.
 * @returns {{ method: string, path: string }[]}
 */
export function getRouteManifest() {
  return manifest;
}
