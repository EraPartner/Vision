/**
 * Attachment record service — the route-facing seam over the attachment
 * repository's DB-row API (eslint vision-local/no-repo-direct-from-route).
 * Distinct from attachmentService.js, which owns file storage/streaming.
 */
export { attachmentRepository } from '../repositories/attachmentRepository.js';
