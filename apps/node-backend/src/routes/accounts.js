/**
 * Account routes (ADR-088).
 *
 * GET    /api/accounts        — list (filter by ?active=true|false|all, default true)
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
import { mergeAccounts } from '../services/accountMergeService.js';
import { setOpeningBalance } from '../services/openingBalanceService.js';
import { reconcileAccount } from '../services/reconcileService.js';
import { scheduleAggregationRefresh } from '../services/aggregationRefresh.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

router.get('/', async (req, res) => {
  const { active = 'true' } = req.query;
  const activeFilter = active === 'all' ? null : active !== 'false';
  const accounts = await accountService.list({ active: activeFilter });
  res.ok({ items: accounts, total: accounts.length, links: [] });
});

router.get('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const account = await accountService.get(id);
  res.ok({ ...account, links: [] });
});

router.post('/', async (req, res) => {
  const account = await accountService.create(req.body);
  res.status(201);
  res.ok({ ...account, links: [] });
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await accountService.update(id, req.body);
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await accountService.remove(id);
  res.ok({ message: `Account ${id} deleted`, links: [] });
});

// Merge one or more source accounts into this (survivor) account: all references repoint to :id
// and the sources are deleted (ADR-088). Body: { source_ids: number[] }.
router.post('/:id/merge', validateIdParam, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const sourceIds = Array.isArray(req.body?.source_ids)
    ? req.body.source_ids.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n))
    : [];
  const result = await mergeAccounts(targetId, sourceIds);
  res.ok({ ...result, links: [] });
});

// Set (create or update) the opening-balance anchor for a manual/cash-only
// account (ADR-094 second addendum, D4). Body: { balance, date, currency? }.
// The single sanctioned exception to the balance write-protection: it stamps one
// system anchor row (amount=0, transfer_source='opening') per account+currency.
router.post('/:id/opening-balance', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await setOpeningBalance(id, req.body);
  // The anchor row feeds mv_bank_balances + the forecast MC caches; refresh them
  // like every transaction mutation route does, else dashboards serve stale
  // figures until the next unrelated mutation or cache expiry.
  scheduleAggregationRefresh();
  res.ok({ ...result, links: [] });
});

// Resolve an account's drift (statement_balance − computed_balance) from the
// reconcile dialog (ADR-094, Phase C). Body: { mode: 'accept' | 'adjustment' }.
// 'accept' rewrites the stored statement figures to the computed balance;
// 'adjustment' stamps one server-side 'adjustment' ledger row so the computed
// balance rises to meet the statement (balance-free — descriptive-only preserved).
router.post('/:id/reconcile', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await reconcileAccount(id, req.body);
  // 'accept' rewrites the statement figure and 'adjustment' inserts a ledger row;
  // both change mv_bank_balances + forecast caches, so refresh like the mutation
  // routes rather than serving a stale drift/balance until the next mutation.
  scheduleAggregationRefresh();
  res.ok({ ...result, links: [] });
});

export default router;
