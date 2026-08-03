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
export type { AggregationEnvelope, ImportProgress, ImportResult, NetWorthSnapshot, NetWorthResponse, SavedChart, SavedChartCreate, MarketNewsArticle, ImportPreviewResponse, ImportPreviewGroup, ImportStagingRow, MatchSource } from '@/lib/api/types';

// Domain modules
import * as txn from '@/lib/api/transactions';
import * as cat from '@/lib/api/categories';
import * as acct from '@/lib/api/accounts';
import * as rec from '@/lib/api/recipients';
import * as pln from '@/lib/api/planned';
import * as imp from '@/lib/api/imports';
import * as sett from '@/lib/api/settings';
import * as port from '@/lib/api/portfolio';
import * as portImp from '@/lib/api/portfolioImports';
import * as info from '@/lib/api/info';
import * as splits from '@/lib/api/splits';
import * as electron from '@/lib/api/electron';
import * as charts from '@/lib/api/charts';
import * as market from '@/lib/api/market';
import * as research from '@/lib/api/research';
import * as agg from '@/lib/api/aggregations';
import * as ai from '@/lib/api/ai';
import * as tags from '@/lib/api/tags';
import * as crossWorkspace from '@/lib/api/crossWorkspace';

export const apiClient = {
    // Transactions
    getTransactions: txn.getTransactions,
    createTransaction: txn.createTransaction,
    updateTransaction: txn.updateTransaction,
    deleteTransaction: txn.deleteTransaction,
    bulkDeleteTransactions: txn.bulkDeleteTransactions,
    bulkUpdateTransactions: txn.bulkUpdateTransactions,
    bulkExportTransactions: txn.bulkExportTransactions,

    // Categories
    getCategories: cat.getCategories,
    createCategory: cat.createCategory,
    updateCategory: cat.updateCategory,
    deleteCategory: cat.deleteCategory,

    // Accounts (ADR-088)
    getAccounts: acct.getAccounts,
    createAccount: acct.createAccount,
    updateAccount: acct.updateAccount,
    deleteAccount: acct.deleteAccount,
    mergeAccounts: acct.mergeAccounts,
    previewMerge: acct.previewMerge,
    setOpeningBalance: acct.setOpeningBalance,
    reconcileAccount: acct.reconcileAccount,

    // Recipients
    getRecipients: rec.getRecipients,
    getRecipient: rec.getRecipient,
    createRecipient: rec.createRecipient,
    updateRecipient: rec.updateRecipient,
    deleteRecipient: rec.deleteRecipient,
    mergeRecipients: rec.mergeRecipients,
    unmergeRecipient: rec.unmergeRecipient,
    listRecipientPatterns: rec.listRecipientPatterns,
    createRecipientPattern: rec.createRecipientPattern,
    updateRecipientPattern: rec.updateRecipientPattern,
    deleteRecipientPattern: rec.deleteRecipientPattern,
    previewRecipientPattern: rec.previewRecipientPattern,

    // Planned transactions
    getPlannedTransactions: pln.getPlannedTransactions,
    createPlannedTransaction: pln.createPlannedTransaction,
    updatePlannedTransaction: pln.updatePlannedTransaction,
    deletePlannedTransaction: pln.deletePlannedTransaction,
    executePlannedTransaction: pln.executePlannedTransaction,
    getPlannedMatchSuggestions: pln.getPlannedMatchSuggestions,

    // Imports
    importCSV: imp.importCSV,
    importCSVWithProgress: imp.importCSVWithProgress,
    importCSVCustom: imp.importCSVCustom,
    importRecipients: imp.importRecipients,
    importCategories: imp.importCategories,
    listImportBatches: imp.listImportBatches,
    rollbackImportBatch: imp.rollbackImportBatch,
    getImportPreview: imp.getImportPreview,
    overrideImportRow: imp.overrideImportRow,
    overrideImportRowCategory: imp.overrideImportRowCategory,
    commitImportBatch: imp.commitImportBatch,
    listCustomParserConfigs: imp.listCustomParserConfigs,
    createCustomParserConfig: imp.createCustomParserConfig,
    updateCustomParserConfig: imp.updateCustomParserConfig,
    deleteCustomParserConfig: imp.deleteCustomParserConfig,

    // Settings
    getSettings: sett.getSettings,
    getSetting: sett.getSetting,
    saveSetting: sett.saveSetting,

    // Portfolio / investments
    getInvestments: port.getInvestments,
    createInvestment: port.createInvestment,
    refreshInvestmentPrices: port.refreshInvestmentPrices,
    updateInvestment: port.updateInvestment,
    deleteInvestment: port.deleteInvestment,
    getInvestmentPriceHistory: port.getInvestmentPriceHistory,
    getPortfolioTransactions: port.getPortfolioTransactions,
    getPortfolioTransactionsBulk: port.getPortfolioTransactionsBulk,
    createPortfolioTransaction: port.createPortfolioTransaction,
    updatePortfolioTransaction: port.updatePortfolioTransaction,
    deletePortfolioTransaction: port.deletePortfolioTransaction,

    // Portfolio imports
    importPortfolioCSVCustom: portImp.importPortfolioCSVCustom,
    importPortfolioCSVWithProgress: portImp.importPortfolioCSVWithProgress,
    getPortfolioImportPreview: portImp.getPortfolioImportPreview,
    overridePortfolioImportRow: portImp.overridePortfolioImportRow,
    commitPortfolioImportBatch: portImp.commitPortfolioImportBatch,
    rollbackPortfolioImportBatch: portImp.rollbackPortfolioImportBatch,
    listPortfolioParserConfigs: portImp.listPortfolioParserConfigs,
    createPortfolioParserConfig: portImp.createPortfolioParserConfig,
    updatePortfolioParserConfig: portImp.updatePortfolioParserConfig,
    deletePortfolioParserConfig: portImp.deletePortfolioParserConfig,

    // Info / statistics (getStatistics + getTransactionSummary removed — Phase 9
    // cutover deleted the legacy /api/info and /transaction-summary routes)
    getSupportedParsers: info.getSupportedParsers,
    getDistinctBankAccounts: info.getDistinctBankAccounts,
    getTransactionCount: info.getTransactionCount,
    getCashflowForecastMethods: (params?: Parameters<typeof agg.getCashflowForecastMethods>[0]) =>
        agg.getCashflowForecastMethods(params).then(r => r.data),
    getCashflowForecastRolling: (params?: Parameters<typeof agg.getCashflowForecastRolling>[0]) =>
        agg.getCashflowForecastRolling(params).then(r => r.data),
    getCashflowForecastAccuracy: (params?: Parameters<typeof agg.getCashflowForecastAccuracy>[0]) =>
        agg.getCashflowForecastAccuracy(params).then(r => r.data),
    getBankBalances: (params?: Parameters<typeof agg.getAggregationBankBalances>[0]) =>
        agg.getAggregationBankBalances(params).then(r => r.data),
    getRecurringPatterns: info.getRecurringPatterns,
    getRecipientInsights: (params?: Parameters<typeof agg.getAggregationRecipientInsights>[0]) =>
        agg.getAggregationRecipientInsights(params).then(r => r.data),
    getPortfolioPerformance: info.getPortfolioPerformance,
    getPortfolioSummary: info.getPortfolioSummary,
    getNetWorth: info.getNetWorth,
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
    preUpdateBackup: electron.preUpdateBackup,
    runBackup: electron.runBackup,
    selectBackupFile: electron.selectBackupFile,
    restoreBackup: electron.restoreBackup,
    isBackupEncrypted: electron.isBackupEncrypted,
    selectBackupDir: electron.selectBackupDir,
    saveBackupSettings: electron.saveBackupSettings,
    loadBackupSettings: electron.loadBackupSettings,
    getBackupEncryptionStatus: electron.getBackupEncryptionStatus,
    setBackupPassphrase: electron.setBackupPassphrase,
    saveServicesSettings: electron.saveServicesSettings,
    loadServicesSettings: electron.loadServicesSettings,

    // Saved charts
    getSavedCharts: charts.getSavedCharts,
    createSavedChart: charts.createSavedChart,
    updateSavedChart: charts.updateSavedChart,
    deleteSavedChart: charts.deleteSavedChart,

    // Market / watchlist
    getMarketNews: market.getMarketNews,
    getMarketQuotes: market.getMarketQuotes,
    getMarketChart: market.getMarketChart,
    searchMarket: market.searchMarket,
    getWatchlist: market.getWatchlist,
    createWatchlistItem: market.createWatchlistItem,
    updateWatchlistItem: market.updateWatchlistItem,
    deleteWatchlistItem: market.deleteWatchlistItem,

    // Research (ADR-079) — multi-provider, envelope meta preserved
    searchResearch: research.searchResearch,
    getResearchChart: research.getResearchChart,
    getResearchAnalyst: research.getResearchAnalyst,
    getResearchNews: research.getResearchNews,
    getResearchMappings: research.getResearchMappings,
    resolveResearchMappings: research.resolveResearchMappings,
    saveResearchMappings: research.saveResearchMappings,
    deleteResearchMapping: research.deleteResearchMapping,
    auditResearchMappings: research.auditResearchMappings,
    getResearchScorecard: research.getResearchScorecard,
    getPortfolioForecast: research.getPortfolioForecast,
    searchMacro: research.searchMacro,
    getMacroSeries: research.getMacroSeries,

    // Aggregations
    getAggregationMonthlySummary: agg.getAggregationMonthlySummary,
    getAggregationRecipientInsights: agg.getAggregationRecipientInsights,

    // Tags
    getTags: tags.getTags,
    createTag: tags.createTag,
    updateTag: tags.updateTag,
    deleteTag: tags.deleteTag,
    bulkTagTransactions: tags.bulkTagTransactions,

    // Cross-workspace (ADR-098)
    computeRebalance: crossWorkspace.computeRebalance,

    // AI chat
    getOllamaStatus: ai.getOllamaStatus,
    getOllamaModels: ai.getOllamaModels,
    getConversations: ai.getConversations,
    getConversation: ai.getConversation,
    createConversation: ai.createConversation,
    renameConversation: ai.renameConversation,
    deleteConversation: ai.deleteConversation,
    streamChat: ai.streamChat,
};

// Type re-exports for call sites that import from '@/lib/api'
export type {
    Transaction,
    Category,
    Account,
    AccountCreate,
    AccountUpdate,
    AccountsListResponse,
    AccountType,
    AccountLiquidityClass,
    AccountTaxWrapper,
    AccountOwner,
    Recipient,
    PlannedTransaction,
    Investment,
    PortfolioTransaction,
    Tag,
    TagCreate,
    TagUpdate,
    BulkTagRequest,
    BulkTagResult,
    BulkSelectionRequest,
    BulkTransactionFilter,
    BulkUpdateFields,
    BulkUpdateRequest,
    BulkExportRequest,
    BulkDeleteResult,
    BulkUpdateResult,
} from '@/types/api';
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
export type { SavedParserConfig, CustomParserConfigPayload } from '@/lib/api/imports';
export type { SplitItem, SplitPayment, SplitCreateInput, OwedSummaryItem, OwedDetailItem } from '@/lib/api/splits';
export type { RecipientPattern, RecipientPatternCreate, RecipientPatternUpdate, PatternSuggestion } from '@/lib/api/recipients';
export type { ExchangeRate, ExchangeRatesData, PortfolioSummaryItem, PortfolioSummaryResponse, PortfolioSummaryTotals } from '@/lib/api/info';
export type { RebalanceRequest, RebalanceResponse, ModelPortfolio } from '@/lib/api/crossWorkspace';
export type { WatchlistItem, WatchlistCreate, WatchlistUpdate, WatchlistListResponse } from '@/types/watchlist';
