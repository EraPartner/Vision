/**
 * Request-scoped memoization for AI-chat tools.
 *
 * A single chat turn frequently invokes several portfolio/tax tools that each
 * independently fetch the same heavy investment + transaction sets. The chat
 * service creates one cache per turn and threads it through the tool context;
 * tools wrap their repository reads in `memoizeAsync` so identical fetches
 * within the turn hit the database once.
 *
 * When `cache` is absent (a standalone tool call, or unit tests that invoke
 * `tool.run` directly) the factory runs immediately — behaviour is identical,
 * just without cross-call deduplication.
 *
 * The cached value is the factory's promise, so concurrent callers share one
 * in-flight query rather than racing duplicates.
 */
export function memoizeAsync(cache, key, factory) {
  if (!cache) return factory();
  if (!cache.has(key)) cache.set(key, factory());
  return cache.get(key);
}
