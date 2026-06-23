/**
 * Transaction service — the route-facing seam over transactionRepository.
 * Routes delegate here instead of importing the repository directly
 * (eslint vision-local/no-repo-direct-from-route).
 */
export { default } from '../repositories/transactionRepository.js';
