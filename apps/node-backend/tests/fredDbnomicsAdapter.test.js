/**
 * FRED + DBnomics macro adapter tests (ADR-082).
 * Mocks the JSON HTTP client and provider-key gating; asserts normalized
 * search/series output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetJson } = vi.hoisted(() => ({ mockGetJson: vi.fn() }));

vi.mock('../src/services/research/adapters/httpClient.js', async () => {
  // Keep the real num() coercion; only stub the network call.
  const actual = await vi.importActual('../src/services/research/adapters/httpClient.js');
  return { ...actual, getJson: mockGetJson };
});

const { mockProviderKey } = vi.hoisted(() => ({ mockProviderKey: vi.fn() }));
vi.mock('../src/services/research/providerKeys.js', async () => {
  const actual = await vi.importActual('../src/services/research/providerKeys.js');
  return { ...actual, providerKey: mockProviderKey };
});

import fredAdapter from '../src/services/research/adapters/fredAdapter.js';
import dbnomicsAdapter from '../src/services/research/adapters/dbnomicsAdapter.js';

describe('fredAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderKey.mockReturnValue('TEST_KEY');
  });

  it('throws when no FRED key is configured', async () => {
    mockProviderKey.mockReturnValue(undefined);
    await expect(fredAdapter.macroSearch('cpi')).rejects.toThrow('FRED_API_KEY not configured');
  });

  it('macroSearch normalizes series and filters entries without id', async () => {
    mockGetJson.mockResolvedValue({
      seriess: [
        { id: 'CPIAUCSL', title: 'CPI All Items', units_short: 'Index', frequency: 'Monthly' },
        { title: 'no id' },
      ],
    });
    const { items } = await fredAdapter.macroSearch('cpi');
    expect(items).toEqual([
      {
        provider: 'fred',
        seriesId: 'CPIAUCSL',
        title: 'CPI All Items',
        units: 'Index',
        frequency: 'Monthly',
        region: undefined,
        source: 'FRED',
      },
    ]);
    // URL-encodes the query
    expect(mockGetJson).toHaveBeenCalledWith(expect.stringContaining('search_text=cpi'));
  });

  it('macroSearch handles a missing seriess array', async () => {
    mockGetJson.mockResolvedValue({});
    const { items } = await fredAdapter.macroSearch('x');
    expect(items).toEqual([]);
  });

  it('macroSeries parses observations, drops missing "." values, and reads meta', async () => {
    mockGetJson.mockImplementation(async (url) => {
      if (url.includes('/series/observations')) {
        return {
          observations: [
            { date: '2024-01-01', value: '100.0' },
            { date: '2024-02-01', value: '.' }, // missing -> dropped
            { date: 'not-a-date', value: '5' }, // bad time -> dropped
            { date: '2024-03-01', value: '102.5' },
          ],
        };
      }
      return { seriess: [{ title: 'CPI', units_short: 'Idx', frequency: 'Monthly' }] };
    });
    const res = await fredAdapter.macroSeries('CPIAUCSL', { range: 'max' });
    expect(res.provider).toBe('fred');
    expect(res.title).toBe('CPI');
    expect(res.units).toBe('Idx');
    expect(res.points).toHaveLength(2);
    expect(res.points[0].close).toBe(100);
    expect(res.points[1].close).toBe(102.5);
  });

  it('macroSeries tolerates failed meta fetch and falls back to seriesId title', async () => {
    mockGetJson.mockImplementation(async (url) => {
      if (url.includes('/series/observations')) {
        return { observations: [{ date: '2024-01-01', value: '1' }] };
      }
      throw new Error('meta down');
    });
    const res = await fredAdapter.macroSeries('FOO');
    expect(res.title).toBe('FOO');
    expect(res.points).toHaveLength(1);
  });
});

describe('dbnomicsAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('macroSearch returns catalog matches (keyless)', async () => {
    const { items } = await dbnomicsAdapter.macroSearch('');
    expect(Array.isArray(items)).toBe(true);
  });

  it('macroSeries throws when the series doc is missing', async () => {
    mockGetJson.mockResolvedValue({ series: { docs: [] } });
    await expect(dbnomicsAdapter.macroSeries('ECB/X/Y')).rejects.toThrow('series not found');
  });

  it('macroSeries pairs period_start_day with values and drops NA / bad times', async () => {
    mockGetJson.mockResolvedValue({
      series: {
        docs: [
          {
            series_name: 'My Series',
            '@frequency': 'monthly',
            period_start_day: ['2024-03-01', '2024-01-01', null, '2024-02-01'],
            period: ['2024-03', '2024-01', '2024-Q2', '2024-02'],
            value: ['3', '1', 'NA', '2'],
          },
        ],
      },
    });
    const res = await dbnomicsAdapter.macroSeries('PROV/DS/SER', { range: 'max' });
    expect(res.provider).toBe('dbnomics');
    expect(res.points).toHaveLength(3); // NA dropped
    // sorted ascending by time
    const times = res.points.map((p) => p.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(res.points.map((p) => p.close)).toEqual([1, 2, 3]);
  });

  it('macroSeries falls back to period when period_start_day is absent', async () => {
    mockGetJson.mockResolvedValue({
      series: {
        docs: [
          {
            series_name: 'Q Series',
            value: ['10', '20'],
            period: ['2023-Q1', '2023-Q2'],
          },
        ],
      },
    });
    const res = await dbnomicsAdapter.macroSeries('PROV/DS/SER', { range: 'max' });
    expect(res.points).toHaveLength(2);
    expect(res.points[0].close).toBe(10);
  });
});
