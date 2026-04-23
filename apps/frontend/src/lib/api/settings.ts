import { apiRequest } from '@/lib/api/client';

export function getSettings(): Promise<Record<string, unknown>> {
    return apiRequest('/api/settings');
}

export function getSetting(key: string): Promise<{ key: string; value: unknown }> {
    return apiRequest(`/api/settings/${encodeURIComponent(key)}`);
}

export function saveSetting(key: string, value: unknown): Promise<{ key: string; value: unknown }> {
    return apiRequest(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });
}

export function saveSettingsBulk(settings: Record<string, unknown>): Promise<{ saved: number }> {
    return apiRequest('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
    });
}
