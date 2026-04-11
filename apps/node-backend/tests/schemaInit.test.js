import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSchemaInitModule() {
  vi.resetModules();

  const query = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const createMaterializedViews = vi.fn();
  const ensureMaterializedViewIndexes = vi.fn();
  const refreshMaterializedViews = vi.fn();

  vi.doMock('../src/database/connection.js', () => ({ query }));
  vi.doMock('../src/config/logger.js', () => ({ logger }));
  vi.doMock('../src/services/materializedViewService.js', () => ({
    createMaterializedViews,
    ensureMaterializedViewIndexes,
    refreshMaterializedViews,
  }));

  const module = await import('../src/database/schemaInit.js');
  return {
    module,
    query,
    logger,
    createMaterializedViews,
    ensureMaterializedViewIndexes,
    refreshMaterializedViews,
  };
}

describe('schemaInit.initializeSchema', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('skips DDL and materialized view helpers on warm start with current schema version', async () => {
    const {
      module,
      query,
      logger,
      createMaterializedViews,
      ensureMaterializedViewIndexes,
      refreshMaterializedViews,
    } = await loadSchemaInitModule();

    query.mockResolvedValueOnce({ rows: [{ version: '20260327_2' }] });

    await module.initializeSchema();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1');
    expect(createMaterializedViews).not.toHaveBeenCalled();
    expect(ensureMaterializedViewIndexes).not.toHaveBeenCalled();
    expect(refreshMaterializedViews).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('skipping DDL'));
  });

  it('proceeds with full initialization when schema_version lookup fails and stamps current version', async () => {
    const {
      module,
      query,
      createMaterializedViews,
      ensureMaterializedViewIndexes,
      refreshMaterializedViews,
    } = await loadSchemaInitModule();

    query.mockRejectedValueOnce(new Error('relation "schema_version" does not exist'));
    query.mockResolvedValue({ rows: [] });

    await module.initializeSchema();

    expect(createMaterializedViews).toHaveBeenCalledTimes(1);
    expect(ensureMaterializedViewIndexes).toHaveBeenCalledTimes(1);
    expect(refreshMaterializedViews).toHaveBeenCalledTimes(1);

    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_version (version) VALUES ($1)',
      ['20260327_2']
    );
  });
});
