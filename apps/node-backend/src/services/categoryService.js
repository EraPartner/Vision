/**
 * Category service — the route-facing seam over categoryRepository.
 *
 * Routes must not import repositories directly (eslint
 * vision-local/no-repo-direct-from-route); they go through this service, which
 * is where category name→id resolution and bulk operations belong.
 */
export { default } from '../repositories/categoryRepository.js';
