/**
 * @deprecated Legacy entrypoint. Source of truth lives in
 * `services/importPipeline/adapters/`. This shim keeps existing callers
 * working while Phase 7 rollout completes.
 */
export {
  createAdapter,
  getSupportedBanks,
  detectBank,
  getAdapter,
} from './importPipeline/adapters/index.js';
