import { apiRequest } from '@/lib/api/client';
import type { SavedChart, SavedChartCreate } from "@/types/apiClient";
import { SavedChartListSchema, SavedChartSchema } from "@vision/types/contracts";

export type { SavedChart, SavedChartCreate };

// The schema keeps chart_type/chart_variant/time_bucket as strings: the columns
// have no CHECK constraint, so a stored legacy value must still load. The route
// validates writes, so the explicit SavedChart type narrows them.

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getSavedCharts(): Promise<SavedChart[]> {
    const { items } = await apiRequest<{ items: SavedChart[] }>('/api/saved-charts', {
        schema: SavedChartListSchema,
    });
    return items;
}

export function createSavedChart(payload: SavedChartCreate): Promise<SavedChart> {
    return apiRequest<SavedChart>('/api/saved-charts', {
        method: 'POST',
        body: JSON.stringify(payload),
        schema: SavedChartSchema,
    });
}

export function updateSavedChart(id: number, payload: Partial<SavedChartCreate>): Promise<SavedChart> {
    return apiRequest<SavedChart>(`/api/saved-charts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        schema: SavedChartSchema,
    });
}

export async function deleteSavedChart(id: number): Promise<void> {
    await apiRequest(`/api/saved-charts/${id}`, { method: 'DELETE' });
}
