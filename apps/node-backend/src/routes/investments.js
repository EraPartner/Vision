/**
 * Investment routes — thin router.
 * All business logic lives in controllers/investmentController.js.
 */

import { Router } from 'express';
import { validateIdParam } from '../middleware/validation.js';
import {
  listInvestments,
  createInvestment,
  listProviders,
  refreshPrices,
  getBulkTransactions,
  getPriceHistory,
  getInvestment,
  updateInvestment,
  deleteInvestment,
  listTransactions,
  createTransaction,
  deleteTransaction,
  updateTransaction,
  getInvestmentSummary,
  moveHolding,
} from '../controllers/investmentController.js';

const router = Router();

// Investments
router.get('/',               listInvestments);
router.post('/',              createInvestment);
router.get('/providers',      listProviders);
router.post('/refresh-prices', refreshPrices);
router.get('/transactions',   getBulkTransactions);

// Investments — by ID (validateIdParam must come before the handler)
router.get('/:id/price-history', validateIdParam, getPriceHistory);
router.get('/:id/transactions',  validateIdParam, listTransactions);
router.post('/:id/transactions', validateIdParam, createTransaction);
router.post('/:id/move',         validateIdParam, moveHolding);
router.get('/:id/summary',       validateIdParam, getInvestmentSummary);
router.get('/:id',               validateIdParam, getInvestment);
router.patch('/:id',             validateIdParam, updateInvestment);
router.delete('/:id',            validateIdParam, deleteInvestment);

// Portfolio transactions (no investment ID in path)
router.delete('/transactions/:txnId', deleteTransaction);
router.patch('/transactions/:txnId',  updateTransaction);

export default router;
