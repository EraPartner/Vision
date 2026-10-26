import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/repositories/settingsRepository.ts', () => ({ default: {
  getRecord: vi.fn(), replace: vi.fn(), replaceMany: vi.fn(), deleteExpected: vi.fn(),
} }));
import rawRepo from '../src/repositories/settingsRepository.ts';
import router from '../src/routes/settings.ts';
import { must } from "./helpers/must.ts";

/** The spy behind `obj[key]`, read without taking an unbound method reference. */
function methodMock<T extends object, K extends keyof T>(obj: T, key: K) {
  return vi.mocked(obj)[key];
}

const repo = vi.mocked(rawRepo);
/** A route's terminal handler, invoked directly with hand-built req/res stubs. */
type DirectHandler = (req: unknown, res: unknown) => Promise<unknown>;
/** Express keeps the per-verb flags on the route; its typings omit them. */
type RouteWithMethods = { methods: Record<string, boolean> };
const handler = (path: string, method: string) => must(must(must(router.stack.find((layer) => layer.route?.path === path && (layer.route as unknown as RouteWithMethods).methods[method]), "matching router.stack").route, "matching entry").stack.at(-1), "matching entry").handle as unknown as DirectHandler;
beforeEach(() => vi.clearAllMocks());
describe('settings mutation baseline contract without HTTP listeners', () => {
  it.each([undefined, null, {}, { exists: 'yes' }, { exists: true }, { exists: false, value: null }, { exists: false, extra: true }])('rejects invalid baseline %j before writing', async (expected) => {
    await expect(handler('/:key', 'put')({ params: { key: 'app_settings' }, body: { value: {}, expected } }, { ok: vi.fn() })).rejects.toMatchObject({ status: 400 });
    expect(methodMock(repo, "replace")).not.toHaveBeenCalled();
  });
  it('rejects a missing request body as validation failure', async () => {
    await expect(handler('/:key', 'put')({ params: { key: 'app_settings' } }, {})).rejects.toMatchObject({ status: 400 });
    expect(methodMock(repo, "replace")).not.toHaveBeenCalled();
  });
  it('uses the supplied baseline, including JSON null, without reading newer state', async () => {
    repo.replace.mockResolvedValue({ key: 'app_settings', value: {}, expected: { exists: true, value: {} } });
    await handler('/:key', 'put')({ params: { key: 'app_settings' }, body: { value: {}, expected: { exists: true, value: null } } }, { ok: vi.fn() });
    expect(methodMock(repo, "replace")).toHaveBeenCalledWith('app_settings', {}, { exists: true, value: null });
    expect(methodMock(repo, "getRecord")).not.toHaveBeenCalled();
  });
  it('requires each bulk baseline before calling the transactional writer', async () => {
    await expect(handler('/', 'put')({ body: { settings: { app_settings: {}, theme_settings: {} }, expected: { app_settings: { exists: false } } } }, { ok: vi.fn() })).rejects.toMatchObject({ status: 400 });
    expect(methodMock(repo, "replaceMany")).not.toHaveBeenCalled();
  });
  it('keeps known defaults separate from persisted absence', async () => {
    repo.getRecord.mockResolvedValue({ expected: { exists: false } });
    const res = { ok: vi.fn() };
    await handler('/:key', 'get')({ params: { key: 'widget_visibility' } }, res);
    expect(res.ok).toHaveBeenCalledWith({ key: 'widget_visibility', value: {}, expected: { exists: false } });
  });
  it('requires a deletion baseline', async () => {
    await expect(handler('/:key', 'delete')({ params: { key: 'app_settings' }, body: {} }, {})).rejects.toMatchObject({ status: 400 });
    expect(methodMock(repo, "deleteExpected")).not.toHaveBeenCalled();
  });
});
