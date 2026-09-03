import { z } from 'zod';
import { API_BASE_URL, generateRequestId, parseEnvelopeError, apiRequest } from '@/lib/api/client';
import { postMultipartImport } from '@/lib/api/helpers';
import { importProgressSchema } from '@/lib/api/imports';
import { readSseStream } from '@/lib/api/sse';
import type { ImportProgress } from '@/types/apiClient';
import type { AssetClass as AssetClassValue } from '@vision/types/assetClasses';
import type { PortfolioTxnType as PortfolioTxnTypeValue } from '@vision/types/portfolioTxnTypes';
import { ImportCancelledError } from '@/lib/api/importCancelled';

/**
 * Runtime guards for the portfolio import SSE stream (ZOD-10); see the
 * matching note in imports.ts. Shapes mirror portfolioImportRoutes.js
 * `buildComplete` / the shared review_required payload.
 */
const portfolioImportResultSchema = z.looseObject({
  batch_id: z.number(),
  total_processed: z.number().optional(),
  total: z.number().optional(),
  skipped: z.number().optional(),
  imported: z.number(),
  duplicates: z.number(),
  errors: z.number(),
  status: z.string().optional(),
  requires_review: z.boolean().optional(),
});

const portfolioReviewRequiredSchema = z.looseObject({
  batch_id: z.number(),
});

const PORTFOLIO_STREAM_SCHEMAS: Record<string, z.ZodType> = {
  progress: importProgressSchema,
  complete: portfolioImportResultSchema,
  review_required: portfolioReviewRequiredSchema,
};

// Unions derive from the canonical runtime arrays in @vision/types; re-exported
// under their historical names so existing imports keep resolving.
export type { AssetClassValue, PortfolioTxnTypeValue };

export interface PortfolioCustomConfig {
  dateColumn: string;
  typeColumn: string;
  symbolColumn: string;
  nameColumn: string;
  unitsColumn: string;
  priceColumn: string;
  amountColumn: string;
  feesColumn: string;
  taxesColumn: string;
  currencyColumn: string;
  fxRateColumn: string;
  noteColumn: string;
  dateFormat: string;
  separator: string;
  encoding: string;
  skipRows: number;
  defaultAssetClass: AssetClassValue;
  defaultType: PortfolioTxnTypeValue;
  typeMapping: Record<string, string>;
}

export interface SavedPortfolioParserConfig {
  id: number;
  name: string;
  kind: string;
  config: PortfolioCustomConfig;
  created_at: string;
  updated_at: string;
}

export interface PortfolioPreviewRow {
  id: number;
  row_index: number;
  status: string;
  /** Brokerage routing (ADR-095): 'cash' | 'portfolio' | null (legacy/non-brokerage). */
  route?: string | null;
  tx_date: string;
  type: string | null;
  type_raw: string | null;
  symbol_raw: string | null;
  name_raw: string | null;
  units: number | null;
  price_per_unit: number | null;
  amount: number | null;
  fees: number | null;
  taxes: number | null;
  currency: string | null;
  fx_rate_to_eur: number | null;
  note: string | null;
  match_source: string | null;
  error_message: string | null;
  user_override_investment_id: number | null;
}

export interface PortfolioPreviewGroup {
  /** Brokerage cash group (ADR-095): deposits/withdrawals, no instrument to resolve. */
  is_cash?: boolean;
  investment_id: number | null;
  investment_name: string | null;
  investment_symbol: string | null;
  investment_asset_class: string | null;
  raw_symbol: string | null;
  raw_name: string | null;
  row_count: number;
  rows: PortfolioPreviewRow[];
}

export interface PortfolioPreviewResponse {
  batch_id: number;
  groups: PortfolioPreviewGroup[];
  totals: { symbol: number; name_exact: number; unresolved: number; error: number };
}

export interface PortfolioImportResult {
  batch_id: number;
  total_processed?: number;
  total?: number;
  /** Rows the adapter could not parse (bad column mapping / date format). */
  skipped?: number;
  imported: number;
  duplicates: number;
  errors: number;
  status?: string;
  requires_review?: boolean;
}

// Flatten the camelCase config into the snake_case form the backend route reads.
function configToParams(config: PortfolioCustomConfig, adapterName: string): URLSearchParams {
  const p = new URLSearchParams();
  p.append('adapter_name', adapterName);
  p.append('date_format', config.dateFormat);
  p.append('separator', config.separator);
  p.append('encoding', config.encoding);
  p.append('skip_rows', String(config.skipRows));
  p.append('default_asset_class', config.defaultAssetClass);
  p.append('default_type', config.defaultType);
  p.append('type_mapping', JSON.stringify(config.typeMapping || {}));
  p.append('date_column', config.dateColumn);
  if (config.typeColumn) p.append('type_column', config.typeColumn);
  if (config.symbolColumn) p.append('symbol_column', config.symbolColumn);
  if (config.nameColumn) p.append('name_column', config.nameColumn);
  if (config.unitsColumn) p.append('units_column', config.unitsColumn);
  if (config.priceColumn) p.append('price_column', config.priceColumn);
  if (config.amountColumn) p.append('amount_column', config.amountColumn);
  if (config.feesColumn) p.append('fees_column', config.feesColumn);
  if (config.taxesColumn) p.append('taxes_column', config.taxesColumn);
  if (config.currencyColumn) p.append('currency_column', config.currencyColumn);
  if (config.fxRateColumn) p.append('fx_rate_column', config.fxRateColumn);
  if (config.noteColumn) p.append('note_column', config.noteColumn);
  return p;
}

/** Brokerage fan-out (ADR-095): mark the import and the sleeve account its rows land on. */
export interface BrokerageImportOptions {
  isBrokerage: boolean;
  accountId?: number;
}

function appendBrokerage(p: URLSearchParams, brokerage?: BrokerageImportOptions): URLSearchParams {
  if (brokerage?.isBrokerage) {
    p.append('is_brokerage', 'true');
    if (brokerage.accountId != null) p.append('account_id', String(brokerage.accountId));
  }
  return p;
}

export function importPortfolioCSVCustom(
  file: File,
  config: PortfolioCustomConfig,
  adapterName: string,
  brokerage?: BrokerageImportOptions,
): Promise<PortfolioImportResult> {
  return postMultipartImport('/api/portfolio/import/csv/custom', file, appendBrokerage(configToParams(config, adapterName), brokerage));
}

export function importPortfolioCSVWithProgress(
  file: File,
  config: PortfolioCustomConfig,
  adapterName: string,
  onProgress: (progress: ImportProgress) => void,
  brokerage?: BrokerageImportOptions,
): { abort: () => void; result: Promise<PortfolioImportResult> } {
  const controller = new AbortController();
  const formData = new FormData();
  formData.append('file', file);
  const url = `${API_BASE_URL}/api/portfolio/import/csv/stream?${appendBrokerage(configToParams(config, adapterName), brokerage).toString()}`;

  const extractErrorDetail = (payload: unknown): string => {
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
    return 'Import failed';
  };

  const result = (async (): Promise<PortfolioImportResult> => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: { 'X-Request-Id': generateRequestId() },
        signal: controller.signal,
      });
      if (!response.ok) throw await parseEnvelopeError(response, 'Import failed');

      let finalResult: PortfolioImportResult | null = null;
      for await (const { event, data } of readSseStream<unknown>(response, { schemas: PORTFOLIO_STREAM_SCHEMAS })) {
        if (event === 'progress') {
          onProgress(data as ImportProgress);
          continue;
        }
        if (event === 'complete') {
          finalResult = data as PortfolioImportResult;
          onProgress({ ...(data as Partial<ImportProgress>), phase: 'complete', percent: 100 } as ImportProgress);
          continue;
        }
        if (event === 'review_required') {
          const d = data as { batch_id: number; match_source_counts?: unknown };
          finalResult = { batch_id: d.batch_id, imported: 0, duplicates: 0, errors: 0, status: 'review_required', requires_review: true };
          onProgress({ phase: 'review_required', current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 70 } as ImportProgress);
          continue;
        }
        if (event === 'error') throw new Error(extractErrorDetail(data));
      }
      return finalResult ?? { batch_id: 0, imported: 0, duplicates: 0, errors: 0, status: 'completed' };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new ImportCancelledError({ cause: err });
      throw err;
    }
  })();

  return { abort: () => controller.abort(), result };
}

// --- Saved portfolio parsers ---
/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function listPortfolioParserConfigs(): Promise<SavedPortfolioParserConfig[]> {
  const { items } = await apiRequest<{ items: SavedPortfolioParserConfig[]; total: number }>('/api/portfolio/import/parsers');
  return items;
}

export function createPortfolioParserConfig(name: string, config: PortfolioCustomConfig): Promise<SavedPortfolioParserConfig> {
  return apiRequest<SavedPortfolioParserConfig>('/api/portfolio/import/parsers', {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  });
}

export function updatePortfolioParserConfig(
  id: number,
  patch: { name?: string; config?: PortfolioCustomConfig },
): Promise<SavedPortfolioParserConfig> {
  return apiRequest<SavedPortfolioParserConfig>(`/api/portfolio/import/parsers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deletePortfolioParserConfig(id: number): Promise<void> {
  return apiRequest<void>(`/api/portfolio/import/parsers/${id}`, { method: 'DELETE' });
}

// --- Batches + review ---
export function getPortfolioImportPreview(batchId: number): Promise<PortfolioPreviewResponse> {
  return apiRequest<PortfolioPreviewResponse>(`/api/portfolio/import/batches/${batchId}/preview`);
}

export function overridePortfolioImportRow(
  batchId: number,
  rowId: number,
  payload: { investmentId?: number | null; createNew?: boolean },
): Promise<{ row_id: number; investment_id?: number; created?: boolean; user_override_investment_id?: number | null }> {
  const body = payload.createNew
    ? { create_new: true }
    : { investment_id: payload.investmentId ?? null };
  return apiRequest(`/api/portfolio/import/batches/${batchId}/rows/${rowId}/investment-override`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function overridePortfolioImportRows(
  batchId: number,
  rowIds: number[],
  payload: { investmentId?: number; createNew?: boolean },
): Promise<{
  investment_id: number;
  created: boolean;
  resolved: number;
  investment?: unknown;
}> {
  const body = payload.createNew
    ? { row_ids: rowIds, create_new: true }
    : { row_ids: rowIds, investment_id: payload.investmentId };
  return apiRequest(`/api/portfolio/import/batches/${batchId}/rows/investment-override`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function commitPortfolioImportBatch(
  batchId: number,
  accountId?: number | null,
): Promise<{ batch_id: number; imported: number; duplicates: number; errors: number }> {
  return apiRequest(`/api/portfolio/import/batches/${batchId}/commit`, {
    method: 'POST',
    body: JSON.stringify(accountId != null ? { account_id: accountId } : {}),
  });
}

export function rollbackPortfolioImportBatch(id: number): Promise<{ deleted: number }> {
  return apiRequest<{ deleted: number }>(`/api/portfolio/import/batches/${id}`, { method: 'DELETE' });
}
