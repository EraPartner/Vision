/**
 * Adapter registry. Auto-registers every adapter in this directory and
 * exposes factory + detection helpers used by the import pipeline and focused
 * adapter tests.
 *
 * Each adapter module must default-export `{ name, bankName, detect, parse }`.
 */

import belfius from "./belfius.ts";
import revolut from "./revolut.ts";
import ing from "./ing.ts";
import bnp from "./bnp.ts";
import kbc from "./kbc.ts";
import vision from "./vision.ts";
import sabb from "./sabb.ts";
import wise from "./wise.ts";
import generic from "./generic.ts";
import type { ParsedBankTransactions } from "./_shared.ts";
import type { CustomTransactionParserConfig } from "./generic.ts";

/**
 * The interface every adapter module default-exports.
 *
 * `parseWithConfig` is optional because only `generic` has one — the pipeline
 * feature-detects it (see stage.js) rather than branching on the adapter name.
 * `parse`'s second parameter is likewise generic-only.
 */
export interface BankCsvAdapter {
  /** internal key, e.g. 'bnp' */
  name: string;
  /** display label, e.g. 'BNP Paribas Fortis' */
  bankName: string;
  detect: (csvSample?: string | null) => boolean;
  parse: (
    filePath: string,
    config?: CustomTransactionParserConfig,
  ) => Promise<ParsedBankTransactions>;
  parseWithConfig?: (
    filePath: string,
    config: CustomTransactionParserConfig,
  ) => Promise<ParsedBankTransactions>;
  /** whether imported accounts retain native currency partitions */
  multiCurrencyCash?: boolean;
}

const ADAPTERS: BankCsvAdapter[] = [
  belfius,
  revolut,
  ing,
  bnp,
  kbc,
  vision,
  sabb,
  wise,
  generic,
];

const REGISTRY = new Map(ADAPTERS.map((adapter) => [adapter.name, adapter]));

/**
 * Look an adapter up by internal name (case- and whitespace-insensitive).
 */
export function getAdapter(
  name: string | null | undefined,
): BankCsvAdapter | null {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/\s+/g, "_");
  return REGISTRY.get(key) || null;
}

/**
 * @returns internal adapter names, excluding the generic fallback
 */
export function getSupportedBanks(): string[] {
  // Mirrors legacy order for UI selects. Exclude generic (internal fallback).
  return ADAPTERS.filter((adapter) => adapter.name !== "generic").map(
    (adapter) => adapter.name,
  );
}

/**
 * Single source of truth for the frontend adapter catalog: { key, name } per
 * non-generic adapter, derived from the registry so adding an adapter exposes it
 * in the UI automatically (no separate hardcoded list to drift).
 */
export function listAdapters(): Array<{ key: string; name: string }> {
  return ADAPTERS.filter((adapter) => adapter.name !== "generic").map(
    (adapter) => ({ key: adapter.name, name: adapter.bankName }),
  );
}

/**
 * @returns adapter name or null if none detected
 */
export function detectBank(
  csvSample: string | null | undefined,
): string | null {
  if (!csvSample) return null;
  for (const adapter of ADAPTERS) {
    if (adapter.name === "generic") continue;
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
 * @param bankName — display name or internal name
 * @param customConfig — when present, uses generic adapter
 * @throws {Error} when no adapter matches `bankName` and no customConfig was given
 */
export function createAdapter(
  bankName: string,
  customConfig: CustomTransactionParserConfig | null = null,
): (filePath: string) => Promise<ParsedBankTransactions> {
  if (customConfig) {
    return (filePath: string) =>
      generic.parseWithConfig(filePath, customConfig);
  }
  const adapter = getAdapter(bankName);
  if (!adapter) {
    throw new Error(`No configuration found for bank: ${bankName}`);
  }
  return (filePath: string) => adapter.parse(filePath);
}

export { ADAPTERS };
