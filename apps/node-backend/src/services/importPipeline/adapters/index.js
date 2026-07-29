/**
 * Adapter registry. Auto-registers every adapter in this directory and
 * exposes factory + detection helpers used by the import pipeline and legacy
 * bankAdapters.js shim.
 *
 * Each adapter module must default-export `{ name, bankName, detect, parse }`.
 */

import belfius from './belfius.js';
import revolut from './revolut.js';
import ing from './ing.js';
import bnp from './bnp.js';
import kbc from './kbc.js';
import vision from './vision.js';
import sabb from './sabb.js';
import wise from './wise.js';
import generic from './generic.js';

/**
 * @typedef {import('./_shared.js').ParsedBankTransactions} ParsedBankTransactions
 * @typedef {import('./generic.js').CustomTransactionParserConfig} CustomTransactionParserConfig
 */

/**
 * The interface every adapter module default-exports.
 *
 * `parseWithConfig` is optional because only `generic` has one — the pipeline
 * feature-detects it (see stage.js) rather than branching on the adapter name.
 * `parse`'s second parameter is likewise generic-only.
 *
 * @typedef {object} BankCsvAdapter
 * @property {string} name internal key, e.g. 'bnp'
 * @property {string} bankName display label, e.g. 'BNP Paribas Fortis'
 * @property {(csvSample?: string|null) => boolean} detect
 * @property {(filePath: string, config?: any) => Promise<ParsedBankTransactions>} parse
 * @property {(filePath: string, config: any) => Promise<ParsedBankTransactions>} [parseWithConfig]
 */

/** @type {BankCsvAdapter[]} */
const ADAPTERS = [belfius, revolut, ing, bnp, kbc, vision, sabb, wise, generic];

const REGISTRY = new Map(ADAPTERS.map((adapter) => [adapter.name, adapter]));

/**
 * Look an adapter up by internal name (case- and whitespace-insensitive).
 *
 * @param {string|null|undefined} name
 * @returns {BankCsvAdapter|null}
 */
export function getAdapter(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/\s+/g, '_');
  return REGISTRY.get(key) || null;
}

/**
 * @returns {string[]} internal adapter names, excluding the generic fallback
 */
export function getSupportedBanks() {
  // Mirrors legacy order for UI selects. Exclude generic (internal fallback).
  return ADAPTERS
    .filter((adapter) => adapter.name !== 'generic')
    .map((adapter) => adapter.name);
}

/**
 * Single source of truth for the frontend adapter catalog: { key, name } per
 * non-generic adapter, derived from the registry so adding an adapter exposes it

 * in the UI automatically (no separate hardcoded list to drift).
 *
 * @returns {Array<{ key: string, name: string }>}
 */
export function listAdapters() {
  return ADAPTERS
    .filter((adapter) => adapter.name !== 'generic')
    .map((adapter) => ({ key: adapter.name, name: adapter.bankName }));
}

/**
 * @param {string | null | undefined} csvSample
 * @returns {string | null} adapter name or null if none detected
 */
export function detectBank(csvSample) {
  if (!csvSample) return null;
  for (const adapter of ADAPTERS) {
    if (adapter.name === 'generic') continue;
    try {
      if (adapter.detect(csvSample)) return adapter.name;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Legacy-compatible factory: returns a `(filePath) => transactions[]` callable.
 *
 * @param {string} bankName — display name or internal name

 * @param {CustomTransactionParserConfig | null} customConfig — when present, uses generic adapter
 * @returns {(filePath: string) => Promise<ParsedBankTransactions>}
 * @throws {Error} when no adapter matches `bankName` and no customConfig was given
 */
export function createAdapter(bankName, customConfig = null) {
  if (customConfig) {
    return (/** @type {string} */ filePath) => generic.parseWithConfig(filePath, customConfig);
  }
  const adapter = getAdapter(bankName);
  if (!adapter) {
    throw new Error(`No configuration found for bank: ${bankName}`);
  }
  return (/** @type {string} */ filePath) => adapter.parse(filePath);
}

export { ADAPTERS, REGISTRY };
