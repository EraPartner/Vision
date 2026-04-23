import { apiRequest } from '@/lib/api/client';
import type { SavedChart, SavedChartCreate } from '@/lib/api/types';

export type { SavedChart, SavedChartCreate };

export function getSavedCharts(): Promise<SavedChart[]> {
    return apiRequest('/api/saved-charts');
}

export function createSavedChart(payload: SavedChartCreate): Promise<SavedChart> {
    return apiRequest('/api/saved-charts', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateSavedChart(id: number, payload: Partial<SavedChartCreate>): Promise<SavedChart> {
    return apiRequest(`/api/saved-charts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function deleteSavedChart(id: number): Promise<void> {
    await apiRequest(`/api/saved-charts/${id}`, { method: 'DELETE' });
}
