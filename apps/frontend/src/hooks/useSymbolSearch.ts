import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebounce, SEARCH_DEBOUNCE_MS } from '@/hooks/useDebounce';

export interface UseSymbolSearchOptions {
    /**
     * React Query cache scope for this search source (e.g. 'research-search',
     * 'market-search'); the full key is `[queryKey, debouncedSearch]`. Call
     * sites searching the same source share this key so they share the cache.
     */
    queryKey: string;
    /** Debounce delay (ms) before typed text becomes the query. */
    debounceMs?: number;
    /** Minimum debounced-query length before the search fires. */
    minLength?: number;
    /** How long (ms) cached results stay fresh. */
    staleTime?: number;
    /**
     * Trim the typed text before debouncing/querying (so whitespace-only input
     * never searches). Market lookup opts out to keep its historical raw-text
     * queries — and its cache keys — byte-identical with AddToWatchlistDialog's.
     */
    trim?: boolean;
}

/**
 * Debounced symbol-search wiring shared by every research symbol picker
 * (Research home, Market Lookup, Compare, Chart Builder): local input state,
 * debounced query text, the cached search query against the page's own
 * `searchFn`, and the base "results dropdown may open" condition. The visual
 * chrome lives in `SymbolSearchBox`; pages render their own result rows and
 * AND `isOpen` with a has-results check where the dropdown should stay closed
 * on empty results.
 */
export function useSymbolSearch<TResult>(
    searchFn: (query: string) => Promise<TResult>,
    options: UseSymbolSearchOptions,
) {
    const {
        queryKey,
        debounceMs = SEARCH_DEBOUNCE_MS,
        minLength = 1,
        staleTime = 60_000,
        trim = true,
    } = options;

    const [searchText, setSearchText] = useState('');
    const debouncedSearch = useDebounce(trim ? searchText.trim() : searchText, debounceMs);

    const { data: searchResult, isFetching } = useQuery({
        queryKey: [queryKey, debouncedSearch],
        queryFn: () => searchFn(debouncedSearch),
        enabled: debouncedSearch.length >= minLength,
        staleTime,
    });

    /** Base dropdown condition: a long-enough debounced query and a non-cleared input. */
    const isOpen = debouncedSearch.length >= minLength && searchText.length > 0;

    return { searchText, setSearchText, debouncedSearch, searchResult, isFetching, isOpen };
}
