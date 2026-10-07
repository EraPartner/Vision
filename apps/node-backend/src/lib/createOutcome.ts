/**
 * Add the explicit create-or-get outcome to an API resource payload.
 */
export function withCreateOutcome(
  resource: Record<string, unknown>,
  created: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { created: boolean; links: unknown[] } {
  return { ...resource, ...extra, created: Boolean(created), links: [] };
}
