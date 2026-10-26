import path from "node:path";

/**
 * True when the module is the process entry point. Bun and Node >= 24.2 set
 * `import.meta.main`; older Node leaves it undefined, so fall back to argv[1]
 * rather than silently skipping the script's checks.
 */
export function isEntrypoint(meta: ImportMeta): boolean {
  const main: unknown = meta.main;
  if (main === true) return true;
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === meta.filename;
}
