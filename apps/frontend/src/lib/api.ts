/**
 * Public API client barrel.
 *
 * All domain logic lives in lib/api/* modules. This file assembles them into
 * the `apiClient` object so existing call sites (import { apiClient } from
 * '@/lib/api') keep working without changes.
 *
 * Types that were previously inlined here are now in lib/api/types.ts but are
 * re-exported below for backward compatibility.
 */

// Re-export shared primitives (call sites do `import { API_BASE_URL, ApiClientError } from '@/lib/api'`)
export { API_BASE_URL, ApiClientError } from '@/lib/api/client';
export type { AggregationEnvelope, ImportProgress, ImportResult, NetWorthSnapshot, NetWorthResponse, SavedChart, SavedChartCreate, MarketNewsArticle } from '@/lib/api/types';

// Domain modules
import { cancelAllRequests } from '@/lib/api/client';
import * as txn from '@/lib/api/transactions';
import * as cat from '@/lib/api/categories';
import * as rec from '@/lib/api/recipients';
import * as pln from '@/lib/api/planned';
import * as imp from '@/lib/api/imports';
import * as sett from '@/lib/api/settings';
import * as port from '@/lib/api/portfolio';
import * as info from '@/lib/api/info';
import * as splits from '@/lib/api/splits';
import * as electron from '@/lib/api/electron';
import * as charts from '@/lib/api/charts';
import * as market from '@/lib/api/market';
import * as agg from '@/lib/api/aggregations';
import * as ai from '@/lib/api/ai';

export const apiClient = {
    cancelAll: cancelAllRequests,

    // Transactions
    getTransactions: txn.getTransactions,
    getTransaction: txn.getTransaction,
    createTransaction: txn.createTransaction,
    updateTransaction: txn.updateTransaction,
    deleteTransaction: txn.deleteTransaction,

    // Categories
    getCategories: cat.getCategories,
    getCategory: cat.getCategory,
    createCategory: cat.createCategory,
    updateCategory: cat.updateCategory,
    deleteCategory: cat.deleteCategory,

    // Recipients
    getRecipients: rec.getRecipients,
    getRecipient: rec.getRecipient,
    createRecipient: rec.createRecipient,
    updateRecipient: rec.updateRecipient,
    deleteRecipient: rec.deleteRecipient,
    mergeRecipients: rec.mergeRecipients,
    unmergeRecipient: rec.unmergeRecipient,
    getRecipientAliases: rec.getRecipientAliases,

    // Planned transactions
    getPlannedTransactions: pln.getPlannedTransactions,
    getPlannedTransaction: pln.getPlannedTransaction,
    createPlannedTransaction: pln.createPlannedTransaction,
    updatePlannedTransaction: pln.updatePlannedTransaction,
    deletePlannedTransaction: pln.deletePlannedTransaction,
    executePlannedTransaction: pln.executePlannedTransaction,

    // Imports
    importCSV: imp.importCSV,
    importCSVWithProgress: imp.importCSVWithProgress,
    importCSVCustom: imp.importCSVCustom,
    importRecipients: imp.importRecipients,
    importCategories: imp.importCategories,
    listImportBatches: imp.listImportBatches,
    getImportBatch: imp.getImportBatch,
    rollbackImportBatch: imp.rollbackImportBatch,

    // Settings
    getSettings: sett.getSettings,
    getSetting: sett.getSetting,
    saveSetting: sett.saveSetting,
    saveSettingsBulk: sett.saveSettingsBulk,

    // Portfolio / investments
    getInvestments: port.getInvestments,
    getInvestment: port.getInvestment,
    createInvestment: port.createInvestment,
    refreshInvestmentPrices: port.refreshInvestmentPrices,
    getPriceProviders: port.getPriceProviders,
    updateInvestment: port.updateInvestment,
    deleteInvestment: port.deleteInvestment,
    getInvestmentPriceHistory: port.getInvestmentPriceHistory,
    getPortfolioTransactions: port.getPortfolioTransactions,
    getPortfolioTransactionsBulk: port.getPortfolioTransactionsBulk,
    createPortfolioTransaction: port.createPortfolioTransaction,
    updatePortfolioTransaction: port.updatePortfolioTransaction,
    deletePortfolioTransaction: port.deletePortfolioTransaction,

    // Info / statistics
    getStatistics: info.getStatistics,
    getSupportedParsers: info.getSupportedParsers,
    getBanks: info.getBanks,
    getTransactionSummary: info.getTransactionSummary,
    getTransactionCount: info.getTransactionCount,
    getCashflowComparison: info.getCashflowComparison,
    getMonthlyFinancialSummary: info.getMonthlyFinancialSummary,
    getBankBalances: info.getBankBalances,
    getBelgianInflationRates: info.getBelgianInflationRates,
    getRecurringPatterns: info.getRecurringPatterns,
    getRecipientInsights: info.getRecipientInsights,
    getPortfolioPerformance: info.getPortfolioPerformance,
    getNetWorth: info.getNetWorth,
    refreshMaterializedViews: info.refreshMaterializedViews,
    getExchangeRates: info.getExchangeRates,
    refreshExchangeRates: info.refreshExchangeRates,

    // Splits / owes
    getOwedSummary: splits.getOwedSummary,
    getOwedByRecipient: splits.getOwedByRecipient,
    exportOwedByRecipientCsv: splits.exportOwedByRecipientCsv,
    getSplitsByTransaction: splits.getSplitsByTransaction,
    createSplitsBatch: splits.createSplitsBatch,
    recordSplitPayment: splits.recordSplitPayment,
    settleSplit: splits.settleSplit,
    settleAllSplitsByRecipient: splits.settleAllSplitsByRecipient,
    deleteSplit: splits.deleteSplit,

    // Electron (desktop only)
    isElectron: electron.isElectron,
    checkForUpdates: electron.checkForUpdates,
    triggerDockerUpdate: electron.triggerDockerUpdate,
    installShellUpdate: electron.installShellUpdate,
    runBackup: electron.runBackup,
    selectBackupFile: electron.selectBackupFile,
    restoreBackup: electron.restoreBackup,
    selectBackupDir: electron.selectBackupDir,
    saveBackupSettings: electron.saveBackupSettings,
    loadBackupSettings: electron.loadBackupSettings,
    getBackupEncryptionStatus: electron.getBackupEncryptionStatus,
    setBackupPassphrase: electron.setBackupPassphrase,

    // Saved charts
    getSavedCharts: charts.getSavedCharts,
    createSavedChart: charts.createSavedChart,
    updateSavedChart: charts.updateSavedChart,
    deleteSavedChart: charts.deleteSavedChart,

    // Market / watchlist
    getMarketNews: market.getMarketNews,
    getMarketQuotes: market.getMarketQuotes,
    getWatchlist: market.getWatchlist,
    createWatchlistItem: market.createWatchlistItem,
    updateWatchlistItem: market.updateWatchlistItem,
    deleteWatchlistItem: market.deleteWatchlistItem,

    // Aggregations
    getAggregationMonthlySummary: agg.getAggregationMonthlySummary,
    getAggregationCategoryBreakdown: agg.getAggregationCategoryBreakdown,
    getAggregationRecipientInsights: agg.getAggregationRecipientInsights,
    getAggregationCashflowComparison: agg.getAggregationCashflowComparison,
    getAggregationAverageVsCurrent: agg.getAggregationAverageVsCurrent,
    getAggregationBankBalances: agg.getAggregationBankBalances,

    // AI chat
    getOllamaStatus: ai.getOllamaStatus,
    getOllamaModels: ai.getOllamaModels,
    getConversations: ai.getConversations,
    getConversation: ai.getConversation,
    createConversation: ai.createConversation,
    renameConversation: ai.renameConversation,
    deleteConversation: ai.deleteConversation,
    sendChatMessage: ai.sendChatMessage,
    streamChat: ai.streamChat,
};

// Type re-exports for call sites that import from '@/lib/api'
export type { Transaction, Category, Recipient, PlannedTransaction, Investment, PortfolioTransaction } from '@/types/api';
export type {
    ChatMessage,
    ChatRole,
    ChatStreamEvent,
    ChatTurnResponse,
    Conversation,
    ConversationDetail,
    ConversationSummary,
    CreateConversationBody,
    OllamaModel,
    OllamaModelsResponse,
    OllamaStatus,
    SendChatBody,
    TokenUsage,
    ToolRenderAs,
    ToolResultPayload,
} from '@/types/aiChat';
export type { SplitItem, SplitPayment } from '@/lib/api/splits';
export type { ExchangeRate, ExchangeRatesData } from '@/lib/api/info';
export type { WatchlistItem, WatchlistCreate, WatchlistUpdate, WatchlistListResponse } from '@/types/watchlist';
