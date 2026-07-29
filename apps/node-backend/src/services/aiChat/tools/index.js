/**
 * Tool registry + dispatcher for the AI chat service.
 *
 * The LLM emits tool_calls with `{name, arguments}`. The dispatcher:
 *   - looks the tool up by name (rejects unknown names)
 *   - coerces `arguments` from string|object into a plain object
 *   - runs the tool, translating validation errors into a shape the
 *     LLM can retry with (see `formatError`)
 *
 * Individual tools own their own arg validation via `_validate.js`.
 * The dispatcher never silently drops or fabricates values.
 */

import {
  getSpendByCategory,
  getMonthlySpend,
  getTopRecipients,
  getTransactionsInRange,
  getMonthlyCategoryBreakdown,
  searchTransactions,
  getLargestTransactions,
  getSpendTrendForCategory,
  getYearOverYearComparison,
  getUncategorisedTransactions,
  getNetCashflow,
} from './expenses.js';
import {
  getPortfolioHoldings,
  getReturnsForRange,
  getDividendIncome,
  getAssetAllocation,
  getUnrealizedGains,
  getBestWorstPerformers,
} from './portfolio.js';
import {
  getUpcomingPlanned,
  getSubscriptionTotal,
  getLoanSchedule,
  getProjectedBalance,
} from './planned.js';
import {
  getTaxableIncomeSummary,
  getCapitalGainsForYear,
  getDeductibles,
} from './tax.js';
import {
  getBankBalances,
  getSpendingPace,
  getRecipientInsights,
  getWatchlist,
  getCategories,
  getRecurringDetected,
  insightsDigest,
} from './insights.js';
import { ToolValidationError } from './_validate.js';

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON-schema `parameters` for the LLM tool-call spec.
 * @property {(args: Record<string, unknown>, context?: import('./_validate.js').ToolContext) => Promise<object>} run
 */

/** @type {Record<string, Tool>} */
export const TOOLS = Object.freeze({
  [getSpendByCategory.name]: getSpendByCategory,
  [getMonthlySpend.name]: getMonthlySpend,
  [getTopRecipients.name]: getTopRecipients,
  [getTransactionsInRange.name]: getTransactionsInRange,
  [getMonthlyCategoryBreakdown.name]: getMonthlyCategoryBreakdown,
  [searchTransactions.name]: searchTransactions,
  [getLargestTransactions.name]: getLargestTransactions,
  [getSpendTrendForCategory.name]: getSpendTrendForCategory,
  [getYearOverYearComparison.name]: getYearOverYearComparison,
  [getUncategorisedTransactions.name]: getUncategorisedTransactions,
  [getPortfolioHoldings.name]: getPortfolioHoldings,
  [getReturnsForRange.name]: getReturnsForRange,
  [getDividendIncome.name]: getDividendIncome,
  [getAssetAllocation.name]: getAssetAllocation,
  [getUnrealizedGains.name]: getUnrealizedGains,
  [getBestWorstPerformers.name]: getBestWorstPerformers,
  [getUpcomingPlanned.name]: getUpcomingPlanned,
  [getSubscriptionTotal.name]: getSubscriptionTotal,
  [getLoanSchedule.name]: getLoanSchedule,
  [getProjectedBalance.name]: getProjectedBalance,
  [getTaxableIncomeSummary.name]: getTaxableIncomeSummary,
  [getCapitalGainsForYear.name]: getCapitalGainsForYear,
  [getDeductibles.name]: getDeductibles,
  [getBankBalances.name]: getBankBalances,
  [getSpendingPace.name]: getSpendingPace,
  [getRecipientInsights.name]: getRecipientInsights,
  [getWatchlist.name]: getWatchlist,
  [getCategories.name]: getCategories,
  [getRecurringDetected.name]: getRecurringDetected,
  [insightsDigest.name]: insightsDigest,
  [getNetCashflow.name]: getNetCashflow,
});

/**
 * OpenAI/Ollama-compatible tool schemas for the `tools` field on /api/chat.
 */
export function getToolSchemas() {
  return Object.values(TOOLS).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function getToolNames() {
  return Object.keys(TOOLS);
}

/**
 * @param {unknown} rawArgs
 * @returns {Record<string, unknown>}
 */
function coerceArguments(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'object') return /** @type {Record<string, unknown>} */ (rawArgs);
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
      throw new ToolValidationError('arguments must be a JSON object');
    } catch (err) {
      if (err instanceof ToolValidationError) throw err;
      throw new ToolValidationError(`arguments is not valid JSON: ${err.message}`);
    }
  }
  throw new ToolValidationError('arguments must be an object or JSON string');
}

// Errors are of genuinely arbitrary shape here — anything a tool's `run()` can
// throw, not just ToolValidationError — so `err` stays `any` (dbEditor
// pg-error precedent).
/** @param {any} err */
function formatError(err) {
  if (err instanceof ToolValidationError) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        field: err.field,
        message: err.message,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'TOOL_ERROR',
      message: err?.message || 'Tool execution failed',
    },
  };
}

/**
 * Invoke a tool by name with LLM-provided arguments.
 *
 * Returns `{ok, data, meta}` on success, `{ok: false, error}` on failure.
 * Never throws — the chat service feeds the error payload back to the
 * model so it can correct its args and retry.
 *
 * @param {string} name
 * @param {unknown} rawArgs
 * @param {import('./_validate.js').ToolContext} [context]
 * @returns {Promise<object>}
 */
export async function dispatchTool(name, rawArgs, context = {}) {
  const tool = TOOLS[name];
  if (!tool) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${name}`,
        availableTools: Object.keys(TOOLS),
      },
    };
  }

  try {
    const args = coerceArguments(rawArgs);
    return await tool.run(args, context);
  } catch (err) {
    return formatError(err);
  }
}
