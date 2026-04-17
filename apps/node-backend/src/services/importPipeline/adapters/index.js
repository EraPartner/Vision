/**
 * Adapter registry. Auto-registers every adapter in this directory and
 * exposes factory + detection helpers used by the import pipeline and legacy
 * bankAdapters.js shim.
 *
 * Each adapter module must default-export `{ name, bankName, detect, parse }`.
 */

import belfius from './belfius.js';
import revolut from './revolut.js';
import kbc from './kbc.js';
import vision from './vision.js';
import sabb from './sabb.js';
import wise from './wise.js';
import generic from './generic.js';

const ADAPTERS = [belfius, revolut, kbc, vision, sabb, wise, generic];

const REGISTRY = new Map(ADAPTERS.map((adapter) => [adapter.name, adapter]));

export function getAdapter(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/\s+/g, '_');
  return REGISTRY.get(key) || null;
}

export function getSupportedBanks() {
  // Mirrors legacy order for UI selects. Exclude generic (internal fallback).
  return ADAPTERS
    .filter((adapter) => adapter.name !== 'generic')
    .map((adapter) => adapter.name);
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
 * @param {object | null} customConfig — when present, uses generic adapter
 */
export function createAdapter(bankName, customConfig = null) {
  if (customConfig) {
    return (filePath) => generic.parseWithConfig(filePath, customConfig);
  }
  const adapter = getAdapter(bankName);
  if (!adapter) {
    throw new Error(`No configuration found for bank: ${bankName}`);
  }
  return (filePath) => adapter.parse(filePath);
}

export { ADAPTERS, REGISTRY };
