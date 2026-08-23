// @vitest-environment jsdom
import { useState } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PriceProviderFields, type PriceProviderFormShape } from '../PriceProviderFields';
import { renderWithApp } from '@/test/renderWithApp';
import { server } from '@/test/msw/server';

const API_BASE = 'http://localhost:3002';

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data });
}

function ProviderFieldsHarness() {
  const [form, setForm] = useState<PriceProviderFormShape>({
    priceProvider: 'manual',
    priceProviderId: '',
    currentPrice: '',
    priceProviderLatestUrl: '',
    priceProviderLatestPath: '',
    priceProviderHistoryUrl: '',
    priceProviderHistoryPath: 'points',
    priceProviderHistoryTsPath: 'timestamp_ms',
    priceProviderHistoryPricePath: 'price',
  });

  return (
    <PriceProviderFields
      idPrefix="test-provider"
      form={form}
      setForm={setForm}
      showManualPrice
      t={(key) => key === 'addInv.provider.manual' ? 'Manual translated' : key}
    />
  );
}

afterEach(() => server.resetHandlers());

describe('PriceProviderFields catalog', () => {
  it('renders backend catalog membership and order, including a future provider key', async () => {
    server.use(
      http.get(`${API_BASE}/api/investments/providers`, () =>
        ok({
          providers: [
            { key: 'manual', name: 'Manual', description: 'Set price manually' },
            { key: 'server_only', name: 'Server Feed', description: 'Backend supplied hint' },
            { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks and ETFs' },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    const { queryClient } = renderWithApp(<ProviderFieldsHarness />);

    await waitFor(() => {
      expect(queryClient.getQueryData(['investment-providers'])).toHaveLength(3);
    });
    await user.click(screen.getByRole('combobox'));

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Manual translated'),
      expect.stringContaining('Server Feed'),
      expect.stringContaining('Yahoo Finance'),
    ]);
    expect(screen.getByRole('option', { name: /Server Feed.*Backend supplied hint/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Yahoo Finance.*addInv.provider.hint.yahoo/i })).toBeInTheDocument();
  });

  it('keeps the fallback catalog usable when the catalog request fails', async () => {
    server.use(
      http.get(`${API_BASE}/api/investments/providers`, () =>
        HttpResponse.json(
          { ok: false, error: { code: 'INTERNAL_ERROR', message: 'catalog unavailable' } },
          { status: 500 },
        ),
      ),
    );
    const { queryClient } = renderWithApp(<ProviderFieldsHarness />);

    await waitFor(() => {
      expect(queryClient.getQueryState(['investment-providers'])?.status).toBe('error');
    });
    expect(screen.getByRole('combobox')).toHaveTextContent('Manual translated');
    expect(screen.getByLabelText('addInv.label.currentPrice')).toBeInTheDocument();
  });
});
