// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/contexts/LanguageContext', () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));

import { SettingsSaveErrorToaster } from '@/contexts/AppSettingsContext';
import { useSettingsStore } from '@/stores/settingsStore';

describe('SettingsSaveErrorToaster', () => {
    beforeEach(() => {
        toastError.mockClear();
        useSettingsStore.setState({ settingsSaveErrorNonce: 0 });
    });

    it('shows the localized settings error when the shared nonce advances', async () => {
        render(<SettingsSaveErrorToaster />);

        act(() => useSettingsStore.getState()._markSettingsSaveError());

        await waitFor(() => {
            expect(toastError).toHaveBeenCalledWith('settings.saveFailed');
        });
    });
});
