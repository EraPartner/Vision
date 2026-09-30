import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/repositories/settingsRepository.js', () => ({ default: {
  getRecord: vi.fn(), replace: vi.fn(), replaceMany: vi.fn(), deleteExpected: vi.fn(),
} }));
import repo from '../src/repositories/settingsRepository.js';
import router from '../src/routes/settings.js';
const handler = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
beforeEach(() => vi.clearAllMocks());
describe('settings mutation baseline contract without HTTP listeners', () => {
  it.each([undefined, null, {}, { exists: 'yes' }, { exists: true }, { exists: false, value: null }, { exists: false, extra: true }])('rejects invalid baseline %j before writing', async (expected) => {
    await expect(handler('/:key', 'put')({ params: { key: 'app_settings' }, body: { value: {}, expected } }, { ok: vi.fn() })).rejects.toMatchObject({ status: 400 });
    expect(repo.replace).not.toHaveBeenCalled();
  });
  it('rejects a missing request body as validation failure', async () => {
    await expect(handler('/:key', 'put')({ params: { key: 'app_settings' } }, {})).rejects.toMatchObject({ status: 400 });
    expect(repo.replace).not.toHaveBeenCalled();
  });
  it('uses the supplied baseline, including JSON null, without reading newer state', async () => {
    repo.replace.mockResolvedValue({ key: 'app_settings', value: {}, expected: { exists: true, value: {} } });
    await handler('/:key', 'put')({ params: { key: 'app_settings' }, body: { value: {}, expected: { exists: true, value: null } } }, { ok: vi.fn() });
    expect(repo.replace).toHaveBeenCalledWith('app_settings', {}, { exists: true, value: null });
    expect(repo.getRecord).not.toHaveBeenCalled();
  });
  it('requires each bulk baseline before calling the transactional writer', async () => {
    await expect(handler('/', 'put')({ body: { settings: { app_settings: {}, theme_settings: {} }, expected: { app_settings: { exists: false } } } }, { ok: vi.fn() })).rejects.toMatchObject({ status: 400 });
    expect(repo.replaceMany).not.toHaveBeenCalled();
  });
  it('keeps known defaults separate from persisted absence', async () => {
    repo.getRecord.mockResolvedValue({ expected: { exists: false } });
    const res = { ok: vi.fn() };
    await handler('/:key', 'get')({ params: { key: 'widget_visibility' } }, res);
    expect(res.ok).toHaveBeenCalledWith({ key: 'widget_visibility', value: {}, expected: { exists: false } });
  });
  it('requires a deletion baseline', async () => {
    await expect(handler('/:key', 'delete')({ params: { key: 'app_settings' }, body: {} }, {})).rejects.toMatchObject({ status: 400 });
    expect(repo.deleteExpected).not.toHaveBeenCalled();
  });
});
