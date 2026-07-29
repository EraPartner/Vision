/**
 * Account routes (ADR-088).
 *
 * GET    /api/accounts        — list (filter by ?active=true|false|all, default true;
 *                               optional ?limit/?offset — absent means the full list)
 * GET    /api/accounts/:id    — fetch one
 * POST   /api/accounts        — create
 * PATCH  /api/accounts/:id    — update (partial)
 * DELETE /api/accounts/:id    — delete (409 if still referenced; archive instead)
 *
 * Data access + orchestration live in services/accountService.js — routes never
 * touch the repository layer directly (vision-local/no-repo-direct-from-route).
 */

import { Router } from 'express';
import accountService from '../services/accountService.js';
import { mergeAccounts, previewMerge } from '../services/accountMergeService.js';
import { setOpeningBalance } from '../services/openingBalanceService.js';
import { reconcileAccount } from '../services/reconcileService.js';
import { scheduleAggregationRefresh } from '../services/aggregationRefresh.js';
import { invalidatePortfolioCaches } from '../services/info/cache.js';
import { validateIdParam } from '../middleware/validation.js';
import { ValidationError } from '../middleware/errorHandler.js';
import { listBody, parseOptionalPagination } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

// Pagination is opt-in: without limit/offset this still answers the complete
// list (the accounts hub renders all of them), so no client is truncated.
router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { active = 'true' } = req.query;
  const activeFilter = active === 'all' ? null : active !== 'false';
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const { items, total } = await accountService.list({ active: activeFilter, ...(page ?? {}) });
  res.ok({ ...listBody(items, total, page), links: [] });
});

router.get('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const account = await accountService.get(id);
  res.ok({ ...account, links: [] });
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const account = await accountService.create(req.body);
  // A new account can enter the net-worth aggregate; drop the cached response
  // so the next read recomputes (invalidatePortfolioCaches also clears the
  // bank-balances cache — shared seam).
  invalidatePortfolioCaches();
  res.status(201);
  res.ok({ ...account, links: [] });
});

router.patch('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await accountService.update(id, req.body);
  // rename / in_net_worth / is_active / statement_balance all shift the
  // net-worth + bank-balances response caches; bust them (shared seam).
  invalidatePortfolioCaches();
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await accountService.remove(id);
  invalidatePortfolioCaches();
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

// Read-only preview of merging THIS account (:id, the source) INTO ?into=<targetId>
// (the survivor): row counts that would move, the projected post-merge computed
// balance (anchor+delta over the union of both accounts' active rows, in the
// survivor's native currency), and whether the merge would interleave stamped
// balance histories (§1 F2 — the guard that clears the survivor's statement
// anchor). No mutation, so no cache invalidation.
router.get('/:id/merge-preview', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const sourceId = parseInt(req.params.id, 10);
  // previewMerge validates the coerced value (positive integer, ≠ :id → 400).
  const targetId = Number(req.query.into);
  const result = await previewMerge(sourceId, targetId);
  res.ok({ ...result, links: [] });
});

// Merge one or more source accounts into this (survivor) account: all references repoint to :id
// and the sources are deleted (ADR-088). Body: { source_ids: number[] }.
//
// All-or-nothing, like the transactions.js bulk endpoints: a non-integer entry
// used to be silently dropped and the remaining sources merged anyway (an
// irreversible write the client never asked for), so the whole request is now
// rejected with a 400 naming the offending entries. Accepted values still go
// through parseInt, so a valid body merges exactly what it did before.
router.post('/:id/merge', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const rawSourceIds = Array.isArray(req.body?.source_ids) ? req.body.source_ids : [];
  const sourceIds = rawSourceIds.map((/** @type {any} */ x) => parseInt(x, 10));
  /** @type {string[]} */
  const rejected = [];
  sourceIds.forEach((/** @type {number} */ id, /** @type {number} */ index) => {
    if (!Number.isInteger(id)) rejected.push(`source_ids[${index}] (${JSON.stringify(rawSourceIds[index])})`);
  });
  if (rejected.length > 0) {
    throw new ValidationError(`source_ids must contain only integers, no accounts were merged: ${rejected.join('; ')}`);
  }
  const result = await mergeAccounts(targetId, sourceIds);
  // Merge deletes the source accounts and repoints their references, changing
  // the net-worth + bank-balances aggregates; bust the caches (shared seam).
  invalidatePortfolioCaches();
  res.ok({ ...result, links: [] });
});

// Set (create or update) the opening-balance anchor for a manual/cash-only
// account (ADR-094 second addendum, D4). Body: { balance, date, currency? }.
// The single sanctioned exception to the balance write-protection: it stamps one
// system anchor row (amount=0, transfer_source='opening') per account+currency.
router.post('/:id/opening-balance', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await setOpeningBalance(id, req.body);
  // The anchor row feeds the aggregation MVs + the forecast MC caches; refresh
  // them like every transaction mutation route does, else dashboards serve stale
  // figures until the next unrelated mutation or cache expiry.
  scheduleAggregationRefresh();
  // Also drop the net-worth + bank-balances response caches (shared seam) so the
  // new anchored balance is not masked by a stale cached response.
  invalidatePortfolioCaches();
  res.ok({ ...result, links: [] });
});

// Resolve an account's drift (statement_balance − computed_balance) from the
// reconcile dialog (ADR-094, Phase C). Body: { mode: 'accept' | 'adjustment' }.
// 'accept' rewrites the stored statement figures to the computed balance;
// 'adjustment' stamps one server-side 'adjustment' ledger row so the computed
// balance rises to meet the statement (balance-free — descriptive-only preserved).
router.post('/:id/reconcile', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await reconcileAccount(id, req.body);
  // 'accept' rewrites the statement figure and 'adjustment' inserts a ledger row;
  // both change the aggregation MVs + forecast caches, so refresh like the mutation
  // routes rather than serving a stale drift/balance until the next mutation.
  scheduleAggregationRefresh();
  // Same reasoning applies to the net-worth + bank-balances response caches
  // (shared seam) — clear them so the reconciled balance surfaces immediately.
  invalidatePortfolioCaches();
  res.ok({ ...result, links: [] });
});

export default router;
