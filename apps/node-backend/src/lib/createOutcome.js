/**
 * Add the explicit create-or-get outcome to an API resource payload.
 *
 * @param {Record<string, unknown>} resource
 * @param {boolean} created
 * @param {Record<string, unknown>} [extra]
 */
export function withCreateOutcome(resource, created, extra = {}) {
  return { ...resource, ...extra, created: Boolean(created), links: [] };
}
