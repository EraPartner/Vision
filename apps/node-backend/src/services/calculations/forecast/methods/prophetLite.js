/**
 * Prophet-lite: GAM-style regression with piecewise-linear trend,
 * Fourier weekly (K=3) + yearly (K=10) seasonality, and Belgian holiday
 * dummies. Fit by ridge-regularized OLS via normal equations. Captures ~80%
 * of real Prophet's value without Stan/PyMC.
 *
 * y_t = β0 + β_trend·t + Σ β_cp·(t − cp)+ + Σ Fourier(weekly, K=3)
 *       + Σ Fourier(yearly, K=10) + β_hol·holiday + ε
 *
 * Point estimates only (no Bayesian posterior). If backtest shows
 * material accuracy gap vs Holt-Winters, upgrade to Python sidecar.
 */

import { isBelgianHoliday } from '../holidays/be.js';

export const id = 'prophet_lite';
export const label = 'Prophet-lite';

const WEEKLY_K = 3;
const YEARLY_K = 10;
const RIDGE_LAMBDA = 1.0;
const CHANGEPOINT_FRACTION = 0.8;
const NUM_CHANGEPOINTS = 10;

function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysSinceEpoch(iso) {
  return parseIso(iso) / 86_400_000;
}

function dayOfYear(iso) {
  const ms = parseIso(iso);
  const [y] = iso.split('-').map(Number);
  const startMs = Date.UTC(y, 0, 1);
  return (ms - startMs) / 86_400_000;
}

function featureRow(t, dayIso, changepoints) {
  const row = [1, t];
  for (const cp of changepoints) {
    row.push(Math.max(0, t - cp));
  }
  const weekPhase = (2 * Math.PI * t) / 7;
  for (let k = 1; k <= WEEKLY_K; k++) {
    row.push(Math.sin(k * weekPhase));
    row.push(Math.cos(k * weekPhase));
  }
  const yearPhase = (2 * Math.PI * dayOfYear(dayIso)) / 365.25;
  for (let k = 1; k <= YEARLY_K; k++) {
    row.push(Math.sin(k * yearPhase));
    row.push(Math.cos(k * yearPhase));
  }
  row.push(isBelgianHoliday(dayIso) ? 1 : 0);
  return row;
}

function solveRidge(X, y, lambda) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      const xia = X[i][a];
      Xty[a] += xia * y[i];
      for (let b = a; b < p; b++) {
        XtX[a][b] += xia * X[i][b];
      }
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = a + 1; b < p; b++) XtX[b][a] = XtX[a][b];
    if (a > 0) XtX[a][a] += lambda;
  }
  return gaussianElimination(XtX, Xty);
}

function gaussianElimination(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k;
    }
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]];
    const piv = M[i][i];
    if (Math.abs(piv) < 1e-12) continue;
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / piv;
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : s / M[i][i];
  }
  return x;
}

function denseDaily(history) {
  if (history.length === 0) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const start = parseIso(sorted[0].date);
  const end = parseIso(sorted[sorted.length - 1].date);
  const map = new Map();
  for (const r of sorted) map.set(r.date, (map.get(r.date) ?? 0) + r.net);
  const out = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const iso = toIso(t);
    out.push({ date: iso, net: map.get(iso) ?? 0 });
  }
  return out;
}

export function forecast({ history, forecastDates }) {
  const dense = denseDaily(history);
  if (dense.length < 60 || forecastDates.length === 0) {
    return forecastDates.map((date) => ({ date, value: 0 }));
  }

  const t0 = daysSinceEpoch(dense[0].date);
  const ts = dense.map((r) => daysSinceEpoch(r.date) - t0);
  const tMax = ts[ts.length - 1];
  const changepoints = [];
  const cpEnd = tMax * CHANGEPOINT_FRACTION;
  for (let k = 1; k <= NUM_CHANGEPOINTS; k++) {
    changepoints.push((cpEnd * k) / (NUM_CHANGEPOINTS + 1));
  }

  const X = dense.map((r, i) => featureRow(ts[i], r.date, changepoints));
  const y = dense.map((r) => r.net);
  const beta = solveRidge(X, y, RIDGE_LAMBDA);

  return forecastDates.map((date) => {
    const t = daysSinceEpoch(date) - t0;
    const row = featureRow(t, date, changepoints);
    let value = 0;
    for (let j = 0; j < row.length; j++) value += row[j] * beta[j];
    return { date, value };
  });
}

export default { id, label, forecast };
