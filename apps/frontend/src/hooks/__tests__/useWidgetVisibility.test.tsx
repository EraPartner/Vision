// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ apiClient: apiMocks }));
vi.mock('@/lib/logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useWidgetVisibility } from '@/hooks/useWidgetVisibility';
import { useSettingsStore } from '@/stores/settingsStore';

describe('useWidgetVisibility persistence feedback', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        apiMocks.getSetting.mockResolvedValue({ value: {} });
        apiMocks.saveSetting.mockResolvedValue(undefined);
        useSettingsStore.setState({ settingsSaveErrorNonce: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('signals rejected saves without rolling back local visibility', async () => {
        const { result } = renderHook(() =>
            useWidgetVisibility('dashboard-save-feedback', [
                { id: 'summary', defaultVisible: true },
            ]),
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
        });
        expect(result.current.isLoaded).toBe(true);

        act(() => result.current.setWidgetVisible('summary', false));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenCalledTimes(1);
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(0);

        apiMocks.saveSetting.mockRejectedValueOnce(new Error('save failed'));
        act(() => result.current.setWidgetVisible('summary', true));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(result.current.isVisible('summary')).toBe(true);
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1);

    });
});
