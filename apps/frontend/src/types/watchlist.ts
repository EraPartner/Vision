export interface WatchlistItem {
  id: number;
  name: string;
  symbol: string | null;
  asset_class: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price: number;
  currency: string;
  notes: string | null;
  price_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WatchlistCreate {
  name: string;
  symbol?: string;
  asset_class: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price: number;
  currency?: string;
  notes?: string;
  price_provider_id?: string;
}

export interface WatchlistUpdate {
  name?: string;
  symbol?: string;
  asset_class?: 'stock' | 'etf' | 'crypto' | 'metals';
  target_price?: number;
  currency?: string;
  notes?: string;
  price_provider_id?: string;
}

export interface WatchlistListResponse {
  items: WatchlistItem[];
  total: number;
  limit: number;
  offset: number;
}
