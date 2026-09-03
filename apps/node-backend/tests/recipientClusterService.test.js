import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockConnection } from './helpers/repoMocks.js';

vi.mock('../src/database/connection.js', () => mockConnection());

import { query } from '../src/database/connection.js';
import { findRecipientClusters } from '../src/services/recipientClusterService.js';

describe('recipientClusterService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads a bounded recipient scan and builds only meaningful clusters', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: 1, name: 'ALBERT HEIJN 123', default_category_id: 4 },
        { id: 2, name: 'ALBERT HEIJN 456', default_category_id: 4 },
        { id: 3, name: 'PAYMENT A', default_category_id: null },
        { id: 4, name: 'PAYMENT B', default_category_id: null },
      ],
    });

    await expect(findRecipientClusters({ minCount: 2 })).resolves.toEqual([
      {
        lcp: 'ALBERT HEIJN',
        confidence: 'medium',
        recipientIds: [1, 2],
        recipientNames: ['ALBERT HEIJN 123', 'ALBERT HEIJN 456'],
        categoryId: 4,
        suggestedPattern: 'ALBERT HEIJN',
        suggestedKind: 'literal_prefix',
      },
    ]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ORDER BY name, id');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([10_000]);
  });

  it('caps the result at 50 clusters in deterministic recipient order', async () => {
    query.mockResolvedValueOnce({
      rows: Array.from({ length: 51 }, (_, clusterIndex) => {
        const prefix = String(clusterIndex).padStart(4, '0');
        return [
          { id: clusterIndex * 2 + 1, name: `${prefix} LONG MERCHANT A`, default_category_id: null },
          { id: clusterIndex * 2 + 2, name: `${prefix} LONG MERCHANT B`, default_category_id: null },
        ];
      }).flat(),
    });

    const clusters = await findRecipientClusters();

    expect(clusters).toHaveLength(50);
    expect(clusters[0].recipientIds).toEqual([1, 2]);
    expect(clusters.at(-1).recipientIds).toEqual([99, 100]);
  });
});
