/**
 * Investment routes.
 */

import { Router } from 'express';
import investmentRepository from '../repositories/investmentRepository.js';
import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import { fetchLivePrices, SUPPORTED_PROVIDERS } from '../services/priceProviderService.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

// GET /api/investments
router.get('/', async (req, res) => {
  try {
    const { limit = 200, offset = 0, asset_class, active = 'true' } = req.query;
    const opts = {
      limit: Math.min(parseInt(limit, 10) || 200, 1000),
      offset: parseInt(offset, 10) || 0,
      assetClass: asset_class || null,
      active: active !== 'false',
    };
    const [items, total] = await Promise.all([
      investmentRepository.getAll(opts),
      investmentRepository.getCount(opts),
    ]);
    res.json({ items, total, limit: opts.limit, offset: opts.offset, links: [] });
  } catch (err) {
    logger.error('Failed to get investments', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investments' });
  }
});

// POST /api/investments
router.post('/', async (req, res) => {
  try {
    const { name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url } = req.body;
    if (!name || !asset_class) return res.status(400).json({ detail: 'name and asset_class are required' });
    const inv = await investmentRepository.create({ name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, price_provider, price_provider_id, price_provider_url });
    res.status(201).json(inv);
  } catch (err) {
    logger.error('Failed to create investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to create investment' });
  }
});


// GET /api/investments/providers (must be before /:id)
router.get('/providers', (req, res) => {
  res.json({ providers: SUPPORTED_PROVIDERS });
});

// POST /api/investments/refresh-prices (must be before /:id)
router.post('/refresh-prices', async (req, res) => {
  try {
    const allInvestments = await investmentRepository.getAll({ limit: 1000, active: true });
    const toRefresh = allInvestments.filter(i => i.price_provider && i.price_provider !== 'manual' && i.price_provider_id);

    if (toRefresh.length === 0) {
      return res.json({ updated: 0, message: 'No investments with live price providers' });
    }

    const prices = await fetchLivePrices(toRefresh);

    // Update all investments in parallel — each update targets a different row
    const updateResults = await Promise.all(
      Object.entries(prices).map(async ([investmentId, price]) => {
        if (price != null && !isNaN(price)) {
          await investmentRepository.update(parseInt(investmentId, 10), {
            current_price: price,
            price_updated_at: new Date().toISOString(),
          });
          return 1;
        }
        return 0;
      })
    );
    const updated = updateResults.reduce((sum, n) => sum + n, 0);

    logger.info(`Refreshed prices for ${updated}/${toRefresh.length} investments`);
    res.json({ updated, total: toRefresh.length, prices });
  } catch (err) {
    logger.error('Failed to refresh prices', { error: err.message });
    res.status(500).json({ detail: 'Failed to refresh investment prices' });
  }
});

// GET /api/investments/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const inv = await investmentRepository.getById(parseInt(req.params.id, 10));
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });
    res.json(inv);
  } catch (err) {
    logger.error('Failed to get investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment' });
  }
});
// PATCH /api/investments/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  try {
    const inv = await investmentRepository.update(parseInt(req.params.id, 10), req.body);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });
    res.json(inv);
  } catch (err) {
    logger.error('Failed to update investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to update investment' });
  }
});

// DELETE /api/investments/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const ok = await investmentRepository.hardDelete(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ detail: 'Investment not found' });
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete investment' });
  }
});

// ==================== Portfolio Transactions ====================

// GET /api/investments/:id/transactions
router.get('/:id/transactions', validateIdParam, async (req, res) => {
  try {
    const investmentId = parseInt(req.params.id, 10);
    const { type, limit = 200, offset = 0 } = req.query;
    const opts = {
      investmentId,
      type: type || null,
      limit: Math.min(parseInt(limit, 10) || 200, 1000),
      offset: parseInt(offset, 10) || 0,
    };
    const [items, total] = await Promise.all([
      portfolioTransactionRepository.getAll(opts),
      portfolioTransactionRepository.getCount(opts),
    ]);
    res.json({ items, total, limit: opts.limit, offset: opts.offset, links: [] });
  } catch (err) {
    logger.error('Failed to get portfolio transactions', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve portfolio transactions' });
  }
});

// POST /api/investments/:id/transactions
router.post('/:id/transactions', validateIdParam, async (req, res) => {
  try {
    const investment_id = parseInt(req.params.id, 10);
    const inv = await investmentRepository.getById(investment_id);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });

    const { type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date } = req.body;
    if (!type || !date || amount === undefined) return res.status(400).json({ detail: 'type, date and amount are required' });

    const txn = await portfolioTransactionRepository.create({
      investment_id, type, date, amount, units, price_per_unit, fees, taxes,
      currency: currency || inv.currency, note, is_recurring, recurrence_interval, recurrence_end_date,
    });
    res.status(201).json(txn);
  } catch (err) {
    logger.error('Failed to create portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to create portfolio transaction' });
  }
});

// DELETE /api/investments/transactions/:txnId
router.delete('/transactions/:txnId', async (req, res) => {
  try {
    const txnId = parseInt(req.params.txnId, 10);
    if (isNaN(txnId) || txnId <= 0) return res.status(400).json({ detail: 'Invalid transaction ID' });
    const ok = await portfolioTransactionRepository.hardDelete(txnId);
    if (!ok) return res.status(404).json({ detail: 'Portfolio transaction not found' });
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete portfolio transaction' });
  }
});

// GET /api/investments/:id/summary
router.get('/:id/summary', validateIdParam, async (req, res) => {
  try {
    const investmentId = parseInt(req.params.id, 10);
    const summary = await portfolioTransactionRepository.getSummary(investmentId);
    res.json({ investment_id: investmentId, breakdown: summary });
  } catch (err) {
    logger.error('Failed to get investment summary', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment summary' });
  }
});

export default router;
