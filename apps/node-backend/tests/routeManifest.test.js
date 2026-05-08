import { beforeEach, describe, expect, it } from 'vitest';
import { buildRouteManifest, getRouteManifest, mountRouter } from '../src/services/routeManifest.js';

function makeRouteLayer(path, methods) {
  const methodMap = {};
  for (const m of methods) methodMap[m.toLowerCase()] = true;
  return { route: { path, methods: methodMap } };
}

function makeRouterLayer(prefix, stack, { useMountTag = true } = {}) {
  const handle = { stack };
  if (useMountTag) handle._mountPath = prefix;
  // emulate a regexp from older Express versions for the fallback path.
  // express 4 source: ^\/api\/foo\/?(?=\/|$)
  const escaped = prefix.replace(/\//g, '\\/');
  return {
    handle,
    regexp: { source: `^${escaped}\\/?(?=\\/|$)` },
  };
}

function makeApp(rootStack) {
  return { router: { stack: rootStack } };
}

describe('routeManifest.buildRouteManifest', () => {
  beforeEach(() => buildRouteManifest({ router: { stack: [] } }));

  it('starts with an empty manifest before scanning', () => {
    expect(getRouteManifest()).toEqual([]);
  });

  it('captures simple GET route at root', () => {
    const stack = [makeRouteLayer('/health', ['get'])];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/health' }]);
  });

  it('expands routes with multiple methods into separate entries', () => {
    const stack = [makeRouteLayer('/items', ['get', 'post', 'delete'])];
    buildRouteManifest(makeApp(stack));
    const manifest = getRouteManifest();
    expect(manifest).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/items' },
        { method: 'POST', path: '/items' },
        { method: 'DELETE', path: '/items' },
      ]),
    );
    expect(manifest).toHaveLength(3);
  });

  it('skips the synthetic _all method emitted by Express for app.all()', () => {
    const stack = [
      { route: { path: '/wild', methods: { get: true, _all: true } } },
    ];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/wild' }]);
  });

  it('combines mounted router prefix with child route path', () => {
    const child = [makeRouteLayer('/list', ['get'])];
    const stack = [makeRouterLayer('/api/items', child)];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/api/items/list' }]);
  });

  it('falls back to extracting prefix from layer.regexp when _mountPath missing (Express v4 path)', () => {
    const child = [makeRouteLayer('/list', ['get'])];
    const stack = [makeRouterLayer('/api/items', child, { useMountTag: false })];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/api/items/list' }]);
  });

  it('uses the innermost _mountPath tag when routers are nested (current behavior)', () => {
    // mountRouter() tags each router with its own mount path. scanStack
    // delegates to the tag and does not combine parent + child prefixes,
    // so nested mountRouter usage flattens to the inner tag.
    const leaf = [makeRouteLayer('/me', ['get'])];
    const inner = [makeRouterLayer('/users', leaf)];
    const stack = [makeRouterLayer('/api/v1', inner)];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/users/me' }]);
  });

  it('falls back to app._router when app.router is missing', () => {
    const stack = [makeRouteLayer('/legacy', ['get'])];
    buildRouteManifest({ _router: { stack } });
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/legacy' }]);
  });

  it('treats child path "/" with prefix as the prefix itself', () => {
    const child = [makeRouteLayer('/', ['get'])];
    const stack = [makeRouterLayer('/api/health', child)];
    buildRouteManifest(makeApp(stack));
    expect(getRouteManifest()).toEqual([{ method: 'GET', path: '/api/health' }]);
  });

  it('returns empty manifest when neither router nor _router exists', () => {
    buildRouteManifest({});
    expect(getRouteManifest()).toEqual([]);
  });
});

describe('routeManifest.mountRouter', () => {
  it('tags each router fn with _mountPath', () => {
    const r1 = { stack: [] };
    const r2 = { stack: [] };
    const calls = [];
    const app = {
      use: (...args) => calls.push(args),
    };

    mountRouter(app, '/api/things', r1, r2);

    expect(r1._mountPath).toBe('/api/things');
    expect(r2._mountPath).toBe('/api/things');
    expect(calls).toEqual([['/api/things', r1, r2]]);
  });

  it('skips fns without a stack (e.g. middleware functions)', () => {
    const middleware = () => {};
    const router = { stack: [] };
    const app = { use: () => {} };

    mountRouter(app, '/x', middleware, router);

    expect(router._mountPath).toBe('/x');
    expect(middleware._mountPath).toBeUndefined();
  });
});
