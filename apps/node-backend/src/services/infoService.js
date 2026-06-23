/**
 * Info/statistics service — the route-facing seam over infoRepository, used by
 * the /api/info routes (info.js, info/statistics.js, info/netWorth.js) instead
 * of importing the repository directly (eslint vision-local/no-repo-direct-from-route).
 */
export { default } from '../repositories/infoRepository.js';
