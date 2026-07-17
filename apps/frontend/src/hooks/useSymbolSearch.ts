import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useDebounce, SEARCH_DEBOUNCE_MS } from '@/hooks/useDebounce';

/**
 * Debounced research symbol search shared by the research pages: local input
 * state, trimmed + debounced query text, and the cached "research-search"
 * query (enabled from the first character).
 */
export function useSymbolSearch() {
    const [searchText, setSearchText] = useState('');
    const debouncedSearch = useDebounce(searchText.trim(), SEARCH_DEBOUNCE_MS);

    const { data: searchResult, isFetching } = useQuery({
        queryKey: ['research-search', debouncedSearch],
        queryFn: () => apiClient.searchResearch(debouncedSearch),
        enabled: debouncedSearch.length >= 1,
        staleTime: 60_000,
    });

    return { searchText, setSearchText, debouncedSearch, searchResult, isFetching };
}
