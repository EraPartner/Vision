/**
 * Rolling-window cash-flow forecast — contract tests.
 * Verifies shape (actual + future date counts), planned-overlay isolation,
 * cumulative anchor (window-relative), and same-day determinism for MC bands.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const buildHistory = ({ days = 400 } = {}) => {
  const out = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i++) {
    const ms = start + i * 86_400_000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    const dow = new Date(ms).getUTCDay();
    out.push({ date: iso, net: 5 * Math.sin((2 * Math.PI * i) / 7) + (dow === 0 ? -3 : 1) });
  }
  return out;
};

// App-timezone today (ADR-009) — must match rollingWindowDates' anchor, which
// is deliberately NOT the UTC calendar day (they differ between local
// midnight and 01:00/02:00 Brussels).
import { todayAppDateString, addDaysYmd } from '../../src/lib/timezone.js';
const todayIso = () => todayAppDateString();
const isoOffsetFromToday = (offsetDays) => addDaysYmd(todayAppDateString(), offsetDays);

vi.mock('../../src/repositories/infoRepository.js', () => ({
  infoRepository: {
    // ADR-083 cache-key input (forecast/index.js filterHash).
    getIncludeTransfers: vi.fn(async () => false),
    getCashflowForecastDataRolling: vi.fn(async (historyMonths, daysBack, daysForward) => ({
      history: buildHistory({ days: 400 }),
      currentActual: Array.from({ length: daysBack + 1 }, (_, i) => ({
        date: isoOffsetFromToday(-daysBack + i),
        net: i % 7 === 0 ? -50 : 10,
      })),
      plannedCurrent: [
        { date: isoOffsetFromToday(5), net: -200 },
        { date: isoOffsetFromToday(daysForward + 50), net: -999 }, // outside window — repo would already exclude in real query, but we leave it to verify the engine is not asked to plot it
      ],
      historyMonths,
    })),
    getCashflowForecastData: vi.fn(),
    getCashflowForecastDataByCategory: vi.fn(),
  },
}));

describe('computeCashflowForecastRolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns shape with actual length === daysBack + 1 and forecast length === daysForward', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const env = await computeCashflowForecastRolling({
      daysBack: 30,
      daysForward: 30,
      mcPaths: 50,
      userId: 'u1',
    });

    expect(env.data.actual).toHaveLength(61);
    expect(env.data.actual[0].date).toBe(isoOffsetFromToday(-30));
    expect(env.data.actual[30].date).toBe(todayIso());
    expect(env.data.actual[60].date).toBe(isoOffsetFromToday(30));
    expect(env.data.actual.slice(0, 31).every((r) => r.net !== null)).toBe(true);
    expect(env.data.actual.slice(31).every((r) => r.net === null)).toBe(true);
    expect(env.data.methods).toHaveLength(8);
    for (const m of env.data.methods) {
      expect(m.daily).toHaveLength(30);
      expect(m.cumulative).toHaveLength(61);
    }
    expect(env.data.window_start).toBe(isoOffsetFromToday(-30));
    expect(env.data.window_end).toBe(isoOffsetFromToday(30));
    expect(env.data.today).toBe(todayIso());
    expect(env.data.diagnostics).toBeNull();
  });

  it('cumulative anchor is window-relative (starts at the first actual net)', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const env = await computeCashflowForecastRolling({
      daysBack: 7,
      daysForward: 7,
      mcPaths: 20,
      userId: 'u1',
    });
    const first = env.data.actual[0];
    expect(first.cumulative).toBe(first.net);
  });

  it('actual entries past today have null net + cumulative', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const env = await computeCashflowForecastRolling({
      daysBack: 5,
      daysForward: 5,
      mcPaths: 20,
      userId: 'u1',
    });
    expect(env.data.actual.every((r, i) => (i <= 5 ? r.net !== null : r.net === null))).toBe(true);
  });

  it('same-day same-params calls return identical MC bands (determinism)', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const a = await computeCashflowForecastRolling({
      daysBack: 14,
      daysForward: 14,
      mcPaths: 40,
      userId: 'u1',
    });
    const b = await computeCashflowForecastRolling({
      daysBack: 14,
      daysForward: 14,
      mcPaths: 40,
      userId: 'u1',
    });
    const aMc = a.data.methods.find((m) => m.id === 'monte_carlo_parametric');
    const bMc = b.data.methods.find((m) => m.id === 'monte_carlo_parametric');
    expect(aMc.bands).toEqual(bMc.bands);
  });

  it('different daysBack/daysForward changes seed → different MC bands', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const a = await computeCashflowForecastRolling({
      daysBack: 14,
      daysForward: 14,
      mcPaths: 40,
      userId: 'u1',
    });
    const b = await computeCashflowForecastRolling({
      daysBack: 14,
      daysForward: 21,
      mcPaths: 40,
      userId: 'u1',
    });
    const aMc = a.data.methods.find((m) => m.id === 'monte_carlo_parametric');
    const bMc = b.data.methods.find((m) => m.id === 'monte_carlo_parametric');
    // p25 series will differ in length and values
    expect(aMc.bands.p25.length).not.toBe(bMc.bands.p25.length);
  });

  it('include_planned=false leaves cumulative untouched by future planned', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const without = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      includePlanned: false,
      mcPaths: 20,
      userId: 'u1',
    });
    const withp = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      includePlanned: true,
      mcPaths: 20,
      userId: 'u1',
    });
    const withoutMethod = without.data.methods.find((m) => m.id === 'simple_avg');
    const withMethod = withp.data.methods.find((m) => m.id === 'simple_avg');
    const lastWithout = withoutMethod.cumulative[withoutMethod.cumulative.length - 1].value;
    const lastWith = withMethod.cumulative[withMethod.cumulative.length - 1].value;
    // Mock plants a -200 planned at offset 5 inside the 10-day forecast window.
    expect(Math.round(lastWith - lastWithout)).toBe(-200);
  });
});
