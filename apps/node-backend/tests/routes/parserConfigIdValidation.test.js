/**
 * `:id` shape on the four saved-parser-config operations — PATCH and DELETE of
 * both `/api/import/parsers/:id` and `/api/portfolio/import/parsers/:id`.
 *
 * These were the only numeric-id routes in the app with no `validateIdParam`
 * at all, and `parseParserId` was a `parseInt` guarded only by `Number.isNaN`,
 * which takes the leading digits of anything. `DELETE /parsers/12abc` answered
 * **204 having deleted parser 12** — an irreversible write against a record the
 * caller never named, reported as success. `12.5` hit 12, `1e3` hit 1, and
 * `-1`/`0` cleared the NaN check and reached the repository as-is.
 *
 * All four handlers come from the one shared `registerParserRoutes` in
 * routes/parserConfigRoutes.js, so the matrix is driven against a router built the
 * way both real routers build theirs (same `kind`/`normalizeConfig`/`label`
 * parameterisation). The two real routers are pinned to *use* it in
 * import.test.js and portfolioImportValidationPins.test.js — this file owns the
 * shape, those own the wiring.
 *
 * Its own file rather than appended to import.test.js: that suite is mounted at
 * /api/import, whose per-mount limiter allows 20 requests a minute, and this
 * matrix alone is well past that if the limiter is ever mounted there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/customParserConfigRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';
const { registerParserRoutes } = await import('../../src/routes/parserConfigRoutes.js');

// Mirrors main.js's two mounts and each router's registerParserRoutes call.
const MOUNTS = [
  { label: 'transaction', mountPath: '/api/import', kind: 'transaction' },
  { label: 'portfolio', mountPath: '/api/portfolio/import', kind: 'portfolio' },
];

/** @param {string} kind */
function agentFor(kind, mountPath) {
  const router = Router();
  registerParserRoutes(router, { kind, normalizeConfig: (config) => /** @type {object} */ (config) });
  return routeAgent(router, { mountPath });
}

// Every form the old parseInt resolved to a DIFFERENT, perfectly real parser,
// plus the two it let through unchanged (0 and -1 reached the repository).
// An empty id is not here: `/parsers/` does not match `/parsers/:id` at all, so
// Express 404s it before any guard runs.
const MALFORMED = ['12abc', '12.5', '1e3', '0x10', '+7', ' 7 ', '7.0', '-1', '0', 'abc'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(MOUNTS)('$label parsers — :id shape', ({ mountPath, kind }) => {
  const base = `${mountPath}/parsers`;

  it('rejects every malformed id on DELETE without touching the repository', async () => {
    const api = agentFor(kind, mountPath);
    for (const id of MALFORMED) {
      const res = await api.delete(`${base}/${id}`);
      expect(res.status, `expected DELETE ${base}/${id} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(customParserConfigRepository.delete).not.toHaveBeenCalled();
  });

  it('rejects every malformed id on PATCH without touching the repository', async () => {
    const api = agentFor(kind, mountPath);
    for (const id of MALFORMED) {
      const res = await api.patch(`${base}/${id}`).send({ name: 'should not apply' });
      expect(res.status, `expected PATCH ${base}/${id} to be rejected`).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    }
    expect(customParserConfigRepository.update).not.toHaveBeenCalled();
  });

  it('still deletes and updates on a real id, including one with leading zeros', async () => {
    const api = agentFor(kind, mountPath);
    customParserConfigRepository.delete.mockResolvedValue(true);
    customParserConfigRepository.update.mockResolvedValue({ id: 12, name: 'Renamed' });

    await api.delete(`${base}/12`).expect(204);
    await api.delete(`${base}/0012`).expect(204);
    await api.patch(`${base}/12`).send({ name: 'Renamed' }).expect(200);

    expect(customParserConfigRepository.delete.mock.calls).toEqual([[12], [12]]);
    expect(customParserConfigRepository.update).toHaveBeenCalledWith(12, { name: 'Renamed', config: undefined });
  });

  it('still 404s on a well-formed id that matches no row', async () => {
    const api = agentFor(kind, mountPath);
    customParserConfigRepository.delete.mockResolvedValue(false);

    const res = await api.delete(`${base}/999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
  });
});
