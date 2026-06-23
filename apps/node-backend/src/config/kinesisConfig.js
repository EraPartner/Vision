/**
 * Kinesis Market Data Provider Configuration
 *
 * Configuration for fetching trendline price data from the Kinesis Market Data API.
 * Supports precious metals (gold, silver, platinum, palladium) and other commodities.
 *
 * Environment Variables:
 *   - KINESIS_BASE_URL: Base API endpoint (default: provided below)
 *   - KINESIS_DEFAULT_TIMEFRAME: Default trendline timeframe in minutes (default: 60).
 *   - KINESIS_DEFAULT_FROM_DATE: Default start date ISO8601 (default: 2019-01-01T08:47:55.843Z)
 */

import { env } from './env.js';

const KINESIS_BASE_URL = env.KINESIS_BASE_URL;
const KINESIS_DEFAULT_TIMEFRAME = env.KINESIS_DEFAULT_TIMEFRAME;
const KINESIS_DEFAULT_FROM_DATE = env.KINESIS_DEFAULT_FROM_DATE;

/**
 * Kinesis asset configuration
 * Maps internal asset names to Kinesis API symbol identifiers
 * @typedef {Object} KinesisAssetConfig
 * @property {string} symbol - Kinesis symbol (e.g., 'KAU_USD' for KiloAngGold)
 * @property {number} [timeframe] - Timeframe in minutes (optional, uses default)
 * @property {string} [fromDate] - ISO8601 start date (optional, uses default)
 */

/** @type {Object<string, KinesisAssetConfig>} */
const KINESIS_ASSETS = {
  // Gold products (KAU = KiloAng Gold, XAU = Gold oz)
  kaufen_gold: { symbol: 'KAU_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
  xau_usd: { symbol: 'XAU_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
  
  // Silver products (KAG = KiloAng Silver, XAG = Silver oz)
  kaufen_silver: { symbol: 'KAG_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
  xag_usd: { symbol: 'XAG_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
  
  // Platinum
  xpt_usd: { symbol: 'XPT_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
  
  // Palladium
  xpd_usd: { symbol: 'XPD_USD', timeframe: 60, fromDate: '2019-01-01T08:47:55.843Z' },
};

/**
 * Get configuration for a specific asset
 * @param {string} assetName - Internal asset name
 * @returns {KinesisAssetConfig|undefined} Asset configuration or undefined
 */
export function getKinesisAssetConfig(assetName) {
  return KINESIS_ASSETS[assetName];
}

/**
 * Get all configured Kinesis assets
 * @returns {Object<string, KinesisAssetConfig>} All Kinesis asset configurations
 */
export function getAllKinesisAssets() {
  return { ...KINESIS_ASSETS };
}

export {
  KINESIS_BASE_URL,
  KINESIS_DEFAULT_TIMEFRAME,
  KINESIS_DEFAULT_FROM_DATE,
  KINESIS_ASSETS,
};
